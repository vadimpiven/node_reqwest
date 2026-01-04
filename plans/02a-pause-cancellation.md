# Pause & Cancellation (Chunk 2A)

## Problem/Purpose

Implement backpressure and cancellation primitives to allow external control over in-flight
HTTP requests.

## Solution

Introduce `PauseState` using atomics for thread-safe pause/resume signals and
`RequestController` to wrap `CancellationToken` and `PauseState`.

## Architecture

```text
RequestController (Handle)
  ├─ CancellationToken (Abort signal)
  └─ PauseState (Backpressure signal)
       ├─ AtomicBool (Paused flag)
       └─ Notify (Waker for resumption)
```

## Implementation

### packages/core/Cargo.toml

```toml
[dependencies]
tokio-util = { workspace = true }
```

### packages/core/src/dispatcher.rs

```rust
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

pub struct PauseState {
    paused: AtomicBool,
    notify: Notify,
}

impl PauseState {
    pub fn new() -> Self {
        Self { paused: AtomicBool::new(false), notify: Notify::new() }
    }

    pub async fn wait_if_paused(&self) {
        while self.paused.load(Ordering::SeqCst) {
            self.notify.notified().await;
        }
    }

    pub fn pause(&self) { self.paused.store(true, Ordering::SeqCst); }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.notify.notify_one();
    }

    pub fn is_paused(&self) -> bool { self.paused.load(Ordering::SeqCst) }
}

pub struct RequestController {
    token: CancellationToken,
    pause_state: Arc<PauseState>,
}

impl RequestController {
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            pause_state: Arc::new(PauseState::new()),
        }
    }

    pub fn abort(&self) { self.token.cancel(); }
    pub fn pause(&self) { self.pause_state.pause(); }
    pub fn resume(&self) { self.pause_state.resume(); }
    pub fn token(&self) -> CancellationToken { self.token.clone() }
    pub fn pause_state(&self) -> Arc<PauseState> { Arc::clone(&self.pause_state) }
    pub fn is_cancelled(&self) -> bool { self.token.is_cancelled() }
}

#[derive(Debug, Clone)]
pub enum DispatchError {
    Aborted,
    Timeout,
    Network(String),
    Http(u16, String),
}
```

### packages/core/src/lib.rs

```rust
pub use dispatcher::{
    DispatchError, DispatchHandler, DispatchOptions, Method, ResponseStart,
    PauseState, RequestController,
};
```

## Tables

| Metric | Value |
| :--- | :--- |
| **Dependency** | `tokio-util = "0.7"` |
| **Atomic Ordering** | `Ordering::SeqCst` |
| **Thread Safety** | Fully `Send + Sync` |

## File Structure

```text
packages/core/
└── src/
    ├── lib.rs
    └── dispatcher.rs
```
