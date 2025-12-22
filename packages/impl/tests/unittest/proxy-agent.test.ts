// SPDX-License-Identifier: Apache-2.0 OR MIT

import { once } from 'node:events';
import fs from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { errors, request } from 'undici';
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

  test('should handle proxy headers and token in non-tunneling mode', async () => {
    const proxy = await buildServer((req, res) => {
      expect(req.headers['x-proxy-header']).toBe('foo');
      expect(req.headers['proxy-authorization']).toBe('Bearer proxy-token');
      res.end('ok');
    });
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      proxyTunnel: false,
      headers: { 'X-Proxy-Header': 'foo' },
      token: 'Bearer proxy-token'
    });

    const { statusCode } = await request('http://localhost', { dispatcher });
    expect(statusCode).toBe(200);
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
    const proxy = await buildServer((req, res) => {
      // In non-tunneling mode, Agent sends absolute URL to proxy
      if (req.url?.includes('localhost')) {
        res.end('from proxy');
      } else {
        res.end('fail');
      }
    });

    const serverPort = (server.address() as AddressInfo).port;
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      proxyTunnel: false
    });

    const { body } = await request(`http://localhost:${serverPort}`, { dispatcher });
    expect(await body.text()).toBe('from proxy');
    await dispatcher.close();
  });

  test('should support basic auth in proxy URI', async () => {
    const proxy = await buildServer((req, res) => {
      const auth = req.headers['proxy-authorization'];
      if (auth === `Basic ${Buffer.from('user:pass').toString('base64')}`) {
        res.end('auth ok');
      } else {
        res.writeHead(401);
        res.end('auth fail');
      }
    });

    const proxyUrl = `http://user:pass@localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      proxyTunnel: false
    });

    const { statusCode, body } = await request('http://localhost', { dispatcher });
    expect(statusCode).toBe(200);
    expect(await body.text()).toBe('auth ok');
    await dispatcher.close();
  });

  test('should use proxyTunnel: true for CONNECT requests', async () => {
    const targetServer = await buildServer((_req, res) => {
      res.end('from target');
    });
    const targetPort = (targetServer.address() as AddressInfo).port;

    let connectCalled = false;
    const proxy = createServer();
    proxy.on('connect', (_req, clientSocket, head) => {
      connectCalled = true;
      const targetSocket = require('node:net').connect(targetPort, 'localhost', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        clientSocket.pipe(targetSocket).pipe(clientSocket);
      });
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    servers.push(proxy);

    const proxyPort = (proxy.address() as AddressInfo).port;
    const dispatcher = makeProxyAgent({
      uri: `http://127.0.0.1:${proxyPort}`,
      proxyTunnel: true
    });

    const { statusCode, body } = await request(`http://localhost:${targetPort}`, { dispatcher });
    expect(statusCode).toBe(200);
    expect(await body.text()).toBe('from target');
    expect(connectCalled).toBe(true);

    await dispatcher.close();
  });

  test('should default to proxyTunnel: true', async () => {
    const targetServer = await buildServer((_req, res) => {
      res.end('from target');
    });
    const targetPort = (targetServer.address() as AddressInfo).port;

    let connectCalled = false;
    const proxy = createServer();
    proxy.on('connect', (_req, clientSocket, head) => {
      connectCalled = true;
      const targetSocket = require('node:net').connect(targetPort, 'localhost', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        clientSocket.pipe(targetSocket).pipe(clientSocket);
      });
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    servers.push(proxy);

    const proxyPort = (proxy.address() as AddressInfo).port;
    const dispatcher = makeProxyAgent({
      uri: `http://127.0.0.1:${proxyPort}`
      // proxyTunnel is omitted, should default to true
    });

    const { statusCode } = await request(`http://localhost:${targetPort}`, { dispatcher });
    expect(statusCode).toBe(200);
    expect(connectCalled).toBe(true);

    await dispatcher.close();
  });

  test('should pass custom headers and token in CONNECT request (tunneling)', async () => {
    const targetServer = await buildServer((_req, res) => {
      res.end('ok');
    });
    const targetPort = (targetServer.address() as AddressInfo).port;

    let capturedHeaders: IncomingHttpHeaders | undefined;
    const proxy = createServer();
    proxy.on('connect', (req, clientSocket, head) => {
      capturedHeaders = req.headers;
      const targetSocket = require('node:net').connect(targetPort, 'localhost', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        clientSocket.pipe(targetSocket).pipe(clientSocket);
      });
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    servers.push(proxy);

    const proxyPort = (proxy.address() as AddressInfo).port;
    const dispatcher = makeProxyAgent({
      uri: `http://127.0.0.1:${proxyPort}`,
      proxyTunnel: true,
      headers: { 'x-my-proxy-header': 'foo' },
      token: 'Bearer my-proxy-token'
    });

    await request(`http://localhost:${targetPort}`, { dispatcher });

    expect(capturedHeaders?.['x-my-proxy-header']).toBe('foo');
    expect(capturedHeaders?.['proxy-authorization']).toBe('Bearer my-proxy-token');

    await dispatcher.close();
  });

  test('should respect headersTimeout in ProxyAgent', async () => {
    const proxy = await buildServer((_req, _res) => {
      // Never send headers
    });
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      proxyTunnel: false,
      headersTimeout: 100
    });

    await expect(request('http://localhost', { dispatcher })).rejects.toThrow(
      errors.HeadersTimeoutError
    );
    await dispatcher.destroy();
  });

  test('should respect retry in ProxyAgent', async () => {
    let counter = 0;
    const proxy = await buildServer((_req, res) => {
      if (counter < 1) {
        counter++;
        res.writeHead(502);
        res.end('bad gateway');
        return;
      }
      res.end('retry ok');
    });
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      proxyTunnel: false,
      retry: {
        maxRetries: 2,
        statusCodes: [502],
        minTimeout: 10
      }
    });

    const { body } = await request('http://localhost', { dispatcher });
    expect(await body.text()).toBe('retry ok');
    expect(counter).toBe(1);
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

  test('should support socketPath for proxy connection', async () => {
    if (process.platform === 'win32') return;

    const socketPath = path.join(os.tmpdir(), `proxy-${Date.now()}.sock`);
    const proxyServer = createServer((_req, res) => {
      res.end('from unix proxy');
    });
    proxyServer.listen(socketPath);
    await once(proxyServer, 'listening');

    const dispatcher = makeProxyAgent({
      uri: 'http://localhost',
      proxy: { socketPath },
      proxyTunnel: false
    });

    try {
      const { body } = await request('http://localhost', { dispatcher });
      expect(await body.text()).toBe('from unix proxy');
    } finally {
      await dispatcher.close();
      proxyServer.close();
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    }
  });

  test('should respect bodyTimeout in ProxyAgent', async () => {
    const proxy = await buildServer((_req, res) => {
      res.writeHead(200);
      res.write('part');
      // Never end
    });
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      proxyTunnel: false,
      bodyTimeout: 100
    });

    const { body } = await request('http://localhost', { dispatcher });
    await expect(body.text()).rejects.toThrow(errors.BodyTimeoutError);
    await dispatcher.destroy();
  });

  test('should throw if Proxy-Authorization is passed in request headers', async () => {
    const proxy = await buildServer();
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;
    const dispatcher = makeProxyAgent({ uri: proxyUrl });

    await expect(
      request('http://localhost', {
        dispatcher,
        headers: {
          'proxy-authorization': 'foo'
        }
      })
    ).rejects.toThrow('Proxy-Authorization should be sent in ProxyAgent');

    await dispatcher.close();
  });

  test('should accept URL object as uri', async () => {
    const proxy = await buildServer();
    const proxyUrl = new URL(`http://localhost:${(proxy.address() as AddressInfo).port}`);

    const dispatcher = makeProxyAgent({ uri: proxyUrl as unknown as string });
    expect(dispatcher).toBeDefined();
    await dispatcher.close();
  });

  test('should reuse connections with ProxyAgent (keep-alive)', async () => {
    const ports: number[] = [];
    const server = await buildServer((req, res) => {
      ports.push(req.socket.remotePort as number);
      res.end('ok');
    });
    const proxy = createServer();
    proxy.on('connect', (_req, clientSocket, head) => {
      const targetSocket = require('node:net').connect(
        (server.address() as AddressInfo).port,
        'localhost',
        () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          targetSocket.write(head);
          clientSocket.pipe(targetSocket).pipe(clientSocket);
        }
      );
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    servers.push(proxy);

    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;
    const dispatcher = makeProxyAgent({ uri: proxyUrl, proxyTunnel: true });

    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const res1 = await request(origin, { dispatcher });
    await res1.body.text();

    // Give some time for the connection to be returned to the pool
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res2 = await request(origin, { dispatcher });
    await res2.body.text();

    expect(ports.length).toBe(2);
    // Should reuse the same socket through the proxy tunnel
    expect(ports[0]).toBe(ports[1]);

    await dispatcher.close();
  });

  test('should respect keepAliveTimeout in ProxyAgent', async () => {
    const ports: number[] = [];
    const server = await buildServer((req, res) => {
      ports.push(req.socket.remotePort as number);
      res.end('ok');
    });
    const proxy = createServer();
    proxy.on('connect', (_req, clientSocket, head) => {
      const targetSocket = require('node:net').connect(
        (server.address() as AddressInfo).port,
        'localhost',
        () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          targetSocket.write(head);
          clientSocket.pipe(targetSocket).pipe(clientSocket);
        }
      );
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    servers.push(proxy);

    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;
    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      proxyTunnel: true,
      keepAliveTimeout: 50
    });

    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    await request(origin, { dispatcher });

    // Wait for keep-alive to expire
    await new Promise((resolve) => setTimeout(resolve, 600));

    const { statusCode: sc2 } = await request(origin, { dispatcher });
    expect(sc2).toBe(200);

    await dispatcher.close();
  });

  test('should support localAddress for ProxyAgent', async () => {
    const proxy = await buildServer((_req, res) => {
      res.end('ok');
    });
    const proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;

    const dispatcher = makeProxyAgent({
      uri: proxyUrl,
      proxyTunnel: false,
      proxy: {
        localAddress: '127.0.0.1'
      }
    });

    const { statusCode } = await request('http://localhost', { dispatcher });
    expect(statusCode).toBe(200);
    await dispatcher.close();
  });

  test('should support custom lookup for ProxyAgent', async () => {
    let lookupCalled = false;
    const proxy = await buildServer((_req, res) => {
      res.end('ok');
    });

    const dispatcher = makeProxyAgent({
      uri: 'http://custom.proxy.local',
      proxyTunnel: false,
      proxy: {
        lookup: (hostname, _options, callback) => {
          lookupCalled = true;
          if (hostname === 'custom.proxy.local') {
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
          } else {
            callback(new Error('not found'), []);
          }
        }
        // We need to override the port since common lookup doesn't return port,
        // but our lookup above returns 127.0.0.1 and we need to hit the proxy server port.
        // Actually undici's lookup callback doesn't support 'port'.
        // So we'll use a trick: we'll use the proxy server's port in the URI and 127.0.0.1 in lookup.
      }
    });

    // Re-create with correct port usage
    const proxyPort = (proxy.address() as AddressInfo).port;
    await dispatcher.close();

    const dispatcher2 = makeProxyAgent({
      uri: `http://custom.proxy.local:${proxyPort}`,
      proxyTunnel: false,
      proxy: {
        lookup: (hostname, _options, callback) => {
          lookupCalled = true;
          if (hostname === 'custom.proxy.local') {
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
          } else {
            callback(new Error('not found'), []);
          }
        }
      }
    });

    const { statusCode } = await request('http://localhost', { dispatcher: dispatcher2 });
    expect(statusCode).toBe(200);
    expect(lookupCalled).toBe(true);
    await dispatcher2.close();
  });
});
