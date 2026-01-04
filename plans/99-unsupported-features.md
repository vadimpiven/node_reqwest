# Unsupported Features

## Purpose

Document undici Dispatcher features not supported by `node_reqwest` due to `reqwest` limitations
or MVP scope decisions.

## Unsupported in MVP

| Feature | Reason | Undici Alternative |
| :--- | :--- | :--- |
| **WebSocket/Upgrade** | Deferred to post-MVP | Use undici directly |
| **CONNECT method** | Deferred to post-MVP | Use undici directly |
| **HTTP trailers** | reqwest doesn't expose trailers | Headers only |
| **Request retries** | All bodies are streams | User-level retry |
| **Pipelining** | reqwest uses HTTP/2 multiplexing | N/A |
| **Connection count control** | reqwest manages pool internally | N/A |

## Behavioral Differences

| Behavior | undici | node_reqwest |
| :--- | :--- | :--- |
| **Backpressure signal** | `dispatch()` returns `false` when busy | Always returns `true` |
| **drain event** | Emitted when ready for more requests | Not emitted (no queue limit) |
| **onRequestStart context** | Contains retry state | Always `{}` (no retries) |
| **Trailers in onResponseEnd** | Contains HTTP trailers | Always `{}` |
| **1xx informational responses** | Multiple `onResponseStart` calls | Single call (handled by reqwest) |

## Error Mapping Differences

| reqwest error | undici error | Notes |
| :--- | :--- | :--- |
| TLS cert invalid | `SocketError` | No `SecureProxyConnectionError` for non-proxy |
| Upgrade failed | `NotSupportedError` | Upgrades not implemented |

## Runtime Requirements

- `dispatch()` with `method: 'CONNECT'` throws `NotSupportedError`
- `dispatch()` with `upgrade` option throws `NotSupportedError`
- Response bodies are always consumed in Rust (caller doesn't need to drain)

## Future Support

Features planned for post-MVP releases:

1. WebSocket/Upgrade support
2. CONNECT method for tunneling
3. Proper `drain` event with configurable concurrency limits
