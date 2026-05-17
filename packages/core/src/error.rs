// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Undici-compatible error types.

use std::collections::HashMap;

use thiserror::Error;

/// Cap on reqwest-derived error message length. Uncapped error strings are
/// a minor memory-blowup surface across the FFI; everything else passes
/// through verbatim (undici doesn't redact URL userinfo either).
const MAX_MESSAGE_LEN: usize = 256;

fn cap_len(raw: &str) -> String {
    if raw.len() <= MAX_MESSAGE_LEN {
        return raw.to_owned();
    }
    // Walk back to the nearest char boundary so we never slice a multi-byte
    // UTF-8 codepoint in half (which would panic).
    let mut end = MAX_MESSAGE_LEN;
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    raw[..end].to_owned()
}

/// Flatten an error chain into `"<top>: <source>: <source>..."`.
fn error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut out = String::new();
    let mut current = err.source();
    while let Some(e) = current {
        if !out.is_empty() {
            out.push_str("; ");
        }
        out.push_str(&e.to_string());
        current = e.source();
    }
    if out.is_empty() {
        "<no source>".into()
    } else {
        out
    }
}

/// Undici-compatible error variants returned across the FFI boundary.
#[derive(Debug, Clone, Error)]
pub enum CoreError {
    #[error("Request aborted")]
    RequestAborted,

    #[error("Connect timeout")]
    ConnectTimeout,

    #[error("Headers timeout")]
    HeadersTimeout,

    #[error("Body timeout")]
    BodyTimeout,

    #[error("Socket error: {0}")]
    Socket(String),

    #[error("Headers overflow")]
    HeadersOverflow,

    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    #[error("The client is destroyed")]
    ClientDestroyed,

    #[error("The client is closed")]
    ClientClosed,

    #[error("Not supported: {0}")]
    NotSupported(String),

    #[error("Redirect error: {0}")]
    Redirect(String),

    /// Surfaced for 4xx/5xx responses when `throwOnError` is enabled; carries
    /// the body and headers captured before the failure (both may be empty).
    #[error("{message}")]
    ResponseError {
        status_code: u16,
        message: String,
        body: Option<Vec<u8>>,
        headers: HashMap<String, Vec<String>>,
    },
}

impl CoreError {
    #[must_use]
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::RequestAborted => "UND_ERR_ABORTED",
            Self::ConnectTimeout => "UND_ERR_CONNECT_TIMEOUT",
            Self::HeadersTimeout => "UND_ERR_HEADERS_TIMEOUT",
            Self::BodyTimeout => "UND_ERR_BODY_TIMEOUT",
            Self::Socket(_) => "UND_ERR_SOCKET",
            Self::HeadersOverflow => "UND_ERR_HEADERS_OVERFLOW",
            Self::InvalidArgument(_) => "UND_ERR_INVALID_ARG",
            Self::ClientDestroyed => "UND_ERR_DESTROYED",
            Self::ClientClosed => "UND_ERR_CLOSED",
            Self::NotSupported(_) => "UND_ERR_NOT_SUPPORTED",
            Self::Redirect(_) => "UND_ERR_REDIRECT",
            Self::ResponseError { .. } => "UND_ERR_RESPONSE",
        }
    }

    #[must_use]
    pub fn status_code(&self) -> Option<u16> {
        match self {
            Self::ResponseError { status_code, .. } => Some(*status_code),
            _ => None,
        }
    }

    /// Map `reqwest::Error` to `CoreError`. Messages are length-capped so
    /// pathological error chains can't blow up the FFI return value.
    /// `in_body_phase` disambiguates `is_timeout()` between headers-phase
    /// and body-phase timeouts.
    #[must_use]
    #[expect(
        clippy::needless_pass_by_value,
        reason = "owned reqwest::Error is the natural call-site shape from .err()/.unwrap_err()"
    )]
    pub fn from_reqwest(err: reqwest::Error, in_body_phase: bool) -> Self {
        if err.is_timeout() {
            if err.is_connect() {
                return Self::ConnectTimeout;
            }
            return if in_body_phase {
                Self::BodyTimeout
            } else {
                Self::HeadersTimeout
            };
        }

        if err.is_redirect() {
            return Self::Redirect(cap_len(&err.to_string()));
        }

        if err.is_connect() {
            return Self::Socket(cap_len(&format!(
                "Connect error: {err}; source: {}",
                error_chain(&err)
            )));
        }

        if err.is_status()
            && let Some(status) = err.status()
        {
            return Self::ResponseError {
                status_code: status.as_u16(),
                message: cap_len(&err.to_string()),
                body: None,
                headers: HashMap::new(),
            };
        }

        if err.is_body() || err.is_decode() {
            return Self::Socket(cap_len(&err.to_string()));
        }

        if err.is_builder() {
            return Self::InvalidArgument(cap_len(&err.to_string()));
        }

        Self::Socket(cap_len(&err.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use anyhow::Context;
    use anyhow::Result;
    use anyhow::ensure;

    use super::*;

    #[test]
    fn error_codes() {
        assert_eq!(
            CoreError::RequestAborted.error_code(),
            "UND_ERR_ABORTED",
            "aborted"
        );
        assert_eq!(
            CoreError::ConnectTimeout.error_code(),
            "UND_ERR_CONNECT_TIMEOUT",
            "connect timeout"
        );
        assert_eq!(
            CoreError::Redirect(String::new()).error_code(),
            "UND_ERR_REDIRECT",
            "redirect"
        );
    }

    #[test]
    fn response_error_status() {
        let err = CoreError::ResponseError {
            status_code: 404,
            message: "Not Found".into(),
            body: None,
            headers: HashMap::new(),
        };
        assert_eq!(err.status_code(), Some(404), "status surfaces");
    }

    #[test]
    fn cap_len_truncates_long_messages() {
        let raw = "x".repeat(1024);
        assert_eq!(cap_len(&raw).len(), 256, "message must be capped");
    }

    #[test]
    fn cap_len_passes_short_messages_through() {
        let raw = "boom";
        assert_eq!(cap_len(raw), raw);
    }

    #[test]
    fn cap_len_respects_utf8_boundaries() {
        // "💀" is a 4-byte codepoint. A naive byte-slice at MAX_MESSAGE_LEN
        // could land mid-codepoint and panic.
        let raw: String = "💀".repeat(100);
        let out = cap_len(&raw);
        assert!(out.len() <= MAX_MESSAGE_LEN, "must respect the cap");
        assert!(out.is_char_boundary(out.len()), "must end on boundary");
    }

    #[tokio::test]
    async fn from_reqwest_branch_table() -> Result<()> {
        let builder = reqwest::Client::builder()
            .https_only(true)
            .build()
            .context("client build")?;
        let err = builder
            .get("ftp://example.invalid")
            .send()
            .await
            .err()
            .context("expected scheme rejection")?;
        assert_eq!(
            CoreError::from_reqwest(err, false).error_code(),
            "UND_ERR_INVALID_ARG",
            "builder rejects non-https"
        );

        let client = reqwest::Client::new();
        let err = client
            .get("http://127.0.0.1:1")
            .send()
            .await
            .err()
            .context("expected connect failure")?;
        let code = CoreError::from_reqwest(err, false).error_code();
        ensure!(
            matches!(code, "UND_ERR_SOCKET" | "UND_ERR_CONNECT_TIMEOUT"),
            "unexpected classification: {code}"
        );
        Ok(())
    }
}
