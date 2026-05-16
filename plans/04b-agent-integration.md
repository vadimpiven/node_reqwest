# Agent Integration + E2E Tests (Chunk 04b)

Wraps the FFI layer in an undici-compatible `Agent`: dispatches requests
through the native addon, marshals callbacks, and emits
`connect` / `disconnect` / `connectionError` events.

The TypeScript surface is **flat-undici-shape**: callers can drop `Agent`
in wherever they previously used `undici.Agent`. Defaults are tuned for
the common case ("pit of success" — see
`plans/_review-architect.md` C1, progressive-disclosure doc).

## Flow

```text
User
  └─► Agent.dispatch(options, handler)
       ├─► new DispatchController()
       ├─► handler.onRequestStart(controller, {})  ← FIRST, always
       ├─► gate: NotSupportedError | ClientClosed | ClientDestroyed | aborted
       │        → handler.onResponseError(controller, ...)
       ├─► normalizeBody() — default reader, no BYOB
       ├─► Addon.agentDispatch(...) → RequestHandle
       ├─► controller[kSetRequestHandle](handle)
       └─► callbacks emit handler.on* + connect/disconnect/connectionError
```

## API surface — `AgentOptions` (flat, undici-compatible)

Hoisted to top level to match undici exactly. Grouped sub-records only
where undici itself groups them (`tls`, `proxy`).

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";
import type * as undici from "undici";

/**
 * TLS settings for direct and proxy-tunnel connections.
 *
 * Mirrors the subset of `tls.ConnectionOptions` that reqwest supports.
 * Disabling `rejectUnauthorized` or `rejectInvalidHostnames` is logged
 * (see Security section below) — these defaults exist for safety.
 */
export type TlsOptions = Pick<
    TlsConnectionOptions,
    "ca" | "rejectUnauthorized"
> & {
    /**
     * Verify the server certificate's hostname identity. Independent of
     * CA chain verification (`rejectUnauthorized`).
     * @default true
     */
    rejectInvalidHostnames?: boolean;
};

/**
 * Upstream proxy configuration.
 *
 * `type: "system"` reads `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env.
 * `type: "custom"` requires `uri`; `token` is passed via Basic-Auth
 * header (never embedded in the URL — see Security I3).
 *
 * Headers/token are never logged.
 */
export type ProxyOptions =
    | { type: "system" }
    | {
          type: "custom";
          uri: string;
          headers?: Record<string, string | string[]>;
          token?: string;
      };

/**
 * Agent configuration. All options have undici-compatible defaults so
 * `new Agent()` works out of the box.
 *
 * Timeout / size options are at the top level for drop-in undici
 * compatibility. Nested `tls` and `proxy` records group concerns that
 * undici itself groups.
 */
export type AgentOptions = {
    // --- per-request timeouts (top-level, match undici) ---
    /** Time to wait for response headers. @default 300_000 ms */
    headersTimeout?: number;
    /** Time to wait between body chunks. @default 300_000 ms */
    bodyTimeout?: number;
    /** TCP connect timeout. @default 10_000 ms */
    connectTimeout?: number;
    /** Idle keep-alive timeout. @default 4_000 ms */
    keepAliveTimeout?: number;

    // --- redirects & response size ---
    /** Max redirect hops. @default 0 (no automatic follow, matches undici) */
    maxRedirections?: number;
    /** Hard cap on decoded response body, in bytes. @default unlimited */
    maxResponseSize?: number;

    // --- transport ---
    /** Allow HTTP/2 negotiation via ALPN. @default true */
    allowH2?: boolean;
    /** Source IP for outgoing connections. Validated as IP at TS layer. */
    localAddress?: string;

    // --- grouped concerns ---
    /** TLS settings (CA, hostname/cert verification). */
    tls?: TlsOptions;
    /**
     * Proxy configuration. Defaults to **no proxy** (matches undici).
     * Pass `{ type: "system" }` to opt into env-driven proxy.
     */
    proxy?: ProxyOptions;
};

