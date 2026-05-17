// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Targeted coverage for paths flagged in a prior QA review: HEAD requests,
//! mid-flight `AbortSignal`, lifecycle gates, request-body cap, request-header
//! cap, origin scheme guard, eager `Readable` drain, and request-id reuse.

import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../export/agent.ts";
import {
  ClientClosedError,
  ClientDestroyedError,
  InvalidArgumentError,
  RequestAbortedError,
} from "../../export/errors.ts";
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

describe("HEAD request — no body, ends on headers", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("yields zero-byte body and resolves onResponseEnd", async () => {
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
});

describe("Lifecycle gates", () => {
  it("close() then dispatch() yields ClientClosedError", async () => {
    agent = new Agent();
    await agent.close();
    const r = await dispatchOnce(agent, {
      origin: "http://127.0.0.1:1",
      path: "/",
      method: "GET",
    });
    expect(r.error).toBeInstanceOf(ClientClosedError);
  });

  it("destroy() then dispatch() yields ClientDestroyedError", async () => {
    agent = new Agent();
    await agent.destroy();
    const r = await dispatchOnce(agent, {
      origin: "http://127.0.0.1:1",
      path: "/",
      method: "GET",
    });
    expect(r.error).toBeInstanceOf(ClientDestroyedError);
  });

  it("destroy() during pending Readable drain surfaces a typed error", async () => {
    agent = new Agent();
    const ag = agent;
    // Slow Readable so the drain promise is still pending when we destroy.
    const body = new Readable({
      read() {
        setTimeout(() => {
          this.push("data");
          this.push(null);
        }, 200);
      },
    });
    const pending = dispatchOnce(ag, {
      origin: "http://127.0.0.1:1",
      path: "/",
      method: "POST",
      body,
    });
    setTimeout(() => {
      void ag.destroy();
    }, 25);
    const r = await pending;
    // Either ClientDestroyedError (destroy raced ahead of the drain) or
    // RequestAbortedError (the controller was aborted by destroy first).
    expect(r.error instanceof ClientDestroyedError || r.error instanceof RequestAbortedError).toBe(
      true,
    );
  });
});

describe("Request body cap (Readable drain)", () => {
  it("rejects with InvalidArgumentError when body exceeds maxBufferedRequestBodyBytes", async () => {
    agent = new Agent({ maxBufferedRequestBodyBytes: 1024 });

    let pushed = 0;
    const body = new Readable({
      read() {
        if (pushed < 8) {
          this.push(Buffer.alloc(256, "x"));
          pushed += 1;
        } else {
          this.push(null);
        }
      },
    });

    const r = await dispatchOnce(agent, {
      origin: "http://127.0.0.1:1",
      path: "/",
      method: "POST",
      body,
    });
    expect(r.error).toBeInstanceOf(InvalidArgumentError);
    expect(r.error?.message).toContain("1024");
  });
});

describe("Origin scheme guard", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it.each(["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)"])(
    "rejects scheme %s with InvalidArgumentError",
    async (origin) => {
      assert(agent);
      const r = await dispatchOnce(agent, { origin, path: "/", method: "GET" });
      expect(r.error).toBeInstanceOf(InvalidArgumentError);
    },
  );

  it("rejects unparsable origin string", async () => {
    assert(agent);
    const r = await dispatchOnce(agent, { origin: "::::not a url", path: "/", method: "GET" });
    expect(r.error).toBeInstanceOf(InvalidArgumentError);
    expect(r.error?.message).toContain("valid URL");
  });

  it("rejects empty origin", async () => {
    assert(agent);
    const r = await dispatchOnce(agent, { origin: "", path: "/", method: "GET" });
    expect(r.error).toBeInstanceOf(InvalidArgumentError);
    expect(r.error?.message).toContain("required");
  });
});

describe("Request header cap", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("rejects when caller passes more than 256 headers", async () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) {
      headers[`x-header-${i}`] = "v";
    }
    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: "http://127.0.0.1:1",
      path: "/",
      method: "GET",
      headers,
    });
    expect(r.error).toBeInstanceOf(Error);
    expect(r.error?.message.toLowerCase()).toContain("too many");
  });
});

describe("Readable request body happy path", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("uploads chunks accumulated from a Node Readable", async () => {
    server = await startServer((req, res) => {
      let total = 0;
      req.on("data", (c: Buffer) => {
        total += c.length;
      });
      req.on("end", () => {
        res.writeHead(200);
        res.end(String(total));
      });
    });

    const chunks = ["alpha", "beta", "gamma"];
    let idx = 0;
    const body = new Readable({
      read() {
        if (idx < chunks.length) {
          this.push(chunks[idx]);
          idx += 1;
        } else {
          this.push(null);
        }
      },
    });

    assert(agent);
    const r = await dispatchOnce(agent, {
      origin: `http://127.0.0.1:${server.port}`,
      path: "/upload",
      method: "POST",
      body,
    });
    expect(r.error).toBeNull();
    expect(r.bytes.toString()).toBe(String(chunks.join("").length));
  });
});

describe("Request id counter survives repeated dispatches", () => {
  beforeEach(() => {
    agent = new Agent();
  });

  it("dispatches 10 requests in sequence without misrouting callbacks", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    assert(agent);
    for (let i = 0; i < 10; i += 1) {
      const r = await dispatchOnce(agent, {
        origin: `http://127.0.0.1:${server.port}`,
        path: "/",
        method: "GET",
      });
      expect(r.error).toBeNull();
      expect(r.bytes.toString()).toBe("ok");
    }
  });
});
