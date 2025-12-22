// SPDX-License-Identifier: Apache-2.0 OR MIT

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'undici';
import { afterEach, describe, expect, test } from 'vitest';
import { makeAgent } from './agent-mock.ts';

describe('Agent Keep-Alive Option', () => {
  let servers: Server[] = [];

  const buildServer = async (handler?: (req: IncomingMessage, res: ServerResponse) => void) => {
    const server = createServer({ joinDuplicateHeaders: true }, handler);
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

  test('should not reuse connections when keepAlive is false', async () => {
    const ports: number[] = [];
    const server = await buildServer((req, res) => {
      ports.push(req.socket.remotePort as number);
      res.end('ok');
    });

    const dispatcher = makeAgent({
      connect: {
        keepAlive: false
      }
    });

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res1 = await request(origin, { dispatcher });
    await res1.body.text();
    const res2 = await request(origin, { dispatcher });
    await res2.body.text();

    expect(ports.length).toBe(2);
    // When keepAlive is false, it uses different sockets
    expect(ports[0]).not.toBe(ports[1]);

    await dispatcher.close();
  });

  test('should reuse connections by default', { retry: 3 }, async () => {
    const ports: number[] = [];
    const server = await buildServer((req, res) => {
      ports.push(req.socket.remotePort as number);
      res.end('ok');
    });

    const dispatcher = makeAgent();
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res1 = await request(origin, { dispatcher });
    await res1.body.text();

    // Give some time for the connection to be returned to the pool
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res2 = await request(origin, { dispatcher });
    await res2.body.text();

    expect(ports.length).toBe(2);
    // When keepAlive is true, it SHOULD use same sockets
    expect(ports[0]).toBe(ports[1]);

    await dispatcher.close();
  });
});