export interface AgentConstructor {
    new (options?: AgentOptions): undici.Dispatcher;
}
```

Unsupported undici options (managed internally by reqwest): `connections`
(pool size), `pipelining` (HTTP/2 multiplexing always on),
`maxCachedSessions` (TLS session cache), `keepAliveInitialDelay`.

## Implementation

### packages/node/export/agent.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { isIP } from "node:net";
import type Stream from "node:stream";

import { Dispatcher, type FormData, Response } from "undici";

import type {
    Addon as AddonType,
    AgentCreationOptions,
    AgentDispatchOptions,
    AgentInstance,
    DispatchCallbacks,
} from "./addon-def.ts";
import type {
    AgentConstructor,
    AgentOptions,
    ProxyOptions,
    TlsOptions,
} from "./agent-def.ts";
import {
    DispatchController,
    kSetRequestHandle,
} from "./dispatch-controller.ts";
import {
    createUndiciError,
    ClientClosedError,
    ClientDestroyedError,
    InvalidArgumentError,
    NotSupportedError,
    RequestAbortedError,
    ResponseError,
    type CoreErrorInfo,
} from "./errors.ts";

import AddonImpl from "../index.node";

const Addon: AddonType = AddonImpl;

// --- PEM normalization with caps (Security C4) -----------------------

const MAX_PEM_BYTES = 256 * 1024;   // per entry
const MAX_PEM_ENTRIES = 32;         // total

function normalizePem(
    pem?: string | Buffer | (string | Buffer)[],
): string[] {
    if (!pem) return [];

    const list = Array.isArray(pem) ? pem : [pem];
    if (list.length > MAX_PEM_ENTRIES) {
        throw new InvalidArgumentError(
            `tls.ca: too many entries (${list.length} > ${MAX_PEM_ENTRIES})`,
        );
    }

    const out: string[] = [];
    for (const entry of list) {
        let text: string;
        if (Buffer.isBuffer(entry)) {
            // Reject DER (binary): require ASCII / PEM armor.
            if (entry.length > 0 && !entry.includes(Buffer.from("-----"))) {
                throw new InvalidArgumentError(
                    "tls.ca: DER-encoded buffer detected; PEM (text) required",
                );
            }
            text = entry.toString("utf8");
        } else {
            text = entry;
        }
        if (Buffer.byteLength(text, "utf8") > MAX_PEM_BYTES) {
            throw new InvalidArgumentError(
                `tls.ca: entry exceeds ${MAX_PEM_BYTES} bytes`,
            );
        }
        out.push(text);
    }
    return out;
}

// --- Header validation (Security C5) ---------------------------------
//
// RFC 7230 token: 1*( !#$%&'*+-.^_`|~ / DIGIT / ALPHA )
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function validateHeaderName(name: string): void {
    if (!HEADER_NAME_RE.test(name)) {
        // Do not echo raw bytes — log length only.
        throw new InvalidArgumentError(
            `invalid header name (length ${name.length})`,
        );
    }
}

function validateHeaderValue(value: string): void {
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c === 0x00 || c === 0x0A || c === 0x0D) {
            throw new InvalidArgumentError(
                `invalid header value: contains CR/LF/NUL (length ${value.length})`,
            );
        }
    }
}

/**
 * Normalize headers into `Record<string, string | string[]>`.
 *
 * Multi-value headers (e.g. `Set-Cookie`) are preserved as arrays — the
 * FFI side emits arrays for these per the undici Dispatcher spec. We do
 * NOT join with `", "`: that would corrupt cookies and any header with
 * commas in its value.
 */
function normalizeHeaders(
    headers?:
        | Record<string, string | string[] | undefined>
        | Iterable<[string, string | string[] | undefined]>
        | string[]
        | null,
): Record<string, string | string[]> {
    if (!headers) return {};

    const out: Record<string, string | string[]> = {};
    const add = (key: string, value: string | string[] | undefined) => {
        if (value === undefined) return;
        const k = key.toLowerCase();
        validateHeaderName(k);
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) validateHeaderValue(v);

        const existing = out[k];
        if (existing === undefined) {
            out[k] = values.length === 1 ? values[0] : values;
        } else {
            out[k] = Array.isArray(existing)
                ? [...existing, ...values]
                : [existing, ...values];
        }
    };

    if (Array.isArray(headers)) {
        // Raw header array: [name1, value1, name2, value2, ...]
        for (let i = 0; i < headers.length; i += 2) {
            add(headers[i], headers[i + 1]);
        }
    } else if (Symbol.iterator in headers) {
        for (const [k, v] of headers) add(k, v);
    } else {
        for (const [k, v] of Object.entries(headers)) add(k, v);
    }

    return out;
}

// --- Body normalization (Architect C3 / Node Critical) ---------------
//
// Use the DEFAULT reader, NOT BYOB. The FFI side (`JsBodyReader::next`)
// calls `reader.read()` with no argument; BYOB readers reject that call.
// Known-sized inputs (string / Buffer / Uint8Array) bypass the stream
// wrapper entirely for efficiency.

