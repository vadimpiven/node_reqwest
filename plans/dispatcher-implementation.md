# Dispatcher Implementation: New DispatchHandler Interface

## Problem

The current `AgentImpl.dispatch()` returns the result of `Addon.agentDispatch()` directly without implementing
the handler callback protocol. Undici requires the dispatcher to:

1. Call handler callbacks (`onRequestStart`, `onResponseStart`, `onResponseData`, etc.)
2. Handle backpressure via `DispatchController.pause()`/`resume()`
3. Support abortion via `DispatchController.abort()`

**Target:** Implement the new (non-deprecated) `DispatchHandler` interface with `DispatchController`.

## Architecture

```text
JS: AgentImpl.dispatch(opts, handler)
         ↓
    Create DispatchController ──────────────────────────┐
         ↓                                              │
    handler.onRequestStart(controller, context)         │
         ↓                                              │
    Rust: Addon.agentDispatch(agent, options, callbacks)│
         ↓                                              │
    Response headers arrive                             │
         ↓                                              │
    JS callback: onResponseStart()                      │
         ↓                                              │
    Response body chunks  ←── pause/resume signals ─────┘
         ↓
    JS callback: onResponseData() per chunk
         ↓
    JS callback: onResponseEnd() or onResponseError()
```

## Design Decisions

### 1. Interface Choice: New vs Legacy

Use the **new interface** (`onRequestStart`/`onResponseStart`/`onResponseData`/`onResponseEnd`/`onResponseError`).

**Why:** The legacy interface is deprecated. The new interface provides cleaner separation via
`DispatchController` for pause/resume/abort instead of callback parameters.

### 2. Controller Ownership

The **TypeScript side creates and owns** the `DispatchController`. It wraps the abort signal and
pause/resume state, passing control signals to Rust.

**Why:** The controller is purely a coordination object. Rust owns the HTTP request; JS owns the lifecycle
callbacks. The controller bridges them.

### 3. Backpressure Strategy

Rust streams body chunks via async iteration. When `onResponseData()` triggers `controller.pause()`:

1. JS sets `paused = true` on the controller
2. JS signals Rust to pause via a shared `AtomicBool` or channel
3. Rust stops polling the response body stream
4. When `controller.resume()` is called, JS signals Rust to continue

**Why reqwest supports this:** Reqwest's `Response::bytes_stream()` is an async stream.
Backpressure is natural—just stop calling `.await` on the next chunk. The challenge is
signaling pause/resume across the Neon FFI boundary.

### 4. Abort Strategy

When `controller.abort(reason)` is called:

1. JS sets `aborted = true` and stores `reason`
2. JS signals Rust via an `AbortHandle` (tokio's `CancellationToken` or reqwest's built-in abort)
3. Rust drops the in-flight request
4. JS calls `handler.onResponseError(controller, reason)`

**Why:** Reqwest requests can be aborted by dropping the future or using `AbortHandle`. The controller
stores the reason for the `onResponseError` callback.

## Implementation

### Phase 1: DispatchController (TypeScript)

Create a `DispatchController` implementation in `agent.ts`:

```typescript
class DispatchControllerImpl implements Dispatcher.DispatchController {
  #aborted = false;
  #paused = false;
  #reason: Error | null = null;
  #abortHandle: AbortHandle;       // Passed to Rust
  #pauseSignal: PauseSignal;       // Shared with Rust

  get aborted() { return this.#aborted; }
  get paused() { return this.#paused; }
  get reason() { return this.#reason; }

  abort(reason: Error): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason;
    this.#abortHandle.abort();
  }

  pause(): void {
    this.#paused = true;
    this.#pauseSignal.pause();
  }

  resume(): void {
    this.#paused = false;
    this.#pauseSignal.resume();
  }
}
```

### Phase 2: Addon Interface

Update `addon-def.ts` to include `DispatchCallbacks`:

```typescript
export type DispatchCallbacks = {
  // Called when response headers arrive
  onResponseStart: (statusCode: number, headers: Record<string, string>, statusMessage: string) => void;
  // Called for each body chunk; return false to pause
  onResponseData: (chunk: Buffer) => boolean;
  // Called on successful completion
  onResponseEnd: (trailers: Record<string, string>) => void;
  // Called on error
  onResponseError: (error: Error) => void;
};

// New signature
agentDispatch(
  agent: AgentInstance,
  options: AgentDispatchOptions,
  callbacks: DispatchCallbacks,
  abortHandle: AbortHandle,
  pauseSignal: PauseSignal
): boolean;
```

### Phase 3: Rust Dispatch Implementation

In `agent.rs`, implement the core dispatch logic:

