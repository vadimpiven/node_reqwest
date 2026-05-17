// SPDX-License-Identifier: Apache-2.0 OR MIT

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { type Dispatcher, fetch, request, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../export/agent.ts";

let server: Server | null = null;
let agent: InstanceType<typeof Agent> | null = null;

async function startServer(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const srv = createServer(handler);
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

describe("Dispatcher contract — handler invocation order", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("invokes onRequestStart before onResponseStart, onResponseData, onResponseEnd", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    assert(agent);
    const ag = agent;

    const order: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ag.dispatch(
        { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
        {
          onRequestStart() {
            order.push("requestStart");
            return true;
          },
          onResponseStart() {
            order.push("responseStart");
            return true;
          },
          onResponseData() {
            order.push("responseData");
            return true;
          },
          onResponseEnd() {
            order.push("responseEnd");
            resolve();
            return true;
          },
          onResponseError(_c, e) {
            reject(e);
            return true;
          },
        },
      );
    });
    expect(order[0]).toBe("requestStart");
    expect(order[1]).toBe("responseStart");
    expect(order[order.length - 1]).toBe("responseEnd");
  });

  it("does not call onResponseStart on error before headers", async () => {
    assert(agent);
    const ag = agent;
    const order: string[] = [];
    await new Promise<void>((resolve) => {
      ag.dispatch(
        { origin: "http://127.0.0.1:1", path: "/", method: "GET" },
        {
          onRequestStart() {
            order.push("requestStart");
            return true;
          },
          onResponseStart() {
            order.push("responseStart");
            return true;
          },
          onResponseError() {
            order.push("responseError");
            resolve();
            return true;
          },
        },
      );
    });
    expect(order).toEqual(["requestStart", "responseError"]);
  });
});

describe("Dispatcher contract — undici sugar APIs delegate to dispatch", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("undici.request() works on top of our Agent", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: _req.url }));
    });
    assert(agent);

    const { statusCode, body } = await request(`http://127.0.0.1:${port}/hello`, {
      dispatcher: agent,
    });
    expect(statusCode).toBe(200);
    const json = (await body.json()) as { ok: boolean; path: string };
    expect(json.ok).toBe(true);
    expect(json.path).toBe("/hello");
  });

  it("undici.fetch() works on top of our Agent", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("via fetch");
    });
    assert(agent);

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      dispatcher: agent,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("via fetch");
  });

  it("setGlobalDispatcher() lets undici.request() use our Agent implicitly", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(202);
      res.end("accepted");
    });
    assert(agent);

    const install = setGlobalDispatcher as (d: Dispatcher) => Dispatcher;
    install(agent);
    const { statusCode } = await request(`http://127.0.0.1:${port}/`);
    expect(statusCode).toBe(202);
    // No explicit reset API; subsequent tests instantiate fresh agents.
  });
});

describe("Dispatcher contract — controller observable state", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("controller.aborted flips to true after abort()", async () => {
    const port = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 5_000);
    });
    assert(agent);
    const ag = agent;

    let observedAborted = false;
    await new Promise<void>((resolve) => {
      ag.dispatch(
        { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
        {
          onRequestStart(controller) {
            setTimeout(() => {
              controller.abort(new Error("user"));
              observedAborted = controller.aborted;
              resolve();
            }, 30);
            return true;
          },
          onResponseError() {
            return true;
          },
        },
      );
    });
    expect(observedAborted).toBe(true);
  });

  it("controller.reason carries the abort reason", async () => {
    const port = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end();
      }, 5_000);
    });
    assert(agent);
    const ag = agent;

    const reason = new Error("custom reason");
    let observedReason: Error | null = null;
    await new Promise<void>((resolve) => {
      ag.dispatch(
        { origin: `http://127.0.0.1:${port}`, path: "/", method: "GET" },
        {
          onRequestStart(controller) {
            setTimeout(() => {
              controller.abort(reason);
              observedReason = controller.reason;
              resolve();
            }, 30);
            return true;
          },
          onResponseError() {
            return true;
          },
        },
      );
    });
    expect(observedReason).toBe(reason);
  });
});