type NormalizedBody =
    | { kind: "bytes"; data: Uint8Array }
    | { kind: "stream"; reader: ReadableStreamDefaultReader<Uint8Array> }
    | null;

function normalizeBody(
    body?: string | Buffer | Uint8Array | FormData | Stream.Readable | null,
): NormalizedBody {
    if (body === undefined || body === null) return null;

    if (typeof body === "string") {
        return { kind: "bytes", data: Buffer.from(body, "utf8") };
    }
    if (Buffer.isBuffer(body)) {
        return { kind: "bytes", data: new Uint8Array(body) };
    }
    if (body instanceof Uint8Array) {
        return { kind: "bytes", data: body };
    }

    // FormData / Readable / ReadableStream — let `Response` coerce.
    const response = new Response(body as BodyInit);
    if (!response.body) return null;
    return { kind: "stream", reader: response.body.getReader() };
}

// --- Agent ------------------------------------------------------------

function buildCreationOptions(options?: AgentOptions): AgentCreationOptions {
    const tls: TlsOptions = options?.tls ?? {};
    const rejectUnauthorized = tls.rejectUnauthorized ?? true;
    const rejectInvalidHostnames =
        tls.rejectInvalidHostnames ?? rejectUnauthorized;

    // Security C3: TS-side warning in addition to FFI-side.
    if (rejectUnauthorized === false) {
        console.warn(
            "[node_reqwest] tls.rejectUnauthorized=false disables CA " +
                "verification — vulnerable to MITM. Use only in tests.",
        );
    }
    if (rejectInvalidHostnames === false) {
        console.warn(
            "[node_reqwest] tls.rejectInvalidHostnames=false disables " +
                "hostname verification — vulnerable to MITM.",
        );
    }

    // Security I9: validate localAddress as IP.
    if (options?.localAddress !== undefined && options.localAddress !== null) {
        if (isIP(options.localAddress) === 0) {
            throw new InvalidArgumentError(
                `localAddress must be a valid IPv4/IPv6 address`,
            );
        }
    }

    // Proxy default: `{ type: "system" }` — honors HTTP_PROXY/HTTPS_PROXY
    // env vars. Deliberate divergence from undici (which has no implicit
    // proxy). Rationale: node-reqwest's selling point is "system proxy
    // out of the box" (see packages/node/README.md). To opt out, pass
    // `proxy: { type: "custom", uri: "" }` or set HTTP_PROXY="".
    const proxy: ProxyOptions = options?.proxy ?? { type: "system" };

    return {
        allowH2: options?.allowH2 ?? true,
        ca: normalizePem(tls.ca),
        connectTimeout: options?.connectTimeout ?? 10_000,
        headersTimeout: options?.headersTimeout ?? 300_000,
        bodyTimeout: options?.bodyTimeout ?? 300_000,
        keepAliveTimeout: options?.keepAliveTimeout ?? 4_000,
        localAddress: options?.localAddress ?? null,
        maxRedirections: options?.maxRedirections ?? 0,
        maxResponseSize: options?.maxResponseSize ?? null,
        proxy:
            proxy.type === "system"
                ? { type: "system" }
                : {
                      type: "custom",
                      uri: proxy.uri,
                      headers: normalizeHeaders(proxy.headers) as Record<
                          string,
                          string
                      >,
                      token: proxy.token ?? null,
                  },
        rejectInvalidHostnames,
        rejectUnauthorized,
    };
}

class AgentImpl extends Dispatcher {
    readonly #agent: AgentInstance;
    #closed = false;
    #destroyed = false;
    #closePromise: Promise<void> | null = null;
    #destroyPromise: Promise<void> | null = null;
    /** Origins that have established at least one successful connection. */
    readonly #connectedOrigins = new Set<string>();

    constructor(options?: AgentOptions) {
        super();
        this.#agent = Addon.agentCreate(buildCreationOptions(options));
    }

