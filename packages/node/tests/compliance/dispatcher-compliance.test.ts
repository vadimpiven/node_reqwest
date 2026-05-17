// SPDX-License-Identifier: Apache-2.0 OR MIT
//
// Behavioral mirror of `external/undici/test/node-test/client-dispatch.js`,
// adapted so the assertions run against our Agent. Each `it()` is named
// after the corresponding case in undici's suite; private-symbol probes
// and CONNECT/upgrade tests are intentionally not mirrored — see
// `tests/compliance/README.md`.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../export/agent.ts";

let server: Server | null = null;
let agent: InstanceType<typeof Agent> | null = null;

async function startServer(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const srv = createServer({ joinDuplicateHeaders: true }, handler);
  server = srv;
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  assert(addr && typeof addr !== "string", "server listening on AF_INET");
  return (addr as AddressInfo).port;
}

afterEach(async () => {
  if (agent) {
    await agent.destroy().catch(() => undefined);
    agent = null;
  }
  if (server) {
    const srv = server;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    server = null;
  }
});

describe("undici Dispatcher contract — dispatch()", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  // Mirrors: test('basic dispatch get')
  it("basic dispatch get — fires onConnect/onHeaders/onData/onComplete in order", async () => {
    const port = await startServer((req, res) => {
      expect(req.url).toBe("/");
      expect(req.method).toBe("GET");
      expect(req.headers.host).toBe(`127.0.0.1:${port}`);
      // undefined / null header values are dropped on the way out (we coerce
      // them to skipped entries during normalizeHeaders).
      expect(req.headers.foo).toBeUndefined();
      expect(req.headers.bar).toBe("bar");
      expect(req.headers["content-length"]).toBeUndefined();
      res.end("hello");
    });
    assert(agent);
    const ag = agent;

    const bufs: Buffer[] = [];
    const events: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ag.dispatch(
        {
          origin: `http://127.0.0.1:${port}`,
          path: "/",
          method: "GET",
          // `undefined` is typed-permitted by undici's `UndiciHeaders`; we
          // expect such entries to be filtered out before the wire.
          headers: { foo: undefined, bar: "bar" },
        },
        {
          onRequestStart() {
            events.push("onRequestStart");
            return true;
          },
          onResponseStart(_c, statusCode) {
            events.push("onResponseStart");
            expect(statusCode).toBe(200);
            return true;
          },
          onResponseData(_c, buf) {
            bufs.push(buf);
            return true;
          },
          onResponseEnd() {
            events.push("onResponseEnd");
            resolve();
            return true;
          },
          onResponseError(_c, err) {
            reject(err);
            return true;
          },
        },
      );
    });
    expect(Buffer.concat(bufs).toString()).toBe("hello");
    expect(events).toEqual(["onRequestStart", "onResponseStart", "onResponseEnd"]);
  });

  // Mirrors: test('dispatch onResponseStart error')
  it("dispatch onResponseStart error — handler throw routes to onResponseError", async () => {
    const port = await startServer((_req, res) => res.end("hello"));
    assert(agent);
    const ag = agent;
    const thrown = new Error("response start boom");
    const err = await new Promise<Error>((resolve) => {
      ag.dispatch(
        { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
        {
          onResponseStart() {
            throw thrown;
          },
          onResponseError(_c, e) {
            resolve(e);
            return true;
          },
        },
      );
    });
    expect(err).toBe(thrown);
  });

  // Mirrors: test('dispatch onResponseEnd error')
  it("dispatch onResponseEnd error — terminal handler throw still routes back to onResponseError", async () => {
    const port = await startServer((_req, res) => res.end("hello"));
    assert(agent);
    const ag = agent;
    const thrown = new Error("response end boom");
    const err = await new Promise<Error>((resolve) => {
      ag.dispatch(
        { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
        {
          onResponseEnd() {
            throw thrown;
          },
          onResponseError(_c, e) {
            resolve(e);
            return true;
          },
        },
      );
    });
    expect(err).toBe(thrown);
  });

  // Mirrors: test('dispatch onResponseData error')
  it("dispatch onResponseData error — per-chunk throw aborts and surfaces error", async () => {
    const port = await startServer((_req, res) => res.end(Buffer.alloc(64, "a")));
    assert(agent);
    const ag = agent;
    const thrown = new Error("response data boom");
    const err = await new Promise<Error>((resolve) => {
      ag.dispatch(
        { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
        {
          onResponseData() {
            throw thrown;
          },
          onResponseError(_c, e) {
            resolve(e);
            return true;
          },
        },
      );
    });
    expect(err).toBe(thrown);
  });

  // Mirrors: test('dispatch onRequestStart error')
  it("dispatch onRequestStart error — pre-flight throw routes to onResponseError without sending the request", async () => {
    let serverWasHit = false;
    const port = await startServer((_req, res) => {
      serverWasHit = true;
      res.end("hello");
    });
    assert(agent);
    const ag = agent;
    const thrown = new Error("request start boom");
    const err = await new Promise<Error>((resolve) => {
      ag.dispatch(
        { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
        {
          onRequestStart() {
            throw thrown;
          },
          onResponseError(_c, e) {
            resolve(e);
            return true;
          },
        },
      );
    });
    expect(err).toBe(thrown);
    expect(serverWasHit).toBe(false);
  });
});

describe("undici Dispatcher contract — undici consumer APIs through our Agent", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("undici.request() resolves with the spec-shaped response", async () => {
    const { request: undiciRequest } = await import("undici");
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello");
    });
    assert(agent);
    const { statusCode, headers, body } = await undiciRequest(`http://127.0.0.1:${port}/`, {
      dispatcher: agent,
    });
    expect(statusCode).toBe(200);
    expect(typeof headers["content-type"]).toBe("string");
    expect(await body.text()).toBe("hello");
  });

  it("undici.fetch() observes the WHATWG Response contract", async () => {
    const { fetch } = await import("undici");
    const port = await startServer((_req, res) => {
      // `Content-Type` is a CORS-safelisted response header per WHATWG
      // Fetch, so it survives the spec's header filtering regardless of
      // request mode. We use it as a stable cross-cors test.
      res.writeHead(202, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("created");
    });
    assert(agent);
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      dispatcher: agent,
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("created");
  });
});
