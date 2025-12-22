// SPDX-License-Identifier: Apache-2.0 OR MIT

import {
  buildConnector,
  type Dispatcher,
  errors,
  Agent as UndiciAgent,
  ProxyAgent as UndiciProxyAgent,
  interceptors as undiciInterceptors
} from 'undici';
import type {
  AgentFactory,
  AgentOptions,
  ConnectionOptions,
  ProxyAgentOptions
} from '../../export/index.ts';

/**
 * Helper to prepare common options and retry logic.
 */
function prepare(options: AgentOptions | ProxyAgentOptions = {}) {
  const { bodyTimeout, headersTimeout, keepAliveTimeout, retry } = options;

  const commonDispatcherOptions = {
    bodyTimeout,
    headersTimeout,
    keepAliveTimeout
  };

  const getConnectorOptions = (opts?: ConnectionOptions | null) => {
    return {
      allowH2: opts?.allowH2,
      ca: opts?.ca,
      cert: opts?.cert,
      keepAlive: opts?.keepAlive,
      keepAliveInitialDelay: opts?.keepAliveInitialDelay,
      key: opts?.key,
      localAddress: opts?.localAddress,
      lookup: opts?.lookup,
      rejectUnauthorized: opts?.rejectUnauthorized,
      servername: opts?.servername,
      socketPath: opts?.socketPath,
      timeout: opts?.timeout
    };
  };

  const getConnector = (options?: ConnectionOptions | null) => {
    const merged = getConnectorOptions(options);
    if (Object.values(merged).every((v) => v === undefined)) {
      return undefined;
    }
    return buildConnector(merged);
  };

  const withRetry = (agent: Dispatcher) => {
    if (retry !== undefined && retry !== null) {
      const retryOptions =
        typeof retry === 'number'
          ? { maxRetries: retry }
          : {
              maxRetries: retry.maxRetries,
              maxTimeout: retry.maxTimeout,
              methods: retry.methods,
              minTimeout: retry.minTimeout,
              retryAfter: retry.retryAfter,
              statusCodes: retry.statusCodes,
              timeoutFactor: retry.timeoutFactor
            };
      return agent.compose(undiciInterceptors.retry(retryOptions));
    }
    return agent;
  };

  return { commonDispatcherOptions, getConnector, getConnectorOptions, withRetry };
}

/**
 * Implementation of makeAgent via undici.
 */
export const makeAgent = (options?: AgentOptions): Dispatcher => {
  const { commonDispatcherOptions, getConnector, withRetry } = prepare(options);

  const agent = new UndiciAgent({
    ...commonDispatcherOptions,
    allowH2: options?.connect?.allowH2 ?? undefined,
    connect: getConnector(options?.connect)
  });

  return withRetry(agent);
};

/**
 * Implementation of makeProxyAgent via undici.
 */
export const makeProxyAgent = (options: ProxyAgentOptions): Dispatcher => {
  const { uri, headers, proxyTunnel, token, proxy, request } = options;
  const { commonDispatcherOptions, getConnectorOptions, withRetry } = prepare(options);

  if (!uri) {
    throw new errors.InvalidArgumentError('Proxy uri is mandatory');
  }

  const agent = new UndiciProxyAgent({
    ...commonDispatcherOptions,
    allowH2: proxy?.allowH2,
    headers,
    proxyTunnel,
    token,
    uri,
    // Native undici ProxyAgent property names for TLS overrides
    proxyTls: getConnectorOptions(proxy),
    requestTls: getConnectorOptions(request),
    // We use a factory to ensure our Dispatcher settings are applied to tunneled connections
    factory: (_origin, opts) => {
      return new UndiciAgent({
        ...commonDispatcherOptions,
        allowH2: request?.allowH2,
        ...opts
      });
    }
  });

  return withRetry(agent);
};

export const MockAgentFactory: AgentFactory = {
  makeAgent,
  makeProxyAgent
};
