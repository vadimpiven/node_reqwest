# Dispatcher Implementation

Implement undici `DispatchHandler` interface with `DispatchController` for pause/resume/abort.

## Solution

TypeScript creates `DispatchController`, Rust handles HTTP via reqwest with callbacks through
`neon::event::Channel`. Backpressure via `AtomicBool + Notify`, abort via `CancellationToken`.

## Architecture

```text
JS: AgentImpl.dispatch(opts, handler)
         ↓
    Create DispatchController ─────────────────────────┐
         ↓                                             │
    handler.onRequestStart(controller, context)        │
         ↓                                             │
    Rust: Addon.agentDispatch(agent, options, callbacks)
         ↓                                             │
    Response headers → onResponseStart()               │
         ↓                                             │
    Body chunks ←── pause/resume signals ──────────────┘
         ↓
    onResponseData() per chunk → onResponseEnd() or onResponseError()
```

## Implementation

### DispatchController (TypeScript)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { Dispatcher } from 'undici';

interface RequestHandle {
  abort(): void;
  pause(): void;
  resume(): void;
}

class DispatchControllerImpl implements Dispatcher.DispatchController {
  #aborted = false;
  #paused = false;
  #reason: Error | null = null;
  #requestHandle: RequestHandle | null = null;

  get aborted() { return this.#aborted; }
  get paused() { return this.#paused; }
  get reason() { return this.#reason; }

  setRequestHandle(handle: RequestHandle): void {
    this.#requestHandle = handle;
  }

  abort(reason: Error): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason;
    this.#requestHandle?.abort();
  }

  pause(): void {
    if (!this.#paused) {
      this.#paused = true;
      this.#requestHandle?.pause();
    }
  }

  resume(): void {
    if (this.#paused) {
      this.#paused = false;
      this.#requestHandle?.resume();
    }
  }
}
```

### Addon Interface

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { IncomingHttpHeaders } from 'undici';

export type DispatchCallbacks = {
  onResponseStart: (statusCode: number, headers: IncomingHttpHeaders, statusMessage: string) => void;
  onResponseData: (chunk: Buffer) => void;
  onResponseEnd: (trailers: IncomingHttpHeaders) => void;
  onResponseError: (error: Error) => void;
};

agentDispatch(agent: AgentInstance, options: AgentDispatchOptions, callbacks: DispatchCallbacks): RequestHandle;
```

### Rust Implementation

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use futures::StreamExt;
use neon::prelude::*;
use tokio::{select, sync::Notify};
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
}

pub struct RequestHandle {
    token: CancellationToken,
    pause_state: Arc<PauseState>,
}

impl RequestHandle {
    pub fn abort(&self) { self.token.cancel(); }
    pub fn pause(&self) { self.pause_state.pause(); }
    pub fn resume(&self) { self.pause_state.resume(); }
}

async fn stream_response_body(
    response: reqwest::Response,
    token: CancellationToken,
    pause_state: Arc<PauseState>,
    channel: Channel,
    on_response_data: Root<JsFunction>,
    on_response_end: Root<JsFunction>,
    on_response_error: Root<JsFunction>,
) {
    let mut stream = response.bytes_stream();

    loop {
        pause_state.wait_if_paused().await;

        select! {
            () = token.cancelled() => {
                let _ = channel.send(move |mut cx| {
                    let error = cx.error("Request aborted")?;
                    on_response_error.into_inner(&mut cx).call_with(&cx).arg(error).exec(&mut cx)
                }).await;
                return;
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(data)) => {
                        let chunk_vec = data.to_vec();
                        let _ = channel.send(move |mut cx| {
                            fn send_chunk(cx: &mut Cx<'_>, data: &[u8]) -> NeonResult<()> {
                                let _buffer = JsBuffer::from_slice(cx, data)?;
                                Ok(())
                            }
                            send_chunk(&mut cx, &chunk_vec)
                        }).await;
                    }
                    Some(Err(e)) => {
                        let error_msg = e.to_string();
                        let _ = channel.send(move |mut cx| {
                            let error = cx.error(&error_msg)?;
                            on_response_error.into_inner(&mut cx).call_with(&cx).arg(error).exec(&mut cx)
                        }).await;
                        return;
                    }
                    None => {
                        let _ = channel.send(move |mut cx| {
                            let trailers = cx.empty_object();
                            on_response_end.into_inner(&mut cx).call_with(&cx).arg(trailers).exec(&mut cx)
                        }).await;
                        return;
                    }
                }
            }
        }
    }
}
```

### AbortSignal Integration

```rust
// SPDX-License-Identifier: Apache-2.0 OR MIT

