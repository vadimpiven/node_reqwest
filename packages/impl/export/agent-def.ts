import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type * as undici from 'undici-types';

/**
 * Network connection and TLS settings.
 */
export interface ConnectionOptions
  extends Pick<
    undici.buildConnector.BuildOptions & TlsConnectionOptions,
    | 'allowH2'
    | 'ca'
    | 'cert'
    | 'keepAlive'
    | 'keepAliveInitialDelay'
    | 'key'
    | 'rejectUnauthorized'
    | 'timeout'
  > {}

/**
 * Configuration for an upstream proxy.
 */
export interface ProxyOptions
  extends Pick<undici.ProxyAgent.Options, 'headers' | 'token' | 'uri'> {}

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
 * Configuration options for the Agent.
 */
export interface AgentOptions
  extends Pick<undici.Agent.Options, 'bodyTimeout' | 'headersTimeout' | 'keepAliveTimeout'> {
  /**
   * Network connection and TLS settings for direct or proxy tunnel connections.
   * @default null
   */
  connect?: ConnectionOptions | null;
  /**
   * Proxy configuration.
   * @default 'system'
   */
  proxy?: 'system' | ProxyOptions | null;
  /**
   * Configuration for automatic retries.
   * @default 3
   */
  retry?: number | RetryOptions | null;
}

/**
 * Factory for creating agents with specific configurations.
 */
export interface Agent {
  /**
   * Creates an Agent fully compatible with the Node.js global fetch dispatcher.
   */
  new (options?: AgentOptions): undici.Dispatcher;
}
