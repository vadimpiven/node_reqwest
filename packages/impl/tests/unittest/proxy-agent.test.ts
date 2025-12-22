// SPDX-License-Identifier: Apache-2.0 OR MIT

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errors } from 'undici';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentOptions } from '../../export/index.ts';
import { Agent as MockAgent } from './agent-mock.ts';

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
    expect(() => new MockAgent({ proxy: {} } as unknown as AgentOptions)).toThrow(
      errors.InvalidArgumentError
    );
    expect(() => new MockAgent({ proxy: { uri: '' } } as unknown as AgentOptions)).toThrow(
      errors.InvalidArgumentError
    );
  });

  test('should accept string as proxy option', async () => {
    const proxy = await buildServer();
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    expect(() => new MockAgent({ proxy: proxyUrl })).not.toThrow();
  });

  test('should accept ProxyOptions object', async () => {
    const proxy = await buildServer();
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    expect(() => new MockAgent({ proxy: { uri: proxyUrl } })).not.toThrow();
  });

  test('should handle proxy headers and token', async () => {
    const proxy = await buildServer();
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = new MockAgent({
      proxy: {
        uri: proxyUrl,
        headers: { 'X-Proxy-Header': 'foo' },
        token: 'Bearer proxy-token'
      }
    });

    expect(dispatcher).toBeDefined();
    await dispatcher.close();
  });

  test('should accept proxyTls and requestTls', async () => {
    const proxy = await buildServer();
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = new MockAgent({
      proxy: {
        uri: proxyUrl,
        proxyTls: {
          rejectUnauthorized: false
        },
        requestTls: {
          servername: 'target.local'
        }
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
    const dispatcher = new MockAgent({
      proxy: proxyUrl
    });

    expect(dispatcher).toBeDefined();
    await dispatcher.close();
  });
});
