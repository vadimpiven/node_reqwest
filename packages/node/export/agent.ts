// SPDX-License-Identifier: Apache-2.0 OR MIT

import { validateHeaderName, validateHeaderValue } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { ReadableStreamDefaultReader } from "node:stream/web";

import { Dispatcher } from "undici";

import { Addon } from "./addon.ts";
import type {
  AgentCreationOptions,
  AgentDispatchOptions,
  AgentHandle,
  AgentProxyOption,
} from "./addon-def.ts";
import type { AgentOptions, ProxyOptions, TlsOptions } from "./agent-def.ts";
import { DispatchController, kSetRequestHandle } from "./dispatch-controller.ts";
import {
  ClientClosedError,
  ClientDestroyedError,
  type CoreErrorInfo,
  createUndiciError,
  InvalidArgumentError,
  NotSupportedError,
  RequestAbortedError,
} from "./errors.ts";

/** Cap for buffered Node `Readable` request bodies. Tunable per Agent. */
const DEFAULT_MAX_BUFFERED_REQUEST_BODY_BYTES = 100 * 1024 * 1024;

/** Wrap request ids before crossing the FFI to stay inside the Rust u32 range. */
const REQUEST_ID_WRAP = 0xffff_ffff;

/**
 * Coerce the `tls.ca` shape that undici accepts (`string | Buffer | array`)
 * into the flat string-array the FFI expects. Entry count and size caps are
 * enforced by the Rust side (rustls is the source of truth for PEM
 * validity).
 */
function normalizePem(pem?: string | Buffer | (string | Buffer)[]): string[] {
  if (!pem) return [];
  const list = Array.isArray(pem) ? pem : [pem];
  return list.map((entry) => (Buffer.isBuffer(entry) ? entry.toString("utf8") : entry));
}

type HeaderValue = string | string[] | number | undefined;
type HeaderInput =
  | Record<string, HeaderValue>
  | Iterable<[string, HeaderValue]>
  | string[]
  | null
  | undefined;

function normalizeHeaders(headers?: HeaderInput): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  const add = (key: string, value: HeaderValue): void => {
    if (value === undefined || value === null) return;
    const k = key.toLowerCase();
    validateHeaderName(k);
    // RFC 6265 §5.4: client-sent `Cookie` headers use a `; ` separator;
    // every other multi-value header concatenates with `, ` per RFC 9110 §5.3.
    const sep = k === "cookie" ? "; " : ", ";
    const v = Array.isArray(value) ? value.join(sep) : String(value);
    validateHeaderValue(k, v);
    const existing = out[k];
    out[k] = existing === undefined ? v : `${existing}${sep}${v}`;
  };
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key = headers[i];
      if (typeof key === "string") add(key, headers[i + 1] as HeaderValue);
    }
  } else if (Symbol.iterator in headers) {
    for (const [k, v] of headers as Iterable<[string, HeaderValue]>) add(k, v);
  } else {
    for (const [k, v] of Object.entries(headers)) add(k, v);
  }
  return out;
}

type BodyInput =
  | string
  | Buffer
  | Uint8Array
  | Readable
  | ReadableStream<Uint8Array>
  | null
  | undefined;

/** Exactly one of the three fields is non-null. */
type NormalizedBody = {
  bytes: Uint8Array | null;
  pendingBytes: Promise<Uint8Array> | null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
};

const EMPTY_BODY: NormalizedBody = { bytes: null, pendingBytes: null, reader: null };

function normalizeBodyDirect(body: string | Buffer | Uint8Array): NormalizedBody {
  if (typeof body === "string") {
    return { bytes: new Uint8Array(Buffer.from(body, "utf8")), pendingBytes: null, reader: null };
  }
  if (Buffer.isBuffer(body)) {
    return { bytes: new Uint8Array(body), pendingBytes: null, reader: null };
  }
  return { bytes: body, pendingBytes: null, reader: null };
}

// Eager drain (not pull-based): the per-chunk Rust↔JS round-trip path is
// 30 %+ slower than undici on small bodies, and Node `Readable` payloads
// are typically small. Callers needing true streaming hand us a
// `web.ReadableStream` instead.
function normalizeBodyBuffered(body: Readable, maxBufferedBytes: number): NormalizedBody {
  return { bytes: null, pendingBytes: drainReadable(body, maxBufferedBytes), reader: null };
}