use neon::prelude::*;
use tokio_util::sync::{CancellationToken, WaitForCancellationFuture};

struct AbortSignal {
    signal: Option<Root<JsObject>>,
    token: CancellationToken,
}

impl AbortSignal {
    pub fn try_from_value<'a>(cx: &mut Cx<'a>, value: Handle<'_, JsValue>) -> NeonResult<Option<Self>> {
        if value.is_a::<JsUndefined, _>(cx) { return Ok(None); }

        let signal: Handle<'_, JsObject> = value.downcast_or_throw(cx)?;
        let token = CancellationToken::new();

        let callback = JsFunction::new(cx, {
            let token = token.clone();
            move |mut cx| { token.cancel(); Ok(cx.undefined()) }
        })?;
        signal.set(cx, "onabort", callback)?;

        let aborted: Handle<'_, JsBoolean> = signal.get(cx, "aborted")?;
        if aborted.value(cx) {
            return signal.call_method_with(cx, "throwIfAborted")?.exec(cx)?;
        }

        Ok(Some(Self { signal: Some(signal.root(cx)), token }))
    }

    pub fn aborted(&self) -> WaitForCancellationFuture<'_> { self.token.cancelled() }
}
```

### dispatch() Method

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
  if (this.#closed) {
    const controller = new DispatchControllerImpl();
    handler.onResponseError?.(controller, new Error('Dispatcher is closed'));
    return false;
  }

  const controller = new DispatchControllerImpl();
  handler.onRequestStart?.(controller, {});

  const callbacks = {
    onResponseStart: (statusCode: number, headers: IncomingHttpHeaders, statusMessage: string) => {
      if (controller.aborted) return;
      handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
    },
    onResponseData: (chunk: Buffer) => {
      if (controller.aborted) return;
      handler.onResponseData?.(controller, chunk);
    },
    onResponseEnd: (trailers: IncomingHttpHeaders) => {
      if (controller.aborted) return;
      handler.onResponseEnd?.(controller, trailers);
    },
    onResponseError: (error: Error) => {
      handler.onResponseError?.(controller, controller.reason ?? error);
    },
  };

  const requestHandle = Addon.agentDispatch(this.#agent, this.#buildDispatchOptions(options), callbacks);
  controller.setRequestHandle(requestHandle);
  return true;
}
```

### close/destroy

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

async close(): Promise<void> {
  this.#closed = true;
  await Addon.agentClose(this.#agent);
}

async destroy(err?: Error): Promise<void> {
  this.#destroyed = true;
  this.#closed = true;
  await Addon.agentDestroy(this.#agent, err ?? null);
}
```

## File Structure

```text
packages/node/
├── export/
│   ├── agent.ts        # Add DispatchControllerImpl, update dispatch/close/destroy
│   └── addon-def.ts    # Add DispatchCallbacks, RequestHandle types
├── src/
│   ├── agent.rs        # Implement agent_dispatch with reqwest + Channel
│   └── lib.rs          # Add tokio runtime, pause/abort types
└── tests/vitest/
    ├── agent.test.ts
    ├── dispatcher.test.ts
    ├── backpressure.test.ts
    └── abort.test.ts
```

## Dependencies

| Crate          | Purpose                     |
| :------------- | :-------------------------- |
| `reqwest`      | HTTP client                 |
| `tokio`        | Async runtime               |
| `tokio-util`   | CancellationToken           |
| `futures`      | StreamExt for bytes_stream  |

## Implementation Order

1. DispatchController skeleton (TS)
2. Basic Rust dispatch with Channel callbacks
3. Wire addon interface
4. Complete dispatch() flow
5. Add abort support
6. Add backpressure support
7. Implement close/destroy
8. Tests

## Open Questions

- Request body streaming for POST/PUT
- Upgrade/CONNECT handler
- Drain event timing
- Root cloning before spawn