```rust
#[neon::export(name = "agentDispatch", context)]
fn agent_dispatch<'cx>(
    cx: &mut FunctionContext<'cx>,
    agent: Handle<'cx, JsBox<AgentInstance>>,
    options: Handle<'cx, JsObject>,
    callbacks: Handle<'cx, JsObject>,
    abort_handle: Handle<'cx, JsObject>,
    pause_signal: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsBoolean> {
    // 1. Parse options into reqwest Request
    // 2. Spawn async task on tokio runtime
    // 3. Inside task:
    //    - Build and send request
    //    - Check abort_handle before each step
    //    - On headers: call callbacks.onResponseStart from main thread
    //    - Stream body: for each chunk, call callbacks.onResponseData
    //    - Respect pause_signal: wait when paused
    //    - On complete: call callbacks.onResponseEnd
    //    - On error: call callbacks.onResponseError
    // 4. Return true (backpressure handled via pause_signal)
}
```

**Key Rust patterns:**

- Use `neon::thread::ThreadSafeFunction` for callbacks from async context
- Use `tokio::sync::watch` or `parking_lot::Condvar` for pause/resume signaling
- Use `tokio_util::sync::CancellationToken` for abort

### Phase 4: Backpressure Signal Mechanism

Create shared pause/resume signal:

```typescript
// In addon-def.ts
export interface PauseSignal {
  pause(): void;
  resume(): void;
  waitIfPaused(): Promise<void>; // Used internally by Rust
}
```

**Rust implementation:**

```rust
struct PauseSignal {
    paused: AtomicBool,
    notify: Notify,
}

impl PauseSignal {
    async fn wait_if_paused(&self) {
        while self.paused.load(Ordering::SeqCst) {
            self.notify.notified().await;
        }
    }
    
    fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }
    
    fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.notify.notify_one();
    }
}
```

### Phase 5: Abort Handle Mechanism

Create abort handle that Rust can check:

```typescript
// In addon-def.ts
export interface AbortHandle {
  abort(): void;
  readonly aborted: boolean;
}
```

**Rust implementation:**

```rust
struct AbortHandle {
    token: CancellationToken,
}

impl AbortHandle {
    fn abort(&self) {
        self.token.cancel();
    }
    
    fn is_aborted(&self) -> bool {
        self.token.is_cancelled()
    }
}
```

### Phase 6: Updated dispatch() in agent.ts

```typescript
dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
  if (this.#closed) {
    handler.onResponseError?.(/* create controller */, new Error('Dispatcher is closed'));
    return false;
  }

  const abortHandle = Addon.createAbortHandle();
  const pauseSignal = Addon.createPauseSignal();
  const controller = new DispatchControllerImpl(abortHandle, pauseSignal);

  // Notify request start
  handler.onRequestStart?.(controller, {});

  const callbacks: DispatchCallbacks = {
    onResponseStart: (statusCode, headers, statusMessage) => {
      if (controller.aborted) return;
      handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
    },
    onResponseData: (chunk) => {
      if (controller.aborted) return false;
      handler.onResponseData?.(controller, chunk);
      return !controller.paused;
    },
    onResponseEnd: (trailers) => {
      if (controller.aborted) return;
      handler.onResponseEnd?.(controller, trailers);
    },
    onResponseError: (error) => {
      handler.onResponseError?.(controller, controller.reason ?? error);
    },
  };

  const dispatchOptions = this.#buildDispatchOptions(options);
  return Addon.agentDispatch(this.#agent, dispatchOptions, callbacks, abortHandle, pauseSignal);
}
```

### Phase 7: close() and destroy()

```typescript
async close(): Promise<void> {
  this.#closed = true;
  // Wait for pending requests via Rust
  await Addon.agentClose(this.#agent);
}

async destroy(err?: Error): Promise<void> {
  this.#destroyed = true;
  this.#closed = true;
  // Abort all pending requests
  await Addon.agentDestroy(this.#agent, err ?? null);
}
```

## Headers Format

The new interface uses `IncomingHttpHeaders` (object form), not raw `Buffer[]` arrays:

```typescript
// onResponseStart receives:
headers: { 'content-type': 'application/json', 'x-custom': 'value' }

// Not the legacy format:
rawHeaders: [Buffer('content-type'), Buffer('application/json'), ...]
```

Rust should build headers as `Record<string, string>` directly.

## Testing Checklist

1. **Basic request:** `fetch()` completes successfully
2. **Abort:** `AbortController.abort()` cancels request, triggers `onResponseError`
3. **Backpressure:** Slow consumer pauses body streaming
4. **Error handling:** Network errors trigger `onResponseError`
5. **Lifecycle:** `close()` waits for pending, `destroy()` aborts all

## Files to Modify

| File                   | Changes                                                                        |
| :--------------------- | :----------------------------------------------------------------------------- |
| `export/agent.ts`      | Add `DispatchControllerImpl`, update `dispatch()`, `close()`, `destroy()`      |
| `export/addon-def.ts`  | Add `DispatchCallbacks`, `AbortHandle`, `PauseSignal`, update `agentDispatch`  |
| `src/agent.rs`         | Implement `agent_dispatch` with reqwest, callbacks, abort/pause handling       |
| `src/lib.rs`           | Add abort handle and pause signal exports if needed                            |
