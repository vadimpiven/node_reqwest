// SPDX-License-Identifier: Apache-2.0 OR MIT

import {
  buildConnector,
  type Dispatcher,
  errors,
  Agent as UndiciAgent,
  Pool as UndiciPool,
  ProxyAgent as UndiciProxyAgent,
  type RetryHandler as UndiciRetryHandler,
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
      const retryOptions: UndiciRetryHandler.RetryOptions =
        typeof retry === 'number'
          ? { maxRetries: retry }
          : {
              maxRetries: retry.maxRetries,
              maxTimeout: retry.maxTimeout,
              methods: retry.methods as Dispatcher.HttpMethod[],
              minTimeout: retry.minTimeout,
              retryAfter: retry.retryAfter,
              statusCodes: retry.statusCodes,
              timeoutFactor: retry.timeoutFactor
            };

      // Workaround for undici ignoring retryAfter: false in its default retry function
      if (typeof retry !== 'number' && retry.retryAfter === false) {
        retryOptions.retry = (
          err: Error & { statusCode?: number; code?: string; headers?: Record<string, string> },
          { state, opts }: UndiciRetryHandler.RetryContext,
          cb: UndiciRetryHandler.OnRetryCallback
        ) => {
          const { statusCode, code } = err;
          const { method, retryOptions: ro } = opts;
          const { counter } = state;
          const {
            maxRetries = 5,
            minTimeout = 500,
            maxTimeout = 30000,
            timeoutFactor = 2,
            statusCodes = [500, 502, 503, 504, 429],
            errorCodes = [
              'ECONNRESET',
              'ECONNREFUSED',
              'ENOTFOUND',
              'ENETDOWN',
              'ENETUNREACH',
              'EHOSTDOWN',
              'EHOSTUNREACH',
              'EPIPE',
              'UND_ERR_SOCKET'
            ],
            methods: allowedMethods = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']
          } = ro ?? {};

          if (code && code !== 'UND_ERR_REQ_RETRY' && !errorCodes.includes(code)) {
            return cb(err);
          }
          if (allowedMethods && !allowedMethods.includes(method as Dispatcher.HttpMethod)) {
            return cb(err);
          }
          if (statusCode != null && statusCodes && !statusCodes.includes(statusCode)) {
            return cb(err);
          }
          if (counter > maxRetries) {
            return cb(err);
          }

          // Ignore Retry-After header
          const retryTimeout = Math.min(minTimeout * timeoutFactor ** (counter - 1), maxTimeout);
          setTimeout(() => cb(null), retryTimeout);
        };
      }

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
    // We use a factory to ensure our Dispatcher settings are applied to connections
    factory: (origin, opts) => {
      return new UndiciPool(origin, {
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
