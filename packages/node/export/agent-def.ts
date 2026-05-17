// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";

/** TLS settings for direct connections. Subset that reqwest supports. */
export type TlsOptions = Pick<TlsConnectionOptions, "ca" | "rejectUnauthorized"> & {
  /** Verify the server certificate hostname. @default true */
  rejectInvalidHostnames?: boolean;
};

/** Basic-auth credentials for an upstream proxy. */
export type ProxyAuth = {
  username: string;
  password: string;
};

/**
 * Upstream proxy configuration.
 *
 * Two shorthands sidestep the discriminated-union noise for the common cases:
 * - `"none"` — disable proxy resolution entirely.
 * - `"system"` — honor `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` from env.
 *
 * Use the object form for explicit URIs, headers, or basic-auth credentials.
 */
export type ProxyOptions =
  | "none"
  | "system"
  | { type: "system" }
  | {
      type: "custom";
      uri: string;
      headers?: Record<string, string | string[]>;
      auth?: ProxyAuth;
    };

/** Agent configuration. All options have undici-compatible defaults. */
export type AgentOptions = {
  /** Time to wait for response headers. @default 300_000 ms */
  headersTimeout?: number;
  /** Time to wait between body chunks. @default 300_000 ms */
  bodyTimeout?: number;
  /** TCP connect timeout. @default 10_000 ms */
  connectTimeout?: number;
  /** Idle keep-alive timeout. @default 4_000 ms */
  keepAliveTimeout?: number;
  /**
   * Max redirect hops. **Default is `0`** to match undici. `fetch()` performs
   * its own redirect handling; raw `request()`/`dispatch()` callers must set
   * this to follow redirects.
   */
  maxRedirections?: number;
  /** Cap on decoded body in bytes. @default unlimited */
  maxResponseSize?: number;
  /** Cap on buffered Node `Readable` request bodies in bytes. @default 100 MiB */
  maxBufferedRequestBodyBytes?: number;
  /** Allow HTTP/2. @default true */
  allowH2?: boolean;
  /** Source IP for outgoing connections. */
  localAddress?: string;
  /** TLS settings. */
  tls?: TlsOptions;
  /** Proxy configuration. */
  proxy?: ProxyOptions;
};
