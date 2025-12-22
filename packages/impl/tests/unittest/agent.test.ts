// SPDX-License-Identifier: Apache-2.0 OR MIT

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errors, request } from 'undici';
import { afterEach, describe, expect, test } from 'vitest';
import { Agent as MockAgent } from './agent-mock.ts';

describe('Agent (Mock Implementation)', () => {
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

  test('Agent instantiation', () => {
    expect(() => new MockAgent()).not.toThrow();
  });

  test('agent should connect and receive data', async () => {
    const server = await buildServer((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end('hello world');
    });

    const dispatcher = new MockAgent();
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const { statusCode, headers, body } = await request(origin, { dispatcher });

    expect(statusCode).toBe(200);
    expect(headers['content-type']).toBe('text/plain');
    const text = await body.text();
    expect(text).toBe('hello world');

    await dispatcher.close();
  });

  test('Agent handles connect options (servername)', async () => {
    const server = await buildServer();
    const dispatcher = new MockAgent({
      connect: {
        servername: 'custom-server'
      }
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const { statusCode } = await request(origin, { dispatcher });
    expect(statusCode).toBe(200);

    await dispatcher.close();
  });

  test('Agent handles timeout options', async () => {
    const server = await buildServer((_req, res) => {
      setTimeout(() => res.end('ok'), 2000); // Wait long enough
    });

    const dispatcher = new MockAgent({
      headersTimeout: 100 // Test headers timeout to be faster
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    await expect(request(origin, { dispatcher })).rejects.toThrow(errors.HeadersTimeoutError);

    await dispatcher.destroy();
  });

  test('Agent handles close and destroy', async () => {
    const server = await buildServer();
    const dispatcher = new MockAgent();
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    await request(origin, { dispatcher });

    await dispatcher.close();

    await expect(request(origin, { dispatcher })).rejects.toThrow(errors.ClientDestroyedError);
  });
});
