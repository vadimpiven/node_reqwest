# Pause & Cancellation (Chunk 2A)

**Part**: 2 of 6 (Core Backpressure)  
**Chunk**: 2A of 2  
**Time**: 1.5 hours  
**Prerequisites**: Part 1 complete (Chunks 1A-1B, 3 tests passing)

## Goal

Add backpressure primitives (`PauseState` and `RequestController`) without
integrating them into request execution yet. Focus on atomic operations and cancellation tokens.

## Add Dependency

```toml
# packages/core/Cargo.toml
[dependencies]
tokio-util = { workspace = true }

# Root Cargo.toml
[workspace.dependencies]
tokio-util = { version = "0.7", features = ["sync"] }
```

## PauseState (packages/core/src/dispatcher.rs)

Add these types to existing `dispatcher.rs`:

```rust
// ADD these imports at top
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// Pause state for backpressure
pub struct PauseState {
    paused: AtomicBool,
    notify: Notify,
}

impl PauseState {
    #[must_use]
    pub fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    /// Blocks until not paused. Uses SeqCst for cross-thread visibility.
    pub async fn wait_if_paused(&self) {
        while self.paused.load(Ordering::SeqCst) {
            self.notify.notified().await;
        }
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.notify.notify_one();
    }

    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
}

impl Default for PauseState {
    fn default() -> Self { Self::new() }
}

/// Handle for controlling in-flight request
pub struct RequestController {
    token: CancellationToken,
    pause_state: Arc<PauseState>,
}

impl RequestController {
    #[must_use]
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            pause_state: Arc::new(PauseState::new()),
        }
    }

    pub fn abort(&self) { self.token.cancel(); }
    pub fn pause(&self) { self.pause_state.pause(); }
    pub fn resume(&self) { self.pause_state.resume(); }

    #[must_use]
    pub fn token(&self) -> CancellationToken { self.token.clone() }
    
    #[must_use]
    pub fn pause_state(&self) -> Arc<PauseState> { Arc::clone(&self.pause_state) }
    
    #[must_use]
    pub fn is_cancelled(&self) -> bool { self.token.is_cancelled() }
}

impl Default for RequestController {
    fn default() -> Self { Self::new() }
}
```

## Update DispatchError (packages/core/src/dispatcher.rs)

Add two new error variants:

```rust
#[derive(Debug, Clone)]
pub enum DispatchError {
    Aborted,                // NEW
    Timeout,                // NEW
    Network(String),
    Http(u16, String),
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Aborted => write!(f, "Request aborted"),      // NEW
            Self::Timeout => write!(f, "Request timeout"),      // NEW
            Self::Network(msg) => write!(f, "Network error: {msg}"),
            Self::Http(code, msg) => write!(f, "HTTP {code}: {msg}"),
        }
    }
}
```

## Update Exports (packages/core/src/lib.rs)

```rust
// ADD to re-exports
pub use dispatcher::{
    DispatchError, DispatchHandler, DispatchOptions, Method, ResponseStart,
    PauseState, RequestController, // NEW
};
```

## File Structure

```text
packages/core/
├── src/
│   ├── dispatcher.rs       # UPDATED: Add PauseState, RequestController
│   └── lib.rs              # UPDATED: Export new types
└── tests/                  # No test changes yet
```

## Verification

```bash
cd packages/core
cargo test
```

**Expected output:**

```text
running 3 tests
test agent_dispatch::test_get_200_ok ... ok
test agent_dispatch::test_network_error ... ok
test agent_dispatch::test_multi_value_headers ... ok

test result: ok. 3 passed; 0 failed
```

All previous tests should still pass. New types just need to compile.

**Also verify types can be instantiated:**

```bash
cargo build
```

Should succeed with no errors.

## Milestone Checklist

- [ ] `PauseState` compiles with atomic operations
- [ ] `RequestController` wraps `CancellationToken` and `PauseState`
- [ ] `DispatchError::Aborted` and `DispatchError::Timeout` added
- [ ] New types exported from `lib.rs`
- [ ] Previous 3 tests still pass
- [ ] Ready for Chunk 2B (integration)

## Next Steps

Once verified:

1. Move to **Chunk 2B** (`02b-backpressure-integration.md`)
2. Wire backpressure into `execute_request()`
3. Add 4 new backpressure tests

## Design Notes

- **Atomic operations**: `PauseState` uses `SeqCst` for correctness over performance
- **Cancellation token**: From `tokio-util`, thread-safe abort mechanism
- **No integration yet**: Types compile but aren't used in request execution
- **Test stability**: All previous tests must still pass
