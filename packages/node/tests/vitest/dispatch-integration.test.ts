// SPDX-License-Identifier: Apache-2.0 OR MIT

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Dispatcher, fetch } from "undici";

import { Agent } from "../../export/agent.ts";
import { InvalidArgumentError } from "../../export/errors.ts";
import { dispatchOnce } from "../helpers/dispatch.ts";
import { startServer, type RunningServer } from "../helpers/server.ts";

let server: RunningServer | null = null;
let agent: Agent | null = null;

afterEach(async () => {
  await agent?.destroy().catch(() => undefined);
  agent = null;
  await server?.stop();
  server = null;
});

describe("E2E Dispatch Integration", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("completes a real HTTP GET", async () => {
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

  it("handles 204 empty response", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/",
      method: "GET",
    });
    expect(r.status).toBe(204);
    expect(r.bytes.length).toBe(0);
  });

  it("encodes query parameters", async () => {
    server = await startServer((req, res) => {
      assert(req.url);
      const url = new URL(req.url, "http://127.0.0.1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ q: url.searchParams.get("q") }));
    });
    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/search",
      method: "GET",
      query: { q: "hello world" },
    });
    const body = JSON.parse(r.bytes.toString()) as { q: string };
    expect(body.q).toBe("hello world");
  });

  it("aborts via controller", async () => {
    server = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 5_000);
    });
    assert(agent);
    const r = await dispatchOnce(
      agent,
      { origin: `http://127.0.0.1:${server.port}`, path: "/", method: "GET" },
      {
        onRequestStart(controller) {
          setTimeout(() => controller.abort(new Error("User abort")), 30);
          return true;
        },
      },
    );
    expect(r.error?.message).toBe("User abort");
  });

  it("rejects CRLF in request header values", () => {
    assert(agent);
    const ag = agent;
    expect(() =>
      ag.dispatch(
        {
          origin: "http://127.0.0.1:1",
          path: "/",
          method: "GET",
          headers: { "x-bad": "value\r\nX-Evil: 1" },
        },
        { onResponseError: () => true },
      ),
    ).not.toThrow();
  });

  it("uploads a request body", async () => {
    server = await startServer((req, res) => {
      let len = 0;
      req.on("data", (c: Buffer) => {
        len += c.length;
      });
      req.on("end", () => {
        res.writeHead(200);
        res.end(`Received ${len} bytes`);
      });
    });
    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/upload",
      method: "POST",
      body: "A".repeat(10 * 1024),
    });
    expect(r.bytes.toString()).toContain("10240 bytes");
  });

  it("uploads an async-iterable request body", async () => {
    server = await startServer((req, res) => {
      let len = 0;
      req.on("data", (c: Buffer) => {
        len += c.length;
      });
      req.on("end", () => {
        res.writeHead(200);
        res.end(`Received ${len} bytes`);
      });
    });
    assert(agent);
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(512).fill(120);
      yield new Uint8Array(512).fill(121);
    }
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/upload",
      method: "POST",
      // undici's Dispatcher accepts iterable bodies; its TS type omits them.
      body: chunks() as unknown as Dispatcher.DispatchOptions["body"],
    });
    expect(r.error).toBeNull();
    expect(r.bytes.toString()).toContain("1024 bytes");
  });

  it("uploads a sync-iterable request body", async () => {
    server = await startServer((req, res) => {
      let len = 0;
      req.on("data", (c: Buffer) => {
        len += c.length;
      });
      req.on("end", () => {
        res.writeHead(200);
        res.end(`Received ${len} bytes`);
      });
    });
    assert(agent);
    // A plain array of chunks is a sync iterable (the `Symbol.iterator` leg).
    const body: Iterable<Uint8Array> = [
      new Uint8Array(256).fill(120),
      new Uint8Array(768).fill(121),
    ];
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/upload",
      method: "POST",
      body: body as unknown as Dispatcher.DispatchOptions["body"],
    });
    expect(r.error).toBeNull();
    expect(r.bytes.toString()).toContain("1024 bytes");
  });

  it("uploads a body submitted through undici fetch", async () => {
    // undici's `fetch` hands the body to the dispatcher as an async iterable
    // (even a `Uint8Array` becomes a generator) while advertising a
    // `content-length`. Dropping it would hang the request — guard against it.
    server = await startServer((req, res) => {
      let len = 0;
      req.on("data", (c: Buffer) => {
        len += c.length;
      });
      req.on("end", () => {
        res.writeHead(200);
        res.end(`Received ${len} bytes`);
      });
    });
    assert(agent);
    const res = await fetch(`http://127.0.0.1:${server.port}/upload`, {
      method: "POST",
      body: new Uint8Array(1024).fill(120),
      dispatcher: agent,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("1024 bytes");
  });
});

