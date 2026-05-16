# Unsupported Features

undici Dispatcher features not supported by `node_reqwest`, plus behavioral differences
and error mapping.

## Not Supported

| Feature              | Reason                                         | Workaround            |
| :------------------- | :--------------------------------------------- | :-------------------- |
| **CONNECT method**   | Rejected at FFI parse with `NotSupportedError` | Use undici ProxyAgent |
| **Upgrade requests** | Rejected at FFI parse with `NotSupportedError` | Use undici WebSocket  |
| **HTTP trailers**    | reqwest doesn't expose                         | Headers only          |
| **Request retries**  | All bodies are streams                         | User-level retry      |
| **Pipelining**       | reqwest uses HTTP/2 multiplexing               | N/A                   |
| **Connection count** | reqwest manages pool internally                | N/A                   |
| **drain event**      | dispatch() always returns true                 | N/A                   |
| **expectContinue**   | reqwest handles internally for H2              | N/A                   |

`request` / `stream` / `pipeline` are **supported**: `Agent` extends undici's
`Dispatcher`, inheriting its default implementations which delegate to
`dispatch()`. The class does not override or stub them.

## Behavioral Differences

| Behavior                      | undici                                           | node_reqwest                                                                                                  |
| :---------------------------- | :----------------------------------------------- | :------------------------------------------------------------------------------------------------------------ |
| **dispatch() return**         | `false` when busy                                | Always `true`                                                                                                 |
| **drain event**               | Emitted when ready for more                      | Not emitted                                                                                                   |
| **connect event**             | Fires when TCP/TLS socket established            | Fires on first response start per origin (reqwest exposes no socket hook)                                     |
| **onRequestStart context**    | Contains retry state                             | Always `{}` (no retries)                                                                                      |
| **Trailers in onResponseEnd** | Contains HTTP trailers                           | Always `{}`                                                                                                   |
| **1xx informational**         | Multiple `onResponseStart` calls for 1xx headers | Single `onResponseStart` (reqwest doesn't expose 1xx)                                                         |
| **Status reason phrase**      | Server-supplied phrase preserved                 | `canonical_reason` (IANA name); empty if non-standard. Discards server bytes to block reason-phrase smuggling |
| **maxRedirections default**   | `0` (manual follow)                              | `0` (matches undici). Configurable per-agent (`maxRedirections`) and per-dispatch                             |

## Error Mapping

| reqwest error                  | undici error           | Notes                                    |
| :----------------------------- | :--------------------- | :--------------------------------------- |
| `is_timeout() && is_connect()` | `ConnectTimeoutError`  | TCP/TLS establishment                    |
| `is_timeout()` (pre-body)      | `HeadersTimeoutError`  | Waiting for headers                      |
| `is_timeout()` (body phase)    | `BodyTimeoutError`     | During streaming                         |
| `is_connect()`                 | `SocketError`          | Connection failure                       |
| `is_status()`                  | `ResponseError`        | HTTP error status                        |
| `is_body()`                    | `SocketError`          | Body read failure                        |
| `is_builder()`                 | `InvalidArgumentError` | Bad request config                       |
| Proxy TLS error                | `SocketError`          | reqwest doesn't distinguish proxy errors |

## Runtime Behavior

- `dispatch()` with `method: 'CONNECT'` calls `onResponseError` with `NotSupportedError`
- `dispatch()` with `upgrade` option calls `onResponseError` with `NotSupportedError`
- Response bodies dropped on abort/error (connection may close rather than reuse)
- `bodyTimeout` is an idle timeout (between chunks), not total timeout

## Future Enhancements

1. WebSocket/Upgrade support via hyper directly
2. CONNECT method for tunneling
3. drain event with configurable concurrency limits
4. HTTP trailers if hyper exposes them