    dispatch(
        options: Dispatcher.DispatchOptions,
        handler: Dispatcher.DispatchHandler,
    ): boolean {
        const controller = new DispatchController(Addon);

        // -- Step 1: ALWAYS call onRequestStart first ----------------
        // (Architect C6 + Node Critical: spec requires onRequestStart
        //  before any onResponseError emit.)
        try {
            handler.onRequestStart?.(controller, {});
        } catch (err) {
            handler.onResponseError?.(controller, toError(err));
            return true;
        }

        // -- Step 2: gating short-circuits ---------------------------
        if (options.method === "CONNECT" || options.upgrade) {
            handler.onResponseError?.(
                controller,
                new NotSupportedError(
                    "CONNECT method and upgrade requests are not supported",
                ),
            );
            return true;
        }
        if (this.#closed) {
            handler.onResponseError?.(controller, new ClientClosedError());
            return true;
        }
        if (this.#destroyed) {
            handler.onResponseError?.(controller, new ClientDestroyedError());
            return true;
        }
        if (controller.aborted) {
            handler.onResponseError?.(
                controller,
                controller.reason ?? new RequestAbortedError(),
            );
            return true;
        }

        // -- Step 3: external AbortSignal ----------------------------
        // Use an internal listener + cleanup on both terminal paths to
        // avoid leaking listeners on long-lived signals (Node Critical).
        let signalCleanup: (() => void) | null = null;
        if (options.signal) {
            const signal = options.signal as AbortSignal;
            const signalReasonToError = (): Error => {
                const r = signal.reason;
                return r instanceof Error
                    ? r
                    : new RequestAbortedError(
                          typeof r === "string" ? r : undefined,
                      );
            };
            if (signal.aborted) {
                handler.onResponseError?.(controller, signalReasonToError());
                return true;
            }
            const onAbort = () => controller.abort(signalReasonToError());
            signal.addEventListener("abort", onAbort, { once: true });
            signalCleanup = () =>
                signal.removeEventListener("abort", onAbort);
        }

        // -- Step 4: validate origin ---------------------------------
        if (!options.origin) {
            signalCleanup?.();
            handler.onResponseError?.(
                controller,
                new InvalidArgumentError("origin is required"),
            );
            return true;
        }
        let origin: URL;
        try {
            origin = new URL(String(options.origin));
        } catch {
            signalCleanup?.();
            handler.onResponseError?.(
                controller,
                new InvalidArgumentError("origin must be a valid URL"),
            );
            return true;
        }

        // -- Step 5: build dispatch options --------------------------
        const dispatchOptions: AgentDispatchOptions = {
            blocking: options.blocking ?? options.method !== "HEAD",
            body: normalizeBody(options.body),
            bodyTimeout: options.bodyTimeout ?? null,           // inherit agent
            headers: normalizeHeaders(options.headers),
            headersTimeout: options.headersTimeout ?? null,     // inherit agent
            idempotent:
                options.idempotent ??
                (options.method === "GET" || options.method === "HEAD"),
            maxRedirections: options.maxRedirections ?? null,   // inherit agent
            method: options.method,
            origin: origin.origin,
            path: options.path,
            query: encodeQuery(options.query),
            reset: options.reset ?? false,
            throwOnError: options.throwOnError ?? false,
        };

        const originKey = origin.origin;
        let requestConnected = false;
        const finish = () => signalCleanup?.();

        const callbacks: DispatchCallbacks = {
            onResponseStart: (
                statusCode: number,
                headers: Record<string, string | string[]>,
                statusMessage: string,
            ) => {
                if (controller.aborted) return;
                requestConnected = true;

                if (!this.#connectedOrigins.has(originKey)) {
                    this.#connectedOrigins.add(originKey);
                    // Synchronous emit (Node Important: match undici timing).
                    this.emit("connect", origin, [this]);
                }

                if (dispatchOptions.throwOnError && statusCode >= 400) {
                    const error = new ResponseError(
                        `Request failed with status code ${statusCode}`,
                        statusCode,
                    );
                    handler.onResponseError?.(controller, error);
                    controller.abort(error);
                    return;
                }

                handler.onResponseStart?.(
                    controller,
                    statusCode,
                    headers,
                    statusMessage,
                );
            },
            onResponseData: (chunk: Buffer) => {
                if (controller.aborted) return;
                handler.onResponseData?.(controller, chunk);
            },
            onResponseEnd: (trailers: Record<string, string | string[]>) => {
                finish();
                if (controller.aborted) return;
                // reqwest does not surface HTTP trailers — `trailers` is
                // always empty. Field preserved for undici interface
                // compatibility.
                handler.onResponseEnd?.(controller, trailers);
            },
            onResponseError: (errorInfo: CoreErrorInfo) => {
                finish();

                // User-initiated abort with custom reason wins.
                if (
                    controller.aborted &&
                    errorInfo.code === "UND_ERR_ABORTED"
                ) {
                    handler.onResponseError?.(
                        controller,
                        controller.reason ?? new RequestAbortedError(),
                    );
                    return;
                }

                // Wrap so UND_ERR_* codes propagate.
                const err = createUndiciError(errorInfo);
                const isConnError =
                    errorInfo.code === "UND_ERR_SOCKET" ||
                    errorInfo.code === "UND_ERR_CONNECT_TIMEOUT";

                if (isConnError) {
                    if (requestConnected) {
                        this.emit("disconnect", origin, [this], err);
                    } else {
                        this.emit("connectionError", origin, [this], err);
                    }
                }

                handler.onResponseError?.(controller, err);
            },
        };

        const handle = Addon.agentDispatch(
            this.#agent,
            dispatchOptions,
            callbacks,
        );
        controller[kSetRequestHandle](handle);

        // Always return true — reqwest owns pooling and backpressure.
        return true;
    }

