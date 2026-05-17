// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Core dispatcher types and traits.
//!
//! [`DispatchHandler`] is concrete-typed (not `dyn`-erased). [`crate::Agent::dispatch`]
//! monomorphizes each impl and the `impl Future + Send` return position keeps
//! every callback off the heap. Pass `Arc<H>` if shared ownership is needed.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::error::CoreError;

/// Per-dispatch header cap (request and response). Bounds marshalling time
/// across the FFI boundary; the FFI layer enforces it on the request side.
pub const MAX_HEADERS: usize = 256;

/// HTTP method type re-exported from `http` (via `reqwest`). Use [`parse_method`]
/// to honor the dispatcher's CONNECT/TRACE policy in addition to RFC 7230
/// token validation.
pub use reqwest::Method;

/// Parse a method name (case-insensitive). RFC 7230 token validation is
/// delegated to `http::Method::from_bytes`; this layer adds the
/// dispatcher's policy (CONNECT/TRACE → `NotSupported`).
pub fn parse_method(name: &str) -> Result<Method, CoreError> {
    let upper = name.to_ascii_uppercase();
    let m = Method::from_bytes(upper.as_bytes())
        .map_err(|_| CoreError::InvalidArgument("invalid HTTP method".into()))?;
    if m == Method::CONNECT || m == Method::TRACE {
        return Err(CoreError::NotSupported(
            "CONNECT/TRACE not supported".into(),
        ));
    }
    Ok(m)
}

/// Per-dispatch request options. Not `Clone`: bodies are consumed. Query
/// string is pre-encoded (no leading `?`); timeouts are in milliseconds.
#[derive(derive_more::Debug)]
pub struct DispatchOptions {
    pub origin: Option<String>,
    pub path: String,
    pub query: String,
    pub method: Method,
    pub headers: HashMap<String, Vec<String>>,
    // `reqwest::Body` doesn't impl `Debug`; print a fixed placeholder so the
    // surrounding struct can derive `Debug`.
    #[debug("{}", if body.is_some() { "Some(<body>)" } else { "None" })]
    pub body: Option<reqwest::Body>,
    pub headers_timeout_ms: Option<u64>,
    pub body_timeout_ms: Option<u64>,
    pub connect_timeout_ms: Option<u64>,
}

impl Default for DispatchOptions {
    fn default() -> Self {
        Self {
            origin: None,
            path: "/".to_string(),
            query: String::new(),
            method: Method::GET,
            headers: HashMap::new(),
            body: None,
            headers_timeout_ms: None,
            body_timeout_ms: None,
            connect_timeout_ms: None,
        }
    }
}

/// Response-start metadata. `status_message` is the IANA canonical reason
/// phrase (server-supplied phrases are discarded to block reason-phrase
/// smuggling).
#[derive(Debug, Clone)]
pub struct ResponseStart {
    pub status_code: u16,
    pub status_message: String,
    pub headers: HashMap<String, Vec<String>>,
}

/// Sink for dispatch lifecycle events. See the module doc for the
/// monomorphization contract.
pub trait DispatchHandler: Send + Sync + 'static {
    fn on_response_start(&self, response: ResponseStart) -> impl Future<Output = ()> + Send;
    fn on_response_data(&self, chunk: Bytes) -> impl Future<Output = ()> + Send;
    fn on_response_end(
        &self,
        trailers: HashMap<String, Vec<String>>,
    ) -> impl Future<Output = ()> + Send;
    fn on_response_error(&self, error: CoreError) -> impl Future<Output = ()> + Send;
}

/// Watch-channel-backed pause/resume signal for body backpressure.
pub struct PauseState {
    sender: watch::Sender<bool>,
    receiver: watch::Receiver<bool>,
}

impl Default for PauseState {
    fn default() -> Self {
        Self::new()
    }
}

impl PauseState {
    #[must_use]
    pub fn new() -> Self {
        let (sender, receiver) = watch::channel(false);
        Self { sender, receiver }
    }

    /// Resolves immediately if not paused; otherwise resolves on the next resume.
    pub async fn wait_if_paused(&self) {
        let mut rx = self.receiver.clone();
        let _ = rx.wait_for(|paused| !*paused).await;
    }

    pub fn pause(&self) {
        let _ = self.sender.send(true);
    }

    pub fn resume(&self) {
        let _ = self.sender.send(false);
    }

    #[must_use]
    pub fn is_paused(&self) -> bool {
        *self.receiver.borrow()
    }
}

/// Caller-side handle for an in-flight request: abort, pause, resume.
pub struct RequestController {
    token: CancellationToken,
    pause_state: Arc<PauseState>,
}

impl Default for RequestController {
    fn default() -> Self {
        Self::new()
    }
}

impl RequestController {
    #[must_use]
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            pause_state: Arc::new(PauseState::new()),
        }
    }

    pub fn abort(&self) {
        self.token.cancel();
    }

    pub fn pause(&self) {
        self.pause_state.pause();
    }

    pub fn resume(&self) {
        self.pause_state.resume();
    }

    pub(crate) fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    pub(crate) fn pause_state(&self) -> Arc<PauseState> {
        Arc::clone(&self.pause_state)
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.pause_state.is_paused()
    }
}

#[cfg(test)]
mod tests {
    use anyhow::Context;
    use anyhow::Result;
    use anyhow::ensure;

    use super::*;

    #[test]
    fn pause_state_atomic_operations() {
        let state = PauseState::new();
        assert!(!state.is_paused(), "fresh state must not be paused");

        state.pause();
        assert!(state.is_paused(), "pause() must mark paused");

        state.resume();
        assert!(!state.is_paused(), "resume() must clear paused");
    }

    #[test]
    fn request_controller_abort() {
        let ctrl = RequestController::new();
        assert!(!ctrl.is_cancelled(), "fresh controller not cancelled");

        ctrl.abort();
        assert!(ctrl.is_cancelled(), "abort() must cancel");
    }

    #[tokio::test]
    async fn pause_state_wait_resumes() -> Result<()> {
        let state = Arc::new(PauseState::new());
        state.pause();

        let state_clone = Arc::clone(&state);
        let handle = tokio::spawn(async move {
            state_clone.wait_if_paused().await;
            true
        });

        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        state.resume();

        let result = tokio::time::timeout(std::time::Duration::from_millis(100), handle)
            .await
            .context("timeout")?
            .context("join")?;
        ensure!(result, "waiter must observe resume");
        Ok(())
    }

    #[tokio::test]
    async fn pause_state_wait_for_immediate_resume() -> Result<()> {
        let state = PauseState::new();
        tokio::time::timeout(std::time::Duration::from_millis(10), state.wait_if_paused())
            .await
            .context("must not timeout when not paused")?;
        Ok(())
    }
}
