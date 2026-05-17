// SPDX-License-Identifier: Apache-2.0 OR MIT

//! HTTP Agent wrapping `reqwest::Client` with lifecycle management.

use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures::StreamExt;
use reqwest::Client;
use tokio::select;
use tokio::sync::Notify;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

/// Pinned, send-only future returned by [`Agent::dispatch`].
pub type DispatchFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// Pair returned by [`Agent::dispatch`]: the controller (for abort/pause/resume)
/// and the future that drives the request to completion.
pub type DispatchHandle = (RequestController, DispatchFuture);

use crate::dispatcher::DispatchHandler;
use crate::dispatcher::DispatchOptions;
use crate::dispatcher::MAX_HEADERS;
use crate::dispatcher::PauseState;
use crate::dispatcher::RequestController;
use crate::dispatcher::ResponseStart;
use crate::error::CoreError;

/// reqwest exposes Happy-Eyeballs (parallel IPv4/IPv6 connect attempts) only
/// when its `hickory-dns` resolver is enabled; this turns both off together.
fn configure_happy_eyeballs(
    builder: reqwest::ClientBuilder,
    enabled: bool,
) -> reqwest::ClientBuilder {
    if enabled {
        builder
    } else {
        builder.hickory_dns(false)
    }
}

/// HTTP Basic credentials for an upstream proxy.
#[derive(Debug, Clone)]
pub struct ProxyAuth {
    /// Basic-auth username. Empty string is allowed for proxies that accept
    /// password-only credentials.
    pub username: String,
    /// Basic-auth password.
    pub password: String,
}

/// Proxy configuration for an [`Agent`].
#[derive(Debug, Clone, Default)]
pub enum ProxyConfig {
    /// No proxy. Direct connections only.
    #[default]
    None,
    /// Read `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` from the environment.
    System,
    /// Explicit proxy URI with optional credentials and headers.
    Custom {
        /// Proxy URI, e.g. `http://proxy.example.com:8080`.
        uri: String,
        /// Extra headers to attach to proxy CONNECT/forwarding.
        headers: HashMap<String, String>,
        /// Basic-auth credentials (sent to the proxy, never to the origin).
        auth: Option<ProxyAuth>,
    },
}

