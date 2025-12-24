import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type * as undici from 'undici-types';

/**
 * Network connection and TLS settings.
 */
export type ConnectionOptions = Pick<
  undici.buildConnector.BuildOptions & undici.Client.Options & TlsConnectionOptions,
  | 'allowH2'
  | 'ca'
  | 'cert'
  | 'keepAliveInitialDelay'
  | 'keepAliveTimeout'
  | 'key'
  | 'localAddress'
  | 'maxCachedSessions'
  | 'rejectUnauthorized'
  | 'timeout'
> & {
  /**
   * Whether to verify that the server's certificate identity matches the requested hostname.
   * This is a specialized check that can be disabled independently of CA chain verification.
   * @default true
   */
  rejectInvalidHostnames?: boolean;
};

/**
 * Configuration for an upstream proxy.
 */
type ProxyOptions =
  | {
      type: 'system';
    }
  | ({
      type: 'custom';
    } & Pick<undici.ProxyAgent.Options, 'headers' | 'token' | 'uri'>);

/**
 * Configuration options for the Agent.
 */
type AgentOptions = {
  /**
   * Network connection and TLS settings for direct or proxy tunnel connections.
   */
  connection?: ConnectionOptions | null;
  /**
   * Proxy configuration.
   */
  proxy?: ProxyOptions | null;
};

/**
 * Factory for creating agents with specific configurations.
 */
export interface Agent {
  /**
   * Creates an Agent fully compatible with the Node.js global fetch dispatcher.
   */
  new (options?: AgentOptions): undici.Dispatcher;
}
