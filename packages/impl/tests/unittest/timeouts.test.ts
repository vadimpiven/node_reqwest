// SPDX-License-Identifier: Apache-2.0 OR MIT

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errors, request } from 'undici';
import { afterEach, describe, expect, test } from 'vitest';
import { makeAgent } from './agent-mock.ts';

describe('Agent Timeouts', () => {
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

  test('should handle headersTimeout', async () => {
    // Server that never sends headers
    const server = await buildServer((_req, _res) => {
      // Do nothing, just hang
    });

    const dispatcher = makeAgent({
      headersTimeout: 100
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    await expect(request(origin, { dispatcher })).rejects.toThrow(errors.HeadersTimeoutError);
    await dispatcher.destroy();
  });

  test('should handle bodyTimeout', async () => {
    // Server that sends headers but never completes body
    const server = await buildServer((_req, res) => {
      res.writeHead(200);
      res.write('part');
      // Never end
    });

    const dispatcher = makeAgent({
      bodyTimeout: 100
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const { body } = await request(origin, { dispatcher });
    await expect(body.text()).rejects.toThrow(errors.BodyTimeoutError);
    await dispatcher.destroy();
  });

  test('should support keepAliveTimeout', async () => {
    const ports: number[] = [];
    const server = await buildServer((req, res) => {
      ports.push(req.socket.remotePort as number);
      res.end('ok');
    });
    const dispatcher = makeAgent({
      keepAliveTimeout: 10
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const res1 = await request(origin, { dispatcher });
    await res1.body.text();

    // Wait for keep-alive to expire
    await new Promise((resolve) => setTimeout(resolve, 200));

    // After timeout, the connection should have been closed/re-created
    const res2 = await request(origin, { dispatcher });
    expect(res2.statusCode).toBe(200);

    await dispatcher.close();
  });
});
