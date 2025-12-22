// SPDX-License-Identifier: Apache-2.0 OR MIT

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'undici';
import { afterEach, describe, expect, test } from 'vitest';
import { makeAgent } from './agent-mock.ts';

describe('Agent Retry Logic', () => {
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

  test('should retry on network error when retry is a number', async () => {
    let counter = 0;
    const server = await buildServer((req, res) => {
      if (counter === 0) {
        counter++;
        req.destroy();
        return;
      }
      res.end('recovered');
    });

    const dispatcher = makeAgent({
      retry: 3
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const { statusCode, body } = await request(origin, { dispatcher });
    expect(statusCode).toBe(200);
    expect(await body.text()).toBe('recovered');
    expect(counter).toBe(1);

    await dispatcher.close();
  });

  test('should retry on status code when statusCodes is provided', async () => {
    let counter = 0;
    const server = await buildServer((_req, res) => {
      if (counter < 2) {
        counter++;
        res.writeHead(502);
        res.end('bad gateway');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });

    const dispatcher = makeAgent({
      retry: {
        maxRetries: 3,
        statusCodes: [502],
        minTimeout: 10 // small timeout for fast tests
      }
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const { statusCode, body } = await request(origin, { dispatcher });
    expect(statusCode).toBe(200);
    expect(await body.text()).toBe('ok');
    expect(counter).toBe(2);

    await dispatcher.close();
  });

  test('should respect retryAfter header (numeric)', async () => {
    let counter = 0;
    let firstRequestTime = 0;
    const server = await buildServer((_req, res) => {
      if (counter === 0) {
        counter++;
        firstRequestTime = Date.now();
        res.writeHead(429, { 'retry-after': '1' });
        res.end('too many requests');
        return;
      }
      res.end('ok');
    });

    const dispatcher = makeAgent({
      retry: {
        maxRetries: 1,
        statusCodes: [429]
      }
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const { statusCode } = await request(origin, { dispatcher });
    const secondRequestTime = Date.now();

    expect(statusCode).toBe(200);
    // Should have waited at least 1 second
    expect(secondRequestTime - firstRequestTime).toBeGreaterThanOrEqual(1000);

    await dispatcher.close();
  });

  test('should respect retryAfter header (date string)', async () => {
    let counter = 0;
    let firstRequestTime = 0;
    const server = await buildServer((_req, res) => {
      if (counter === 0) {
        counter++;
        firstRequestTime = Date.now();
        // Set retry-after to 2 seconds from now
        const retryDate = new Date(firstRequestTime + 2000).toUTCString();
        res.writeHead(429, { 'retry-after': retryDate });
        res.end('too many requests');
        return;
      }
      res.end('ok');
    });

    const dispatcher = makeAgent({
      retry: {
        maxRetries: 1,
        statusCodes: [429]
      }
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const { statusCode } = await request(origin, { dispatcher });
    const secondRequestTime = Date.now();

    expect(statusCode).toBe(200);
    // Should have waited at least 1 second (lenient for CI)
    expect(secondRequestTime - firstRequestTime).toBeGreaterThanOrEqual(1000);

    await dispatcher.close();
  });

  test('should NOT retry on non-idempotent methods by default', async () => {
    let counter = 0;
    const server = await buildServer((req, _res) => {
      counter++;
      req.destroy();
    });

    const dispatcher = makeAgent({
      retry: 3
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    await expect(
      request(origin, {
        dispatcher,
        method: 'POST',
        body: 'foo'
      })
    ).rejects.toThrow();

    // Should have only attempted once
    expect(counter).toBe(1);

    await dispatcher.close();
  });

  test('should retry on specified methods', async () => {
    let counter = 0;
    const server = await buildServer((req, res) => {
      if (counter === 0) {
        counter++;
        req.destroy();
        return;
      }
      res.end('posted');
    });

    const dispatcher = makeAgent({
      retry: {
        maxRetries: 3,
        methods: ['POST']
      }
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const { statusCode, body } = await request(origin, {
      dispatcher,
      method: 'POST',
      body: 'foo'
    });

    expect(statusCode).toBe(200);
    expect(await body.text()).toBe('posted');
    expect(counter).toBe(1);

    await dispatcher.close();
  });

  test('should respect maxTimeout and timeoutFactor in retry options', async () => {
    let counter = 0;
    const timestamps: number[] = [];
    const server = await buildServer((_req, res) => {
      timestamps.push(Date.now());
      if (counter < 2) {
        counter++;
        res.writeHead(502);
        res.end('bad gateway');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });

    const dispatcher = makeAgent({
      retry: {
        maxRetries: 2,
        statusCodes: [502],
        minTimeout: 100,
        maxTimeout: 200,
        timeoutFactor: 2
      }
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const { statusCode } = await request(origin, { dispatcher });
    expect(statusCode).toBe(200);

    // First retry should be after ~100ms
    // Second retry should be after min(100 * 2, 200) = 200ms
    const delay1 = timestamps[1] - timestamps[0];
    const delay2 = timestamps[2] - timestamps[1];

    expect(delay1).toBeGreaterThanOrEqual(90); // Lenient for CI
    expect(delay2).toBeGreaterThanOrEqual(180); // Lenient for CI

    await dispatcher.close();
  });

  test('should not retry when maxRetries is 0', async () => {
    let counter = 0;
    const server = await buildServer((req, _res) => {
      counter++;
      req.destroy();
    });

    const dispatcher = makeAgent({
      retry: 0
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    await expect(request(origin, { dispatcher })).rejects.toThrow();
    expect(counter).toBe(1);

    await dispatcher.close();
  });

  test('should NOT respect retryAfter header when retryAfter option is false', async () => {
    let counter = 0;
    let firstRequestTime = 0;
    const server = await buildServer((_req, res) => {
      if (counter === 0) {
        counter++;
        firstRequestTime = Date.now();
        res.writeHead(429, { 'retry-after': '1' });
        res.end('too many requests');
        return;
      }
      res.end('ok');
    });

    const dispatcher = makeAgent({
      retry: {
        maxRetries: 1,
        statusCodes: [429],
        retryAfter: false,
        minTimeout: 10
      }
    });
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const { statusCode } = await request(origin, { dispatcher });
    const secondRequestTime = Date.now();

    expect(statusCode).toBe(200);
    // Should NOT have waited 1 second, but still should have waited minTimeout (10ms)
    expect(secondRequestTime - firstRequestTime).toBeLessThan(500);

    await dispatcher.close();
  });
});
