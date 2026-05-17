// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Parity tests: each scenario runs against `undici.Agent` AND our `Agent`
//! and asserts the same observable behavior. This is the strongest guard
//! against drift — if undici changes its error mapping or response shape,
//! the corresponding assertions break for both implementations, and we
//! find out before consumers do.

import assert from "node:assert/strict";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent as UndiciAgent, request as undiciRequest } from "undici";

import { Agent as ReqwestAgent } from "../../export/agent.ts";
import { dispatchOnce } from "../helpers/dispatch.ts";
import { startServer, type RunningServer } from "../helpers/server.ts";

// The two Agent constructors have disjoint option signatures, but the only
// shape parity tests use is the zero-arg constructor. `() => Dispatcher`
// is the actual interface we need from this table.
type AgentCtor = new () => UndiciAgent | ReqwestAgent;

const agents: ReadonlyArray<readonly [name: string, ctor: AgentCtor]> = [
  ["undici.Agent", UndiciAgent],
  ["node-reqwest.Agent", ReqwestAgent],
];

let server: RunningServer | null = null;
let agent: UndiciAgent | ReqwestAgent | null = null;

afterEach(async () => {
  await agent?.destroy().catch(() => undefined);
  agent = null;
  await server?.stop();
  server = null;
});

describe.each(agents)("Dispatcher parity — %s", (_name, Agent) => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("delivers a 200 GET with the exact response body", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello world");
    });
    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/",
      method: "GET",
    });
    expect(r.error).toBeNull();
    expect(r.status).toBe(200);
    expect(r.bytes.toString()).toBe("hello world");
  });

  it("emits HEAD with no body bytes", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "5" });
      res.end();
    });
    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/",
      method: "HEAD",
    });
    expect(r.error).toBeNull();
    expect(r.status).toBe(200);
    expect(r.bytes.length).toBe(0);
  });

  it("surfaces a connection failure for a refused port", async () => {
    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: "http://127.0.0.1:1",
      path: "/",
      method: "GET",
    });
    // Both implementations report SOMETHING actionable. The exact shape
    // differs by design: undici 8 surfaces the raw Node `ECONNREFUSED`
    // error directly, while we wrap it in `SocketError` to keep the typed
    // contract uniform across transports.
    expect(r.error).toBeInstanceOf(Error);
    const code = (r.error as NodeJS.ErrnoException).code ?? "";
    expect(code).toMatch(/^(ECONNREFUSED|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/);
  });

  it("preserves response headers as a lowercase-keyed object", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Custom": "yes",
      });
      res.end("{}");
    });
    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/",
      method: "GET",
    });
    expect(r.headers).toBeTruthy();
    assert(r.headers);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.headers["x-custom"]).toBe("yes");
  });

  it("returns multiple set-cookie headers as an array", async () => {
    server = await startServer((_req, res) => {
      res.setHeader("Set-Cookie", ["a=1", "b=2"]);
      res.writeHead(200);
      res.end();
    });
    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/",
      method: "GET",
    });
    assert(r.headers);
    expect(Array.isArray(r.headers["set-cookie"])).toBe(true);
    expect(r.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  });

  it("uploads a string body and reports correct length", async () => {
    server = await startServer((req, res) => {
      let len = 0;
      req.on("data", (c: Buffer) => {
        len += c.length;
      });
      req.on("end", () => {
        res.writeHead(200);
        res.end(String(len));
      });
    });
    const payload = "A".repeat(1024);
    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/upload",
      method: "POST",
      body: payload,
    });
    expect(r.error).toBeNull();
    expect(r.bytes.toString()).toBe(String(payload.length));
  });
});

// Parity at the consumer-API layer (`undici.request`) — the path that real
// applications use. Lets us verify identical behavior for scenarios that
// `dispatch()` itself handles differently between implementations (e.g.
// AbortSignal, which undici only honors at this layer).
describe.each(agents)("undici.request() parity — %s", (_name, Agent) => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("returns 200 with the response body", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hi");
    });
    assert(agent);
    const { statusCode, body } = await undiciRequest(`http://127.0.0.1:${server.port}/`, {
      dispatcher: agent,
    });
    expect(statusCode).toBe(200);
    expect(await body.text()).toBe("hi");
  });

  it("aborts a slow response via signal mid-flight", async () => {
    server = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 5_000);
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("mid-flight abort")), 25);

    assert(agent);
    await expect(
      undiciRequest(`http://127.0.0.1:${server.port}/`, {
        dispatcher: agent,
        signal: ac.signal,
      }),
    ).rejects.toThrow();
  });

  it("preserves response headers (lowercase keys)", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { "X-Custom": "ok" });
      res.end();
    });
    assert(agent);
    const { headers } = await undiciRequest(`http://127.0.0.1:${server.port}/`, {
      dispatcher: agent,
    });
    expect(headers["x-custom"]).toBe("ok");
  });
});
