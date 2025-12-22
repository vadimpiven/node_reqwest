// SPDX-License-Identifier: Apache-2.0 OR MIT

import {
  buildConnector,
  errors,
  Agent as UndiciAgent,
  ProxyAgent as UndiciProxyAgent
} from 'undici';
import type {
  AgentConstructor,
  AgentOptions,
  ConnectionOptions,
  ProxyOptions
} from '../../export/index.ts';

/**
 * Implementation of Agent via undici.
 * This is used for testing and as a reference implementation.
 */
export const Agent: AgentConstructor = function Agent(options?: AgentOptions) {
  const {
    allowH2,
    bodyTimeout,
    headersTimeout,
    interceptors,
    keepAliveTimeout,
    connect: connectOptions,
    proxy
  } = options ?? {};

  // Explicitly mapping all ConnectionOptions to ensure we don't miss any when merging
  const mapConnectionOptions = (opts?: ConnectionOptions | null) => {
    if (!opts) return {};
    const {
      allowH2: connAllowH2,
      ca,
      cert,
      keepAliveInitialDelay,
      key,
      localAddress,
      lookup,
      rejectUnauthorized,
      servername,
      socketPath,
      timeout
    } = opts;
    return {
      allowH2: connAllowH2,
      ca,
      cert,
      keepAliveInitialDelay,
      key,
      localAddress,
      lookup,
      rejectUnauthorized,
      servername,
      socketPath,
      timeout
    };
  };

  /**
   * Helper to create a connector with merged options.
   * connectOptions (from Agent level) acts as the base.
   * overrides (from Proxy level) can specialize it.
   */
  const getConnector = (overrides?: ConnectionOptions | null) => {
    const base = mapConnectionOptions(connectOptions);
    const extra = mapConnectionOptions(overrides);

    const merged = {
      allowH2, // Agent-level allowH2 is the default for the connector
      ...base,
      ...extra
    };

    // If no connection options are provided and allowH2 is undefined, use undici default
    if (Object.values(merged).every((v) => v === undefined)) {
      return undefined;
    }

    return buildConnector(merged);
  };

  // Common dispatcher options for UndiciAgent and UndiciProxyAgent
  const commonDispatcherOptions = {
    allowH2,
    bodyTimeout,
    headersTimeout,
    interceptors: interceptors ?? undefined,
    keepAliveTimeout
  };

  if (proxy) {
    let proxyOptions: ProxyOptions;
    if (typeof proxy === 'string') {
      proxyOptions = { uri: proxy };
    } else {
      proxyOptions = proxy;
    }

    const { uri, headers, token, proxyTls, requestTls } = proxyOptions;

    if (!uri) {
      throw new errors.InvalidArgumentError('Proxy uri is mandatory');
    }

    return new UndiciProxyAgent({
      ...commonDispatcherOptions,
      uri,
      headers: headers ?? undefined,
      token: token ?? undefined,
      // Connector for the connection to the proxy itself
      connect: getConnector(proxyTls),
      // Factory for creating the agent that handles connections through the proxy
      factory: (_origin, _opts) => {
        return new UndiciAgent({
          ...commonDispatcherOptions,
          // Connector for the tunneled connection to the target
          connect: getConnector(requestTls)
        });
      }
    });
  }

  return new UndiciAgent({
    ...commonDispatcherOptions,
    // Connector for direct connections
    connect: getConnector()
  });
} as unknown as AgentConstructor;