    /**
     * Idempotent. Subsequent calls return the same promise as the first.
     */
    close(): Promise<void> {
        if (this.#destroyPromise) return this.#destroyPromise;
        this.#closed = true;
        return (this.#closePromise ??= Addon.agentClose(this.#agent));
    }

    /** Idempotent. Implies close. */
    destroy(): Promise<void> {
        this.#closed = true;
        return (this.#destroyPromise ??= Addon.agentDestroy(this.#agent));
    }

    // -- Unsupported orthogonal Dispatcher methods -------------------
    // Architect N8: do NOT stub `request` / `stream` / `pipeline` —
    // undici's `Dispatcher` base provides default implementations that
    // route through our `dispatch()`. Only `connect` and `upgrade`
    // genuinely cannot be supported.
    //
    // (no overrides for request/stream/pipeline)

    connect(_options: unknown, _callback?: unknown): never {
        throw new NotSupportedError("connect() not implemented");
    }

    upgrade(_options: unknown, _callback?: unknown): Promise<never> {
        return Promise.reject(
            new NotSupportedError("upgrade() not implemented"),
        );
    }
}

// --- helpers ---------------------------------------------------------

function toError(err: unknown): Error {
    return err instanceof Error
        ? err
        : new Error(typeof err === "string" ? err : "Unknown error");
}

function encodeQuery(
    query: Record<string, unknown> | null | undefined,
): string {
    if (!query) return "";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            for (const item of v) params.append(k, String(item));
        } else {
            params.append(k, String(v));
        }
    }
    return params.toString();
}

export const Agent: AgentConstructor = AgentImpl;
export const hello = (): string => Addon.hello();
// NOTE: `DispatchController` and `kSetRequestHandle` are NOT exported
// from the public surface (Architect I2). Users see the interface via
// `handler.onRequestStart(controller, ...)`.
```

## Security

The TLS / proxy controls in `AgentOptions` are sharp tools.

- **No automatic response-size cap.** Use `maxResponseSize` to cap, or
  count bytes in `onResponseData` and `controller.abort()` if exceeded.
  (Security I10.)
- **`rejectUnauthorized: false` / `rejectInvalidHostnames: false`** emit
  a `console.warn` at agent construction (Security C3). They disable
  CA-chain / hostname verification — vulnerable to MITM. Tests only.
- **`tls.ca`** must be PEM text. DER buffers are rejected. Caps:
  ≤ 256 KiB per entry, ≤ 32 entries total. (Security C4.)
- **Header validation** at the TS layer: names must match RFC 7230
  token; values must not contain CR / LF / NUL. Errors do not echo
  header bytes. (Security C5.)
- **`proxy.token`** is passed to reqwest as Basic-Auth via
  `Proxy::http(...).basic_auth(...)` (Security I3). Never concatenated
  into the proxy URI. `proxy.token` and `proxy.headers` are never
  logged.
- **`localAddress`** is validated as an IPv4/IPv6 literal at the TS
  layer (`net.isIP`) before crossing FFI. (Security I9.)

## Errors

`RequestAbortedError.name === "AbortError"` — matches undici and the
DOM AbortController contract. Downstream `Promise.race` / `.catch` code
that switches on `err.name === "AbortError"` keeps working.

## Tests

### packages/node/tests/vitest/dispatch-integration.test.ts

Each test wraps `expect` in try/catch inside the dispatch Promise so
assertion failures surface as test failures (not unhandled rejections).
A shared `afterEach` tears down agent + server.

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { TextEncoder } from "node:util";

import { Agent } from "../../export/agent.ts";

// --- shared fixtures -------------------------------------------------

let server: Server | null = null;
let agent: InstanceType<typeof Agent> | null = null;

async function startServer(
    handler: Parameters<typeof createServer>[0],
): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, r));
    return (server!.address() as { port: number }).port;
}

afterEach(async () => {
    if (agent) {
        await agent.destroy().catch(() => undefined);
        agent = null;
    }
    if (server) {
        await new Promise<void>((r) => server!.close(() => r()));
        server = null;
    }
});

// Helper: run a dispatch and resolve/reject on terminal callbacks.
function runDispatch(
    options: Parameters<InstanceType<typeof Agent>["dispatch"]>[0],
    callbacks: {
        onResponseStart?: (code: number, headers: unknown) => void;
        onResponseData?: (chunk: Buffer) => void;
        onResponseEnd?: () => void;
        onRequestStart?: (controller: { abort: (e: Error) => void }) => void;
    },
): Promise<{ chunks: Buffer[]; statusCode: number | null }> {
    const chunks: Buffer[] = [];
    let statusCode: number | null = null;
    return new Promise((resolve, reject) => {
        agent!.dispatch(options, {
            onRequestStart: (controller) => {
                try {
                    callbacks.onRequestStart?.(controller);
                } catch (e) {
                    reject(e);
                }
            },
            onResponseStart: (_c, code, headers) => {
                try {
                    statusCode = code;
                    callbacks.onResponseStart?.(code, headers);
                } catch (e) {
                    reject(e);
                }
            },
            onResponseData: (_c, chunk) => {
                try {
                    chunks.push(chunk);
                    callbacks.onResponseData?.(chunk);
                } catch (e) {
                    reject(e);
                }
            },
            onResponseEnd: () => {
                try {
                    callbacks.onResponseEnd?.();
                    resolve({ chunks, statusCode });
                } catch (e) {
                    reject(e);
                }
            },
            onResponseError: (_c, err) => reject(err),
        });
    });
}

// --- core happy paths ------------------------------------------------

describe("E2E Dispatch Integration", () => {
    beforeEach(() => {
        agent = new Agent();
    });

    it("completes a real HTTP request", async () => {
        const port = await startServer((_, res) => {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("hello world");
        });
        const { chunks, statusCode } = await runDispatch(
            { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
            {},
        );
        expect(statusCode).toBe(200);
        expect(Buffer.concat(chunks).toString()).toBe("hello world");
    });

    it("handles empty response body", async () => {
        const port = await startServer((_, res) => {
            res.writeHead(204);
            res.end();
        });
        const { chunks, statusCode } = await runDispatch(
            { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
            {},
        );
        expect(statusCode).toBe(204);
        expect(Buffer.concat(chunks).length).toBe(0);
    });

    it("encodes query parameters via URLSearchParams", async () => {
        const port = await startServer((req, res) => {
            const url = new URL(req.url!, "http://127.0.0.1");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    q: url.searchParams.get("q"),
                    special: url.searchParams.get("special&key"),
                }),
            );
        });
        const { chunks } = await runDispatch(
            {
                origin: `http://127.0.0.1:${port}`,
                path: "/search",
                method: "GET",
                query: { q: "hello world", "special&key": "value=1" },
            },
            {},
        );
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            q: string;
            special: string;
        };
        expect(body.q).toBe("hello world");
        expect(body.special).toBe("value=1");
    });

    it("streams a request body", async () => {
        const port = await startServer((req, res) => {
            let len = 0;
            req.on("data", (c: Buffer) => (len += c.length));
            req.on("end", () => {
                res.writeHead(200);
                res.end(`Received ${len} bytes`);
            });
        });

        const testData = "A".repeat(10 * 1024);
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new TextEncoder().encode(testData));
                c.close();
            },
        });

        const { chunks } = await runDispatch(
            {
                origin: `http://127.0.0.1:${port}`,
                path: "/upload",
                method: "POST",
                body,
            },
            {},
        );
        expect(Buffer.concat(chunks).toString()).toContain("10240 bytes");
    });
});

