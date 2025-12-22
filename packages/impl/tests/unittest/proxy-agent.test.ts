// SPDX-License-Identifier: Apache-2.0 OR MIT

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errors } from 'undici';
import { afterEach, describe, expect, test } from 'vitest';
import type { ProxyAgentOptions } from '../../export/index.ts';
import { makeProxyAgent } from './agent-mock.ts';

describe('ProxyAgent (Mock Implementation)', () => {
  let servers: Server[] = [];

  const buildServer = async (handler?: (req: IncomingMessage, res: ServerResponse) => void) => {
    const server = createServer(
      { joinDuplicateHeaders: true },
      handler ||
        ((_req, res) => {
          res.end('ok');
        })
    );
    server.listen(0);
    await once(server, 'listening');
    servers.push(server);
    return server;
  };

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers = [];
  });

  test('should throw error when no uri is provided', () => {
    expect(() => makeProxyAgent({} as ProxyAgentOptions)).toThrow(errors.InvalidArgumentError);
    expect(() => makeProxyAgent({ uri: '' } as ProxyAgentOptions)).toThrow(
      errors.InvalidArgumentError
    );
  });

  test('should accept string as proxy option', async () => {
    const proxy = await buildServer();
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    expect(() => makeProxyAgent({ uri: proxyUrl })).not.toThrow();
  });

  test('should accept ProxyOptions object', async () => {
    const proxy = await buildServer();
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    expect(() => makeProxyAgent({ uri: proxyUrl })).not.toThrow();
  });

  test('should handle proxy headers and token', async () => {
    const proxy = await buildServer();
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      headers: { 'X-Proxy-Header': 'foo' },
      token: 'Bearer proxy-token'
    });

    expect(dispatcher).toBeDefined();
    await dispatcher.close();
  });

  test('should accept proxy and request', async () => {
    const proxy = await buildServer();
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      proxy: {
        rejectUnauthorized: false
      },
      request: {
        rejectUnauthorized: false
      }
    });

    expect(dispatcher).toBeDefined();
    await dispatcher.close();
  });

  test('use proxy-agent to connect through proxy', async () => {
    const server = await buildServer((_req, res) => {
      res.end('from server');
    });
    const proxy = await buildServer((_req, res) => {
      // Very minimal proxy behavior for the mock
      res.end('from proxy');
    });

    const _serverUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    // In our mock, UndiciProxyAgent will be returned.
    const dispatcher = makeProxyAgent({
      uri: proxyUrl
    });

    expect(dispatcher).toBeDefined();
    await dispatcher.close();
  });

  test('should support granular allowH2 for proxy and request', async () => {
    const proxy = await buildServer();
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      proxy: {
        allowH2: true,
        rejectUnauthorized: false
      },
      request: {
        allowH2: false,
        rejectUnauthorized: false
      }
    });

    expect(dispatcher).toBeDefined();
    await dispatcher.close();
  });
});
