// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { TcpNetConnectOpts as NetConnectionOptions } from 'node:net';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type * as undici from 'undici-types';

/**
 * Low-level network connection options (TLS, TCP, Unix sockets).
 */
export interface ConnectionOptions
  extends Pick<
    undici.buildConnector.BuildOptions & NetConnectionOptions & TlsConnectionOptions,
    | 'allowH2'
    | 'ca'
    | 'cert'
    | 'keepAliveInitialDelay'
    | 'key'
    | 'localAddress'
    | 'lookup'
    | 'rejectUnauthorized'
    | 'servername'
    | 'socketPath'
    | 'timeout'
  > {}

/**
 * Upstream proxy configuration.
 */
export interface ProxyOptions extends Pick<undici.ProxyAgent.Options, 'headers' | 'token' | 'uri'> {
  /**
   * TLS options for the proxy connection itself.
   */
  proxyTls?: ConnectionOptions | null;
  /**
   * TLS options for the tunneled target request.
   */
  requestTls?: ConnectionOptions | null;
}

/**
 * Configuration options for the Agent, narrowed to features supported by the reqwest.
 */
export interface AgentOptions
  extends Pick<
    undici.Agent.Options,
    'allowH2' | 'bodyTimeout' | 'headersTimeout' | 'interceptors' | 'keepAliveTimeout'
  > {
  /**
   * Network connection and TLS settings.
   */
  connect?: ConnectionOptions | null;
  /**
   * Upstream proxy configuration.
   */
  proxy?: ProxyOptions | string | null;
}

/**
 * Constructor for an Agent fully compatible with the Node.js global fetch dispatcher.
 */
export type AgentConstructor = new (options?: AgentOptions) => undici.Dispatcher;