// --- aborts / signals ------------------------------------------------

describe("E2E Aborts", () => {
    beforeEach(() => {
        agent = new Agent();
    });

    it("aborts mid-request via controller", async () => {
        const port = await startServer((_, res) => {
            setTimeout(() => {
                res.writeHead(200);
                res.end("late");
            }, 5_000);
        });

        const err = await new Promise<Error>((resolve, reject) => {
            agent!.dispatch(
                { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
                {
                    onRequestStart: (controller) => {
                        setTimeout(
                            () => controller.abort(new Error("User abort")),
                            50,
                        );
                    },
                    onResponseError: (_c, e) => resolve(e),
                    onResponseEnd: () =>
                        reject(new Error("expected abort, got end")),
                },
            );
        });
        expect(err.message).toBe("User abort");
    });

    it("AbortSignal already aborted at dispatch time", async () => {
        const port = await startServer((_, res) => res.end("nope"));
        const ac = new AbortController();
        ac.abort(new Error("pre-aborted"));

        const err = await new Promise<Error>((resolve) => {
            agent!.dispatch(
                {
                    origin: `http://127.0.0.1:${port}`,
                    path: "/",
                    method: "GET",
                    signal: ac.signal,
                },
                { onResponseError: (_c, e) => resolve(e) },
            );
        });
        expect(err.message).toBe("pre-aborted");
    });

    it("server disconnects mid-response emits disconnect event", async () => {
        const port = await startServer((_, res) => {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.write("partial");
            res.socket?.destroy();
        });

        let disconnectEmitted = false;
        agent!.on("disconnect", () => {
            disconnectEmitted = true;
        });

        await new Promise<void>((resolve) => {
            agent!.dispatch(
                { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
                {
                    onResponseError: () => resolve(),
                    onResponseEnd: () => resolve(),
                },
            );
        });
        expect(disconnectEmitted).toBe(true);
    });

    it("agent.close() while in-flight resolves outstanding request", async () => {
        const port = await startServer((_, res) => {
            setTimeout(() => res.end("done"), 1_000);
        });
        const inFlight = new Promise<void>((resolve, reject) => {
            agent!.dispatch(
                { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
                {
                    onResponseEnd: () => resolve(),
                    onResponseError: () => resolve(), // close-mid-flight surfaces an error — both OK
                },
            );
            setTimeout(() => {
                agent!.close().catch(reject);
            }, 50);
        });
        await inFlight;
    });

    it("100 concurrent dispatches; abort half; state stays consistent", async () => {
        const port = await startServer((_, res) => {
            setTimeout(() => res.end("ok"), 100);
        });

        const results: Array<"ok" | "abort" | "err"> = [];
        const promises: Promise<void>[] = [];
        for (let i = 0; i < 100; i++) {
            promises.push(
                new Promise<void>((resolve) => {
                    agent!.dispatch(
                        {
                            origin: `http://127.0.0.1:${port}`,
                            path: "/",
                            method: "GET",
                        },
                        {
                            onRequestStart: (controller) => {
                                if (i % 2 === 0) {
                                    setTimeout(
                                        () => controller.abort(new Error("x")),
                                        10,
                                    );
                                }
                            },
                            onResponseEnd: () => {
                                results.push("ok");
                                resolve();
                            },
                            onResponseError: (_c, e) => {
                                results.push(e.message === "x" ? "abort" : "err");
                                resolve();
                            },
                        },
                    );
                }),
            );
        }
        await Promise.all(promises);
        expect(results.length).toBe(100);
        expect(results.filter((r) => r === "abort").length).toBeGreaterThan(0);
    });
});

// --- redirects / headers / TLS / size --------------------------------

describe("E2E Options", () => {
    it("honors maxRedirections (0 = no follow by default)", async () => {
        const port = await startServer((_, res) => {
            res.writeHead(302, { Location: "/elsewhere" });
            res.end();
        });
        agent = new Agent();

        const { statusCode } = await runDispatch(
            { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
            {},
        );
        expect(statusCode).toBe(302);
    });

    it("handles throwOnError for 404", async () => {
        const port = await startServer((_, res) => {
            res.writeHead(404);
            res.end("Not Found");
        });
        agent = new Agent();

        const err = await new Promise<Error>((resolve) => {
            agent!.dispatch(
                {
                    origin: `http://127.0.0.1:${port}`,
                    path: "/",
                    method: "GET",
                    throwOnError: true,
                },
                { onResponseError: (_c, e) => resolve(e) },
            );
        });
        expect(err.message).toContain("404");
    });

    it("preserves multi-value response headers (Set-Cookie)", async () => {
        const port = await startServer((_, res) => {
            res.writeHead(200, { "Set-Cookie": ["a=1", "b=2"] });
            res.end();
        });
        agent = new Agent();

        const setCookie = await new Promise<unknown>((resolve, reject) => {
            agent!.dispatch(
                { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
                {
                    onResponseStart: (_c, _code, headers) => {
                        try {
                            resolve(
                                (
                                    headers as Record<
                                        string,
                                        string | string[]
                                    >
                                )["set-cookie"],
                            );
                        } catch (e) {
                            reject(e);
                        }
                    },
                    onResponseEnd: () => undefined,
                    onResponseError: (_c, e) => reject(e),
                },
            );
        });
        expect(Array.isArray(setCookie)).toBe(true);
        expect(setCookie).toEqual(["a=1", "b=2"]);
    });

    it("rejects CRLF in request header values", () => {
        agent = new Agent();
        expect(() =>
            agent!.dispatch(
                {
                    origin: "http://127.0.0.1:1",
                    path: "/",
                    method: "GET",
                    headers: { "x-bad": "value\r\nX-Evil: 1" },
                },
                { onResponseError: () => undefined },
            ),
        ).toThrow(/invalid header value/);
    });

    it("TLS error with self-signed cert", async () => {
        // Generate a throwaway cert in-memory via `selfsigned`. No
        // on-disk fixtures.
        const { generate } = await import("selfsigned");
        const { cert, private: key } = generate(
            [{ name: "commonName", value: "localhost" }],
            { keySize: 2048, algorithm: "sha256" },
        );
        const { createServer } = await import("node:https");
        const server = createServer({ cert, key }, (_, res) => {
            res.writeHead(200);
            res.end("ok");
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const port = (server.address() as AddressInfo).port;

        agent = new Agent(); // default rejectUnauthorized: true

        const err = await new Promise<Error>((resolve) => {
            agent!.dispatch(
                { origin: `https://127.0.0.1:${port}`, path: "/", method: "GET" },
                {
                    onResponseError: (_c, e) => resolve(e),
                    onResponseEnd: () =>
                        resolve(new Error("expected TLS error")),
                },
            );
        });
        await new Promise<void>((r) => server.close(() => r()));
        expect(err).toBeInstanceOf(SocketError);
    });

    it("trusts a CA passed via tls.ca", async () => {
        const { generate } = await import("selfsigned");
        const { cert, private: key } = generate(
            [{ name: "commonName", value: "localhost" }],
            { keySize: 2048, algorithm: "sha256" },
        );
        // ... start server with cert, build Agent({ tls: { ca: [cert] } }),
        //     assert dispatch succeeds.
    });

    it("maxResponseSize caps decoded body", async () => {
        const port = await startServer((_, res) => {
            res.writeHead(200);
            res.end(Buffer.alloc(64 * 1024, "x"));
        });
        agent = new Agent({ maxResponseSize: 1024 });

        const err = await new Promise<Error>((resolve) => {
            agent!.dispatch(
                { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
                {
                    onResponseError: (_c, e) => resolve(e),
                    onResponseEnd: () =>
                        resolve(new Error("expected size error")),
                },
            );
        });
        expect(err.message.toLowerCase()).toContain("size");
    });
});
```

### packages/node/tests/contract/

Contract tests run against undici's *actual* fixture suite, pinned to
the same undici version declared in this repo's peer range. These live
in `tests/contract/` and are mirrored from
`undici/test/fixtures/` — purpose is to detect Dispatcher-spec drift.

```text
packages/node/tests/contract/
├── README.md                     # how fixtures are pinned & updated
├── dispatcher-contract.test.ts   # asserts our Agent against the spec
└── fixtures/                     # vendored from undici (pinned version)
```

## Summary

| Aspect                | Value                                                           |
| :-------------------- | :-------------------------------------------------------------- |
| **Public exports**    | `Agent`, `hello`, error classes — no controller class           |
| **Options shape**     | Flat top-level (undici-compatible) + grouped `tls`, `proxy`     |
| **Proxy default**     | `{ type: "system" }` (env-driven; documented diverge)           |
| **Body reader**       | Default `getReader()`, no BYOB                                  |
| **Handler order**     | `onRequestStart` first, then gating, then dispatch              |
| **Events**            | Synchronous emit (`connect` / `disconnect` / `connectionError`) |
| **`close`/`destroy`** | Idempotent (cached promise)                                     |
| **Signal listener**   | Removed in both `onResponseEnd` and `onResponseError`           |
| **Errors**            | `createUndiciError` wrap — `UND_ERR_*` codes preserved          |
| **Tests**             | Happy paths, aborts, options, contract suite                    |

## File Structure

```text
packages/node/
├── export/
│   ├── addon-def.ts
│   ├── agent-def.ts
│   ├── agent.ts
│   ├── dispatch-controller.ts   # internal — not re-exported
│   └── errors.ts
└── tests/
    ├── vitest/
    │   └── dispatch-integration.test.ts
    └── contract/
        ├── README.md
        ├── dispatcher-contract.test.ts
        └── fixtures/             # pinned from undici
```
