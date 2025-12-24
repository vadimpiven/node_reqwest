import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type * as undici from 'undici-types';

/**
 * Network connection and TLS settings.
 */
export interface ConnectionOptions
  extends Pick<
    undici.buildConnector.BuildOptions & undici.Client.Options & TlsConnectionOptions,
    | 'allowH2'
    | 'bodyTimeout'
    | 'ca'
    | 'cert'
    | 'headersTimeout'
    | 'keepAlive'
    | 'keepAliveInitialDelay'
    | 'keepAliveTimeout'
    | 'key'
    | 'localAddress'
    | 'maxCachedSessions'
    | 'rejectUnauthorized'
    | 'servername'
    | 'timeout'
  > {
  /**
   * Whether to verify that the server's certificate identity matches the requested hostname.
   * This is a specialized check that can be disabled independently of CA chain verification.
   * @default true
   */
  rejectInvalidHostnames?: boolean;
  /**
   * Controls the use of certificates installed to the system store during certificate validation.
   * @default true
   */
  useSystemTlsRootCerts?: boolean;
}

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
export interface AgentOptions {
  /**
   * Network connection and TLS settings for direct or proxy tunnel connections.
   * @default null
   */
  connection?: ConnectionOptions | null;
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
