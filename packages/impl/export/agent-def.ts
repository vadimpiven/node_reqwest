// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { TcpNetConnectOpts as NetConnectionOptions } from 'node:net';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type * as undici from 'undici-types';

/**
 * Network connection and TLS settings.
 */
export interface ConnectionOptions
  extends Pick<
    undici.buildConnector.BuildOptions & NetConnectionOptions & TlsConnectionOptions,
    | 'allowH2'
    | 'ca'
    | 'cert'
    | 'keepAlive'
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
 * Configuration for automatic retries.
 */
export interface RetryOptions
  extends Pick<
    undici.RetryHandler.RetryOptions,
    | 'maxRetries'
    | 'maxTimeout'
    | 'methods'
    | 'minTimeout'
    | 'retryAfter'
    | 'statusCodes'
    | 'timeoutFactor'
  > {}

/**
 * Common configuration options for both simple and proxy agents.
 */
export interface BaseAgentOptions
  extends Pick<undici.Agent.Options, 'bodyTimeout' | 'headersTimeout' | 'keepAliveTimeout'> {
  /**
   * Configuration for automatic retries.
   */
  retry?: RetryOptions | number | null;
}

/**
 * Configuration for an agent without a proxy.
 */
export interface AgentOptions extends BaseAgentOptions {
  /**
   * Network connection and TLS settings.
   */
  connect?: ConnectionOptions | null;
}

/**
 * TLS options for the tunneled target request.
 */
export interface TunnelOptions
  extends Omit<ConnectionOptions, 'localAddress' | 'lookup' | 'servername' | 'socketPath'> {}

/**
 * Configuration for an agent that uses an upstream proxy.
 */
export interface ProxyAgentOptions
  extends BaseAgentOptions,
    Pick<undici.ProxyAgent.Options, 'headers' | 'proxyTunnel' | 'token' | 'uri'> {
  /**
   * TLS options for the proxy connection itself.
   */
  proxy?: ConnectionOptions | null;
  /**
   * TLS options for the tunneled target request.
   */
  request?: TunnelOptions | null;
}

/**
 * Factory for creating agents with specific configurations.
 */
export interface AgentFactory {
  /**
   * Creates an Agent fully compatible with the Node.js global fetch dispatcher.
   */
  makeAgent(options?: AgentOptions): undici.Dispatcher;

  /**
   * Creates a ProxyAgent fully compatible with the Node.js global fetch dispatcher.
   */
  makeProxyAgent(options: ProxyAgentOptions): undici.Dispatcher;
}