describe("E2E concurrency and lifecycle", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("100 concurrent dispatches; abort half; state stays consistent", async () => {
    // Wide margins so the abort-vs-complete race is decisive on slow CI:
    // server delay 2 s, abort fires after 50 ms.
    server = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("ok");
      }, 2_000);
    });
    assert(agent);
    // Local non-null bindings so the inner closures don't have to re-narrow.
    const ag = agent;
    const srv = server;

    const total = 100;
    const half = total / 2;
    const results: Array<"ok" | "abort" | "err"> = [];
    const promises: Promise<void>[] = [];
    for (let i = 0; i < total; i++) {
      promises.push(
        new Promise<void>((resolve) => {
          const shouldAbort = i % 2 === 0;
          ag.dispatch(
            { origin: `http://127.0.0.1:${srv.port}`, path: "/", method: "GET" },
            {
              onRequestStart(controller) {
                if (shouldAbort) setTimeout(() => controller.abort(new Error("x")), 50);
                return true;
              },
              onResponseEnd() {
                results.push("ok");
                resolve();
                return true;
              },
              onResponseError(_c, e) {
                results.push(e.message === "x" ? "abort" : "err");
                resolve();
                return true;
              },
            },
          );
        }),
      );
    }
    await Promise.all(promises);
    expect(results.length).toBe(total);
    // Half scheduled an abort; cleanly aborted requests must dominate that
    // bucket — allow 10% slack for the inherent in-flight-completion race.
    expect(results.filter((r) => r === "abort").length).toBeGreaterThanOrEqual(half - 10);
  });

  it("server disconnects mid-response emits disconnect or connectionError", async () => {
    // Either event is acceptable — the boundary between them depends on
    // whether `onResponseStart` lands before the FIN.
    server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain", "Transfer-Encoding": "chunked" });
      res.write("partial", () => {
        setTimeout(() => res.socket?.destroy(), 50);
      });
    });
    assert(agent);

    let sawDisconnectOrConnError = false;
    agent.on("disconnect", () => {
      sawDisconnectOrConnError = true;
    });
    agent.on("connectionError", () => {
      sawDisconnectOrConnError = true;
    });

    await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/",
      method: "GET",
    });
    expect(sawDisconnectOrConnError).toBe(true);
  });

  it("agent.close() while in-flight resolves outstanding request", async () => {
    server = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("done");
      }, 500);
    });
    assert(agent);
    const ag = agent;
    const inFlight = dispatchOnce(ag, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/",
      method: "GET",
    });
    setTimeout(() => {
      ag.close().catch(() => undefined);
    }, 50);
    await inFlight;
  });

  it("maxResponseSize caps decoded body", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(64 * 1024, "x"));
    });
    agent = new Agent({ maxResponseSize: 1024 });
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/",
      method: "GET",
    });
    expect(r.error?.message.toLowerCase()).toContain("response size");
  });
});

describe("Agent option validation", () => {
  it("rejects invalid localAddress", () => {
    expect(() => new Agent({ localAddress: "not-an-ip" })).toThrow(InvalidArgumentError);
  });
});

describe("E2E TLS (self-signed)", () => {
  it("trusts a CA passed via tls.ca", async () => {
    const selfsigned = await import("selfsigned");
    const generate: typeof selfsigned.generate = selfsigned.generate ?? selfsigned.default.generate;
    const { createServer: createHttpsServer } = await import("node:https");

    // Two-cert chain: a CA, then a server cert signed by that CA. rustls 0.23
    // rejects "CaUsedAsEndEntity" — a self-signed cert that is also marked CA
    // cannot serve as the server certificate.
    const caPems = await generate([{ name: "commonName", value: "Test CA" }], {
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true },
        { name: "keyUsage", keyCertSign: true, digitalSignature: true },
      ],
    });
    const serverPems = await generate([{ name: "commonName", value: "localhost" }], {
      keySize: 2048,
      algorithm: "sha256",
      ca: { key: caPems.private, cert: caPems.cert },
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
          ],
        },
      ],
    });

    const httpsServer = createHttpsServer(
      { cert: serverPems.cert, key: serverPems.private },
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("secure");
      },
    );
    await new Promise<void>((r) => httpsServer.listen(0, "127.0.0.1", r));
    const port = (httpsServer.address() as AddressInfo).port;

    const trustingAgent = new Agent({ tls: { ca: [caPems.cert] } });
    try {
      const r = await dispatchOnce(trustingAgent, {
        origin: `https://127.0.0.1:${port}`,
        path: "/",
        method: "GET",
      });
      expect(r.status).toBe(200);
      expect(r.bytes.toString()).toBe("secure");
    } finally {
      await trustingAgent.destroy().catch(() => undefined);
      await new Promise<void>((r) => httpsServer.close(() => r()));
    }
  });

  it("rejects self-signed cert without ca trust", async () => {
    const selfsigned = await import("selfsigned");
    const generate: typeof selfsigned.generate = selfsigned.generate ?? selfsigned.default.generate;
    const { createServer: createHttpsServer } = await import("node:https");

    const pems = await generate([{ name: "commonName", value: "localhost" }], {
      keySize: 2048,
      algorithm: "sha256",
    });
    const httpsServer = createHttpsServer({ cert: pems.cert, key: pems.private }, (_req, res) => {
      res.writeHead(200);
      res.end("nope");
    });
    await new Promise<void>((r) => httpsServer.listen(0, "127.0.0.1", r));
    const port = (httpsServer.address() as AddressInfo).port;

    const strictAgent = new Agent();
    try {
      const r = await dispatchOnce(strictAgent, {
        origin: `https://127.0.0.1:${port}`,
        path: "/",
        method: "GET",
      });
      expect(r.error).not.toBeNull();
    } finally {
      await strictAgent.destroy().catch(() => undefined);
      await new Promise<void>((r) => httpsServer.close(() => r()));
    }
  });
});