/// Configuration for creating an `Agent`.
#[derive(Debug, Clone)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "agent options have many independent toggles, mirroring undici"
)]
pub struct AgentConfig {
    /// Total request timeout (reqwest-level). `None` = no limit.
    pub timeout: Option<Duration>,
    /// Default per-request connect timeout.
    pub connect_timeout: Option<Duration>,
    /// Default per-request headers timeout (status + headers).
    pub headers_timeout: Option<Duration>,
    /// Default per-request body timeout (idle between chunks).
    pub body_timeout: Option<Duration>,
    /// Pool idle timeout.
    pub pool_idle_timeout: Option<Duration>,
    /// 0 = no redirects (undici default).
    pub max_redirections: u32,
    /// When false, force HTTP/1.1 only.
    pub allow_h2: bool,
    /// Honor Happy-Eyeballs (`auto-select-family`) when set; defaults to true.
    pub auto_select_family: bool,
    /// When false, accept invalid TLS certificates (dangerous).
    pub reject_unauthorized: bool,
    /// When false, accept invalid TLS hostnames (dangerous).
    pub reject_invalid_hostnames: bool,
    /// Additional CA certificates in PEM format.
    pub ca: Vec<String>,
    /// Local address to bind outgoing sockets to.
    pub local_address: Option<IpAddr>,
    /// Response-body byte cap (`None` = uncapped). Enforced in the body loop.
    pub max_response_size: Option<u64>,
    /// Proxy configuration.
    pub proxy: ProxyConfig,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            timeout: None,
            connect_timeout: None,
            headers_timeout: None,
            body_timeout: None,
            pool_idle_timeout: None,
            max_redirections: 0,
            allow_h2: true,
            auto_select_family: true,
            reject_unauthorized: true,
            reject_invalid_hostnames: true,
            ca: Vec::new(),
            local_address: None,
            max_response_size: None,
            proxy: ProxyConfig::None,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct AgentDefaults {
    headers: Option<Duration>,
    body: Option<Duration>,
    max_response_size: Option<u64>,
}

struct AgentState {
    next_id: AtomicU64,
    active_tokens: Mutex<HashMap<u64, CancellationToken>>,
    active_count: AtomicUsize,
    idle_notify: Notify,
    closed: AtomicBool,
    destroyed: AtomicBool,
    destroy_error: Mutex<Option<CoreError>>,
    defaults: AgentDefaults,
}

/// HTTP Agent managing connection pooling and request lifecycle.
pub struct Agent {
    client: Client,
    state: Arc<AgentState>,
}

impl Agent {
    /// Create a new Agent.
    #[expect(
        clippy::needless_pass_by_value,
        reason = "owning AgentConfig at the boundary matches FFI ergonomics"
    )]
    pub fn new(config: AgentConfig) -> Result<Self, CoreError> {
        let mut builder = Client::builder().cookie_store(false);

        if let Some(timeout) = config.timeout {
            builder = builder.timeout(timeout);
        }
        if let Some(timeout) = config.connect_timeout {
            builder = builder.connect_timeout(timeout);
        }
        if let Some(timeout) = config.pool_idle_timeout {
            builder = builder.pool_idle_timeout(timeout);
        }

        builder = builder.redirect(if config.max_redirections == 0 {
            reqwest::redirect::Policy::none()
        } else {
            reqwest::redirect::Policy::limited(config.max_redirections as usize)
        });

        if !config.allow_h2 {
            builder = builder.http1_only();
        }

        if !config.reject_unauthorized {
            builder = builder.danger_accept_invalid_certs(true);
        }
        if !config.reject_invalid_hostnames {
            builder = builder.danger_accept_invalid_hostnames(true);
        }

        if let Some(addr) = config.local_address {
            builder = builder.local_address(addr);
        }

        for pem in &config.ca {
            let cert = reqwest::Certificate::from_pem(pem.as_bytes())
                .map_err(|_| CoreError::InvalidArgument("invalid CA certificate".into()))?;
            builder = builder.add_root_certificate(cert);
        }

        match &config.proxy {
            ProxyConfig::None => {
                builder = builder.no_proxy();
            },
            ProxyConfig::System => {
                // reqwest with the `system-proxy` feature reads
                // HTTP_PROXY / HTTPS_PROXY / NO_PROXY automatically.
            },
            ProxyConfig::Custom { uri, headers, auth } => {
                let mut proxy = reqwest::Proxy::all(uri)
                    .map_err(|e| CoreError::InvalidArgument(format!("invalid proxy URI: {e}")))?;
                if let Some(auth) = auth {
                    proxy = proxy.basic_auth(&auth.username, &auth.password);
                }
                if !headers.is_empty() {
                    let mut hmap = reqwest::header::HeaderMap::new();
                    for (k, v) in headers {
                        let name = reqwest::header::HeaderName::from_bytes(k.as_bytes()).map_err(
                            |_| CoreError::InvalidArgument("invalid proxy header name".into()),
                        )?;
                        let value = reqwest::header::HeaderValue::from_str(v).map_err(|_| {
                            CoreError::InvalidArgument("invalid proxy header value".into())
                        })?;
                        hmap.insert(name, value);
                    }
                    proxy = proxy.headers(hmap);
                }
                builder = builder.proxy(proxy);
            },
        }

        builder = configure_happy_eyeballs(builder, config.auto_select_family);

        let client = builder
            .build()
            .map_err(|e| CoreError::from_reqwest(e, false))?;

        let state = AgentState {
            next_id: AtomicU64::new(1),
            active_tokens: Mutex::new(HashMap::new()),
            active_count: AtomicUsize::new(0),
            idle_notify: Notify::new(),
            closed: AtomicBool::new(false),
            destroyed: AtomicBool::new(false),
            destroy_error: Mutex::new(None),
            defaults: AgentDefaults {
                headers: config.headers_timeout,
                body: config.body_timeout,
                max_response_size: config.max_response_size,
            },
        };

        Ok(Self {
            client,
            state: Arc::new(state),
        })
    }

    /// Build a request handle.
    ///
    /// Returns a [`RequestController`] (for abort/pause/resume) and a
    /// [`DispatchFuture`] that drives the request to completion. The caller
    /// spawns the future on a tokio runtime. Handler ownership transfers to
    /// the future; pass `Arc<MyHandler>` if shared ownership is needed.
    pub fn dispatch<H>(
        &self,
        options: DispatchOptions,
        handler: H,
    ) -> Result<DispatchHandle, CoreError>
    where
        H: DispatchHandler,
    {
        if self.state.destroyed.load(Ordering::Acquire) {
            return Err(CoreError::ClientDestroyed);
        }
        if self.state.closed.load(Ordering::Acquire) {
            return Err(CoreError::ClientClosed);
        }

        let controller = RequestController::new();
        let client = self.client.clone();
        let token = controller.token();
        let pause_state = controller.pause_state();
        let state = Arc::clone(&self.state);

        let id = state.next_id.fetch_add(1, Ordering::Relaxed);
        state.active_count.fetch_add(1, Ordering::AcqRel);
        {
            let mut guard = state
                .active_tokens
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.insert(id, token.clone());
        }

        let fut: DispatchFuture = Box::pin(async move {
            Self::execute_request(
                client,
                options,
                handler,
                token,
                pause_state,
                Arc::clone(&state),
            )
            .await;

            {
                let mut guard = state
                    .active_tokens
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                guard.remove(&id);
            }
            if state.active_count.fetch_sub(1, Ordering::AcqRel) == 1 {
                state.idle_notify.notify_waiters();
            }
        });

        Ok((controller, fut))
    }

    fn cancel_reason(state: &AgentState) -> CoreError {
        state
            .destroy_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .cloned()
            .unwrap_or(CoreError::RequestAborted)
    }

    #[expect(
        clippy::too_many_lines,
        reason = "linear request lifecycle is clearer as one body"
    )]
    async fn execute_request<H>(
        client: Client,
        options: DispatchOptions,
        handler: H,
        token: CancellationToken,
        pause_state: Arc<PauseState>,
        state: Arc<AgentState>,
    ) where
        H: DispatchHandler,
    {
        let origin = options.origin.as_deref().unwrap_or_default();
        let url = if options.query.is_empty() {
            format!("{}{}", origin, options.path)
        } else {
            format!("{}{}?{}", origin, options.path, options.query)
        };

        let mut request = client.request(options.method.clone(), &url);

        // Invalid header names/values are deferred by reqwest into the
        // builder's error slot and surface from `.send()` as
        // `is_builder()` — `CoreError::from_reqwest` already maps that to
        // `InvalidArgument`, so we pass strings straight through.
        for (key, values) in &options.headers {
            for value in values {
                request = request.header(key.as_str(), value.as_str());
            }
        }

        if let Some(body) = options.body {
            request = request.body(body);
        }

        let headers_timeout = options
            .headers_timeout_ms
            .map(Duration::from_millis)
            .or(state.defaults.headers)
            .unwrap_or(Duration::from_mins(5));

        let send_future = request.send();

        let response = select! {
            () = token.cancelled() => {
                handler.on_response_error(Self::cancel_reason(&state)).await;
                return;
            }
            result = timeout(headers_timeout, send_future) => {
                match result {
                    Ok(Ok(resp)) => resp,
                    Ok(Err(e)) => {
                        handler.on_response_error(CoreError::from_reqwest(e, false)).await;
                        return;
                    }
                    Err(_elapsed) => {
                        handler.on_response_error(CoreError::HeadersTimeout).await;
                        return;
                    }
                }
            }
        };

        let response_headers = response.headers();
        if response_headers.len() > MAX_HEADERS {
            handler.on_response_error(CoreError::HeadersOverflow).await;
            return;
        }
        // `to_str()` rejects bytes outside printable ASCII (0x20-0x7E + HT).
        // Surface non-conforming values via lossy UTF-8 decode of the raw
        // bytes — keeps the header visible to the caller rather than dropping
        // it.
        let headers = response_headers.iter().fold(
            HashMap::new(),
            |mut acc: HashMap<String, Vec<String>>, (k, v)| {
                let value = match v.to_str() {
                    Ok(s) => s.to_string(),
                    Err(_) => String::from_utf8_lossy(v.as_bytes()).into_owned(),
                };
                acc.entry(k.to_string()).or_default().push(value);
                acc
            },
        );

        handler
            .on_response_start(ResponseStart {
                status_code: response.status().as_u16(),
                status_message: response
                    .status()
                    .canonical_reason()
                    .unwrap_or_default()
                    .to_string(),
                headers,
            })
            .await;

        let body_timeout_duration = options
            .body_timeout_ms
            .map(Duration::from_millis)
            .or(state.defaults.body)
            .unwrap_or(Duration::from_mins(5));

        let max_response_size = state.defaults.max_response_size;
        let mut received_bytes: u64 = 0;
        let mut stream = response.bytes_stream();

        loop {
            select! {
                biased;
                () = token.cancelled() => {
                    drop(stream);
                    handler.on_response_error(Self::cancel_reason(&state)).await;
                    return;
                }
                () = pause_state.wait_if_paused() => {}
            }

            select! {
                biased;
                () = token.cancelled() => {
                    drop(stream);
                    handler.on_response_error(Self::cancel_reason(&state)).await;
                    return;
                }
                result = timeout(body_timeout_duration, stream.next()) => {
                    match result {
                        Ok(Some(Ok(data))) => {
                            if let Some(cap) = max_response_size {
                                received_bytes = received_bytes.saturating_add(data.len() as u64);
                                if received_bytes > cap {
                                    drop(stream);
                                    handler
                                        .on_response_error(CoreError::InvalidArgument(format!(
                                            "response size exceeds cap of {cap} bytes"
                                        )))
                                        .await;
                                    return;
                                }
                            }
                            handler.on_response_data(data).await;
                        }
                        Ok(Some(Err(e))) => {
                            drop(stream);
                            handler.on_response_error(CoreError::from_reqwest(e, true)).await;
                            return;
                        }
                        Ok(None) => {
                            handler.on_response_end(HashMap::new()).await;
                            return;
                        }
                        Err(_elapsed) => {
                            drop(stream);
                            handler.on_response_error(CoreError::BodyTimeout).await;
                            return;
                        }
                    }
                }
            }
        }
    }

    /// Close gracefully: reject new requests, drain active.
    pub async fn close(&self) {
        self.state.closed.store(true, Ordering::Release);

        while self.state.active_count.load(Ordering::Acquire) > 0 {
            self.state.idle_notify.notified().await;
        }
    }

    /// Destroy: cancel all pending requests and surface `error`.
    pub async fn destroy(&self, error: CoreError) {
        self.state.destroyed.store(true, Ordering::Release);
        self.state.closed.store(true, Ordering::Release);
        *self
            .state
            .destroy_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);

        let tokens: Vec<CancellationToken> = {
            let mut guard = self
                .state
                .active_tokens
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.drain().map(|(_id, t)| t).collect()
        };
        for token in tokens {
            token.cancel();
        }

        while self.state.active_count.load(Ordering::Acquire) > 0 {
            self.state.idle_notify.notified().await;
        }
    }

    /// Whether `close()` has been called.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.state.closed.load(Ordering::Acquire)
    }

    /// Whether `destroy()` has been called.
    #[must_use]
    pub fn is_destroyed(&self) -> bool {
        self.state.destroyed.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use anyhow::Context;
    use anyhow::Result;

    use super::*;

    #[test]
    fn agent_creation_default() {
        let agent = Agent::new(AgentConfig::default());
        assert!(agent.is_ok(), "default config must construct");
    }

    #[test]
    fn agent_creation_with_timeouts() {
        let config = AgentConfig {
            timeout: Some(Duration::from_secs(30)),
            connect_timeout: Some(Duration::from_secs(10)),
            pool_idle_timeout: Some(Duration::from_mins(1)),
            ..Default::default()
        };
        let agent = Agent::new(config);
        assert!(agent.is_ok(), "explicit timeouts must construct");
    }

    #[test]
    fn agent_lifecycle_states() -> Result<()> {
        let agent = Agent::new(AgentConfig::default()).context("agent")?;
        assert!(!agent.is_closed(), "fresh agent not closed");
        assert!(!agent.is_destroyed(), "fresh agent not destroyed");
        Ok(())
    }
}
