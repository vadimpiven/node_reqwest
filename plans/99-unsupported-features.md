# Unsupported Features

## Purpose

Document undici Dispatcher features not supported by `node_reqwest` due to `reqwest`
limitations or scope decisions.

## Not Supported

| Feature | Reason | Workaround |
| :--- | :--- | :--- |
| **CONNECT method** | reqwest limitation | Use undici ProxyAgent |
| **Upgrade requests** | reqwest limitation | Use undici WebSocket |
| **HTTP trailers** | reqwest doesn't expose | Headers only |
| **Request retries** | All bodies are streams | User-level retry |
| **Pipelining** | reqwest uses HTTP/2 multiplexing | N/A |
| **Connection count** | reqwest manages pool internally | N/A |
| **drain event** | dispatch() always returns true | N/A |
| **expectContinue** | reqwest handles internally for H2 | N/A |

## Behavioral Differences from undici

| Behavior | undici | node_reqwest |
| :--- | :--- | :--- |
| **dispatch() return** | `false` when busy | Always `true` |
| **drain event** | Emitted when ready for more | Not emitted |
| **onRequestStart context** | Contains retry state | Always `{}` (no retries) |
| **Trailers in onResponseEnd** | Contains HTTP trailers | Always `{}` |
| **1xx informational** | Multiple `onResponseStart` calls for 1xx headers | Single `onResponseStart` (reqwest doesn't expose 1xx) |

## Error Mapping

| reqwest error | undici error | Notes |
| :--- | :--- | :--- |
| `is_timeout() && is_connect()` | `ConnectTimeoutError` | TCP/TLS establishment |
| `is_timeout()` (pre-body) | `HeadersTimeoutError` | Waiting for headers |
| `is_timeout()` (body phase) | `BodyTimeoutError` | During streaming |
| `is_connect()` | `SocketError` | Connection failure |
| `is_status()` | `ResponseError` | HTTP error status |
| `is_body()` | `SocketError` | Body read failure |
| `is_builder()` | `InvalidArgumentError` | Bad request config |
| Proxy TLS error | `SocketError` | reqwest doesn't distinguish proxy errors |

## Runtime Behavior

- `dispatch()` with `method: 'CONNECT'` calls `onResponseError` with `NotSupportedError`
- `dispatch()` with `upgrade` option calls `onResponseError` with `NotSupportedError`
- Response bodies dropped on abort/error (connection may close rather than reuse)
- `bodyTimeout` is an idle timeout (between chunks), not total timeout

## Future Enhancements (Post-undici compliance)

1. WebSocket/Upgrade support via hyper directly
2. CONNECT method for tunneling
3. Proper drain event with configurable concurrency limits
4. HTTP trailers if hyper exposes them