function normalizeBodyStreaming(body: ReadableStream<Uint8Array>): NormalizedBody {
  return { bytes: null, pendingBytes: null, reader: body.getReader() };
}

function normalizeBody(body: BodyInput, maxBufferedBytes: number): NormalizedBody {
  if (body === undefined || body === null) return EMPTY_BODY;
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return normalizeBodyDirect(body);
  }
  if (body instanceof Readable) return normalizeBodyBuffered(body, maxBufferedBytes);
  if (body instanceof ReadableStream) return normalizeBodyStreaming(body);
  return EMPTY_BODY;
}

async function drainReadable(stream: Readable, maxBytes: number): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as ArrayBufferLike);
    total += buf.length;
    if (total > maxBytes) {
      // Abandon the stream rather than OOM. Larger payloads should use
      // `web.ReadableStream` (true streaming) or raise the cap.
      stream.destroy();
      throw new InvalidArgumentError(
        `request body exceeds ${maxBytes} bytes; use ReadableStream for streaming uploads`,
      );
    }
    parts.push(buf);
  }
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const part of parts) {
    part.copy(out, offset);
    offset += part.length;
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function encodeQuery(query: Record<string, unknown> | string | null | undefined): string {
  if (!query) return "";
  if (typeof query === "string") return new URLSearchParams(query).toString();
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

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  // Preserve the original value as `cause` so non-Error throws aren't lost.
  return new Error(typeof err === "string" ? err : "Unknown error", { cause: err });
}

function buildCreationOptions(options?: AgentOptions): AgentCreationOptions {
  const tls: TlsOptions = options?.tls ?? {};
  const rejectUnauthorized = tls.rejectUnauthorized ?? true;
  const rejectInvalidHostnames = tls.rejectInvalidHostnames ?? rejectUnauthorized;

  if (options?.localAddress !== undefined && options.localAddress !== null) {
    if (isIP(options.localAddress) === 0) {
      throw new InvalidArgumentError("localAddress must be a valid IPv4/IPv6 address");
    }
  }

  return {
    allowH2: options?.allowH2 ?? true,
    autoSelectFamily: true,
    bodyTimeout: options?.bodyTimeout ?? 300_000,
    ca: normalizePem(tls.ca),
    connectTimeout: options?.connectTimeout ?? 10_000,
    headersTimeout: options?.headersTimeout ?? 300_000,
    keepAliveTimeout: options?.keepAliveTimeout ?? 4_000,
    localAddress: options?.localAddress ?? null,
    maxRedirections: options?.maxRedirections ?? 0,
    maxResponseSize: options?.maxResponseSize ?? null,
    proxy: normalizeProxy(options?.proxy),
    rejectInvalidHostnames,
    rejectUnauthorized,
    timeout: null,
  };
}

function normalizeProxy(proxy: ProxyOptions | undefined): AgentProxyOption {
  if (!proxy || proxy === "none") {
    return { type: "no-proxy" };
  }
  if (proxy === "system" || proxy.type === "system") {
    return { type: "system" };
  }
  const customHeaders: Record<string, string> = {};
  if (proxy.headers) {
    for (const [k, v] of Object.entries(proxy.headers)) {
      const key = k.toLowerCase();
      validateHeaderName(key);
      const sep = key === "cookie" ? "; " : ", ";
      const value = Array.isArray(v) ? v.join(sep) : String(v);
      validateHeaderValue(key, value);
      customHeaders[key] = value;
    }
  }
  return {
    type: "custom",
    uri: proxy.uri,
    headers: customHeaders,
    auth: proxy.auth ? { username: proxy.auth.username, password: proxy.auth.password } : null,
  };
}

interface RequestState {
  controller: DispatchController;
  handler: Dispatcher.DispatchHandler;
  origin: URL;
  originKey: string;
  requestConnected: boolean;
  handlerErrored: boolean;
}

export class Agent extends Dispatcher {
  readonly #agent: AgentHandle;
  readonly #pending = new Map<number, RequestState>();
  readonly #maxBufferedRequestBodyBytes: number;
  #nextRequestId = 1;
  #closed = false;
  #destroyed = false;
  #closePromise: Promise<void> | null = null;
  #destroyPromise: Promise<void> | null = null;
  readonly #connectedOrigins = new Set<string>();

  constructor(options?: AgentOptions) {
    super();
    this.#maxBufferedRequestBodyBytes =
      options?.maxBufferedRequestBodyBytes ?? DEFAULT_MAX_BUFFERED_REQUEST_BODY_BYTES;
    this.#agent = Addon.agentCreate(buildCreationOptions(options), {
      onResponseStart: (id, statusCode, headers, statusMessage) => {
        const state = this.#pending.get(id);
        if (state !== undefined) {
          this.#dispatchOnResponseStart(state, statusCode, headers, statusMessage);
        }
      },
      onResponseData: (id, chunk) => {
        const state = this.#pending.get(id);
        if (state !== undefined) this.#dispatchOnResponseData(state, chunk);
      },
      onResponseEnd: (id, trailers) => {
        const state = this.#pending.get(id);
        this.#pending.delete(id);
        if (state !== undefined) this.#dispatchOnResponseEnd(state, trailers);
      },
      onResponseError: (id, errorInfo) => {
        const state = this.#pending.get(id);
        this.#pending.delete(id);
        if (state !== undefined) this.#dispatchOnResponseError(state, errorInfo);
      },
    });
  }

  #dispatchOnResponseStart(
    state: RequestState,
    statusCode: number,
    respHeaders: Record<string, string | string[]>,
    statusMessage: string,
  ): void {
    if (state.controller.aborted || state.handlerErrored) return;
    state.requestConnected = true;

    if (!this.#connectedOrigins.has(state.originKey)) {
      this.#connectedOrigins.add(state.originKey);
      this.emit("connect", state.origin, [this]);
    }

    // `undici.fetch` reads response headers from `controller.rawHeaders`
    // (Buffer pairs) only — populate eagerly so fetch sees them.
    const raw: Buffer[] = [];
    for (const name in respHeaders) {
      const value = respHeaders[name];
      if (Array.isArray(value)) {
        for (const v of value) raw.push(Buffer.from(name), Buffer.from(v));
      } else if (value !== undefined) {
        raw.push(Buffer.from(name), Buffer.from(value));
      }
    }
    state.controller.rawHeaders = raw;

    try {
      state.handler.onResponseStart?.(state.controller, statusCode, respHeaders, statusMessage);
    } catch (e) {
      this.#routeHandlerThrow(state, e);
    }
  }

  #dispatchOnResponseData(state: RequestState, chunk: Uint8Array): void {
    if (state.controller.aborted || state.handlerErrored) return;
    try {
      state.handler.onResponseData?.(
        state.controller,
        Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    } catch (e) {
      this.#routeHandlerThrow(state, e);
    }
  }

  #dispatchOnResponseEnd(state: RequestState, trailers: Record<string, string | string[]>): void {
    if (state.controller.aborted || state.handlerErrored) return;
    try {
      state.handler.onResponseEnd?.(state.controller, trailers);
    } catch (e) {
      this.#routeHandlerThrow(state, e);
    }
  }

  // `onResponseError` is the last-chance handler — a throw here has nowhere
  // to escalate, and propagating it through the FFI callback corrupts the
  // dispatcher state machine. Swallow silently.
  #safeOnResponseError(state: RequestState, err: Error): void {
    try {
      state.handler.onResponseError?.(state.controller, err);
    } catch {
      // intentionally swallowed
    }
  }

  #dispatchOnResponseError(state: RequestState, errorInfo: CoreErrorInfo): void {
    if (state.handlerErrored) return;

    if (state.controller.aborted && errorInfo.code === "UND_ERR_ABORTED") {
      this.#safeOnResponseError(
        state,
        state.controller.reason ?? new RequestAbortedError(),
      );
      return;
    }

    const err = createUndiciError(errorInfo);
    const isConnError =
      errorInfo.code === "UND_ERR_SOCKET" || errorInfo.code === "UND_ERR_CONNECT_TIMEOUT";
    // undici's `emit` is overloaded per-event with disjoint literal types, so
    // the dispatch can't be collapsed into a single call without re-erasing
    // the literal back to a union.
    if (isConnError) {
      if (state.requestConnected) {
        this.emit("disconnect", state.origin, [this], err);
      } else {
        this.emit("connectionError", state.origin, [this], err);
      }
    }

    this.#safeOnResponseError(state, err);
  }

  /** Dispatcher contract: a handler throw aborts and routes to `onResponseError`. */
  #routeHandlerThrow(state: RequestState, err: unknown): void {
    if (state.handlerErrored) return;
    state.handlerErrored = true;
    const e = toError(err);
    this.#safeOnResponseError(state, e);
    state.controller.abort(e);
  }

  #allocateRequestId(): number {
    const id = this.#nextRequestId;
    this.#nextRequestId = id >= REQUEST_ID_WRAP ? 1 : id + 1;
    return id;
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const controller = new DispatchController(Addon);

    try {
      handler.onRequestStart?.(controller, {});
    } catch (err) {
      handler.onResponseError?.(controller, toError(err));
      return true;
    }

    if (options.method === "CONNECT" || options.upgrade) {
      handler.onResponseError?.(
        controller,
        new NotSupportedError("CONNECT method and upgrade requests are not supported"),
      );
      return true;
    }
    // `destroy()` sets both flags — check destroyed first for the specific error.
    if (this.#destroyed) {
      handler.onResponseError?.(controller, new ClientDestroyedError());
      return true;
    }
    if (this.#closed) {
      handler.onResponseError?.(controller, new ClientClosedError());
      return true;
    }
    if (controller.aborted) {
      handler.onResponseError?.(controller, controller.reason ?? new RequestAbortedError());
      return true;
    }

    const bail = (error: Error): true => {
      handler.onResponseError?.(controller, error);
      return true;
    };

    if (!options.origin) return bail(new InvalidArgumentError("origin is required"));
    let origin: URL;
    try {
      origin = new URL(String(options.origin));
    } catch {
      return bail(new InvalidArgumentError("origin must be a valid URL"));
    }
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      return bail(new InvalidArgumentError(`origin scheme ${origin.protocol} is not http(s)`));
    }

    let normalizedBody: NormalizedBody;
    try {
      normalizedBody = normalizeBody(options.body as BodyInput, this.#maxBufferedRequestBodyBytes);
    } catch (e) {
      return bail(toError(e));
    }

    let headers: Record<string, string>;
    try {
      headers = normalizeHeaders(options.headers as HeaderInput);
    } catch (e) {
      return bail(toError(e));
    }

    const dispatchOptions: AgentDispatchOptions = {
      body: normalizedBody.reader,
      bodyBytes: normalizedBody.bytes,
      bodyTimeout: options.bodyTimeout ?? null,
      headers,
      headersTimeout: options.headersTimeout ?? null,
      method: options.method,
      origin: origin.origin,
      path: options.path,
      query: encodeQuery(options.query as Record<string, unknown> | string | null | undefined),
    };

    const requestId = this.#allocateRequestId();
    this.#pending.set(requestId, {
      controller,
      handler,
      origin,
      originKey: origin.origin,
      requestConnected: false,
      handlerErrored: false,
    });

    if (normalizedBody.pendingBytes) {
      // FFI call deferred until the Readable drains; DispatchController
      // buffers any abort/pause/resume issued in the meantime.
      normalizedBody.pendingBytes.then(
        (bytes) => {
          const fail = (error: Error): void => {
            this.#pending.delete(requestId);
            handler.onResponseError?.(controller, error);
          };
          if (controller.aborted) return fail(controller.reason ?? new RequestAbortedError());
          if (this.#destroyed) return fail(new ClientDestroyedError());
          if (this.#closed) return fail(new ClientClosedError());
          dispatchOptions.bodyBytes = bytes;
          this.#submitToFfi(dispatchOptions, requestId, controller, handler);
        },
        (err: unknown) => {
          this.#pending.delete(requestId);
          handler.onResponseError?.(controller, toError(err));
        },
      );
      return true;
    }

    this.#submitToFfi(dispatchOptions, requestId, controller, handler);
    return true;
  }

  /**
   * Routes synchronous FFI throws (e.g. header cap) through `onResponseError`
   * per the Dispatcher contract — `dispatch()` must never throw.
   */
  #submitToFfi(
    dispatchOptions: AgentDispatchOptions,
    requestId: number,
    controller: DispatchController,
    handler: Dispatcher.DispatchHandler,
  ): void {
    try {
      const handle = Addon.agentDispatch(this.#agent, dispatchOptions, requestId);
      controller[kSetRequestHandle](handle);
    } catch (err) {
      this.#pending.delete(requestId);
      handler.onResponseError?.(controller, toError(err));
    }
  }

  close(): Promise<void> {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.#closed = true;
    return (this.#closePromise ??= Addon.agentClose(this.#agent));
  }

  destroy(): Promise<void> {
    this.#destroyed = true;
    this.#closed = true;
    return (this.#destroyPromise ??= Addon.agentDestroy(this.#agent));
  }
}
