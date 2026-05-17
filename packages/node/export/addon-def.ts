// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { ReadableStreamDefaultReader } from "node:stream/web";

import type { CoreErrorInfo } from "./errors.ts";

/** Proxy basic-auth credentials passed across the FFI. */
export type AgentProxyAuth = {
  username: string;
  password: string;
};

/** Proxy configuration accepted by the FFI. */
export type AgentProxyOption =
  | { type: "no-proxy" }
  | { type: "system" }
  | {
      type: "custom";
      uri: string;
      headers: Record<string, string>;
      auth: AgentProxyAuth | null;
    };

/**
 * Per-Agent configuration crossing the FFI at `agentCreate`. Every field is
 * either a primitive or `null` so the JSON shape stays stable. Timeouts are
 * milliseconds (`null` = no timeout); `0` is rejected by the Rust parser.
 */
export type AgentCreationOptions = {
  /** Allow HTTP/2 negotiation via ALPN. When false, force HTTP/1.1 only. */
  allowH2: boolean;
  /** Enable Happy-Eyeballs / `auto-select-family` semantics on connect. */
  autoSelectFamily: boolean;
  /** Default per-request body-idle timeout (ms between chunks). */
  bodyTimeout: number | null;
  /** Additional trust roots as PEM strings (max 32 entries, 256 KiB each). */
  ca: string[];
  /** TCP/TLS handshake timeout (ms). */
  connectTimeout: number | null;
  /** Default per-request headers timeout (ms from connect to first byte). */
  headersTimeout: number | null;
  /** Idle connection lifetime in the pool (ms). */
  keepAliveTimeout: number | null;
  /** Source IPv4/IPv6 address for outgoing sockets (string form). */
  localAddress: string | null;
  /** Max redirect hops (`0` = follow none, undici default). */
  maxRedirections: number;
  /** Cap on decoded response body in bytes (`null` = uncapped). */
  maxResponseSize: number | null;
  /** Upstream proxy (no-proxy / system / custom URI). */
  proxy: AgentProxyOption;
  /** Verify the server certificate hostname against the SAN. */
  rejectInvalidHostnames: boolean;
  /** Verify the server certificate chain against the trust store. */
  rejectUnauthorized: boolean;
  /** Total per-request deadline (ms) including connect, headers, and body. */
  timeout: number | null;
};

/**
 * Per-request dispatch options crossing the FFI. `maxRedirections` is not
 * per-request — undici 8 dropped it from `DispatchOptions`.
 */
export type AgentDispatchOptions = {
  /** Streaming reader path. Mutually exclusive with `bodyBytes` (fast path). */
  body: ReadableStreamDefaultReader<Uint8Array> | null;
  /** Materialized body bytes for non-streaming inputs. */
  bodyBytes: Uint8Array | null;
  /** Per-request body-idle timeout override (ms); `null` = use Agent default. */
  bodyTimeout: number | null;
  /** Lowercase-keyed, comma-joined request headers ready for the wire. */
  headers: Record<string, string>;
  /** Per-request headers timeout override (ms); `null` = use Agent default. */
  headersTimeout: number | null;
  /** HTTP method name (uppercased by the Rust parser). */
  method: string;
  /** Scheme + host + port (`https://example.com:8080`), no trailing slash. */
  origin: string;
  /** Request path beginning with `/` (no query string). */
  path: string;
  /** Pre-encoded query string without the leading `?`. */
  query: string;
};

/** Opaque handle for the Rust-side Agent. */
export interface AgentHandle {
  readonly _: unique symbol;
}

/** Opaque handle for an in-flight request. */
export interface RequestHandle {
  readonly _: unique symbol;
}

/**
 * Lifecycle callbacks installed once at Agent construction. Each call
 * receives the dispatch's `requestId` as the first argument; the JS side
 * routes by id to the per-request handler.
 */
export type DispatchCallbacks = {
  onResponseStart: (
    requestId: number,
    statusCode: number,
    headers: Record<string, string | string[]>,
    statusMessage: string,
  ) => void;
  onResponseData: (requestId: number, chunk: Uint8Array) => void;
  onResponseEnd: (requestId: number, trailers: Record<string, string | string[]>) => void;
  onResponseError: (requestId: number, error: CoreErrorInfo) => void;
};

export interface Addon {
  agentCreate(options: AgentCreationOptions, callbacks: DispatchCallbacks): AgentHandle;
  agentDispatch(
    agent: AgentHandle,
    options: AgentDispatchOptions,
    requestId: number,
  ): RequestHandle;
  agentClose(agent: AgentHandle): Promise<void>;
  agentDestroy(agent: AgentHandle): Promise<void>;

  requestHandleAbort(handle: RequestHandle): void;
  requestHandlePause(handle: RequestHandle): void;
  requestHandleResume(handle: RequestHandle): void;
}
