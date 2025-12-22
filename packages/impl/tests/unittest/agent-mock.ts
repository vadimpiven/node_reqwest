// SPDX-License-Identifier: Apache-2.0 OR MIT

import {
  buildConnector,
  type Dispatcher,
  errors,
  Agent as UndiciAgent,
  ProxyAgent as UndiciProxyAgent
} from 'undici';
import type { AgentConstructor, AgentOptions, ConnectionOptions } from '../../export/index.ts';

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

  let agent: Dispatcher;
  if (proxy) {
    const uri = typeof proxy === 'string' ? proxy : proxy.uri;
    if (!uri) {
      throw new errors.InvalidArgumentError('Proxy uri is mandatory');
    }

    const proxyOptions = typeof proxy === 'object' ? proxy : { uri };
    agent = new UndiciProxyAgent({
      ...commonDispatcherOptions,
      uri,
      headers: proxyOptions.headers ?? undefined,
      token: proxyOptions.token ?? undefined,
      connect: getConnector(proxyOptions.proxyTls),
      factory: (_origin, _opts) => {
        return new UndiciAgent({
          ...commonDispatcherOptions,
          connect: getConnector(proxyOptions.requestTls)
        });
      }
    });
  } else {
    agent = new UndiciAgent({
      ...commonDispatcherOptions,
      connect: getConnector()
    });
  }

  if (Array.isArray(interceptors) && interceptors.length > 0) {
    // Reverse the interceptors so the first one in the array runs first.
    // In Undici's .compose(), the last interceptor passed is the outermost.
    return agent.compose([...interceptors].reverse());
  }

  return agent;
} as unknown as AgentConstructor;
