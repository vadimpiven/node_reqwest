// SPDX-License-Identifier: Apache-2.0 OR MIT

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Dispatcher, interceptors, request } from 'undici';
import { afterEach, describe, expect, test } from 'vitest';
import { Agent as MockAgent } from './agent-mock.ts';

describe('Agent Interceptors', () => {
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

  test('should support basic interceptors as array', async () => {
    const server = await buildServer();
    let intercepted = 0;
    const dispatcher = new MockAgent({
      // @ts-expect-error - testing array interceptors which mock handles
      interceptors: [
        (dispatch: Dispatcher.Dispatch) => {
          return (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {
            intercepted++;
            return dispatch(opts, handler);
          };
        }
      ]
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    await request(origin, { dispatcher });
    expect(intercepted).toBe(1);
    await dispatcher.close();
  });

  test('should support multiple interceptors in correct order', async () => {
    const server = await buildServer();
    const order: string[] = [];
    const dispatcher = new MockAgent({
      // @ts-expect-error - testing array interceptors
      interceptors: [
        (dispatch: Dispatcher.Dispatch) =>
          (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {
            order.push('first');
            return dispatch(opts, handler);
          },
        (dispatch: Dispatcher.Dispatch) =>
          (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {
            order.push('second');
            return dispatch(opts, handler);
          }
      ]
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    await request(origin, { dispatcher });
    expect(order).toEqual(['first', 'second']);
    await dispatcher.close();
  });

  test('should support built-in redirect interceptor', async () => {
    const server = await buildServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(302, { location: '/redirected' });
        res.end();
      } else {
        res.end('final');
      }
    });

    const dispatcher = new MockAgent({
      // @ts-expect-error - testing built-in interceptor in array
      interceptors: [interceptors.redirect({ maxRedirections: 5 })]
    });

    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    const { body } = await request(origin, { dispatcher });
    expect(await body.text()).toBe('final');
    await dispatcher.close();
  });
});
