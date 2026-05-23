// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Pins client behavior against a local proxy that demands
//! `Basic dXNlcjpwYXNz` on both forward HTTP and CONNECT.
//!
//! Divergence on `http://` origins is by design:
//!   - undici `ProxyAgent` always tunnels via CONNECT. A 407 to CONNECT
//!     becomes `UND_ERR_ABORTED` with message
//!     `Proxy response (407) !== 200 when HTTP Tunneling`.
//!   - reqwest uses direct HTTP forwarding. The proxy's 407 reaches the
//!     caller as a normal response with `statusCode === 407`.
//!
//! Both clients accept credentials only via URI userinfo (undici's
//! `ProxyAgent` exposes no separate username/password fields).

import { request as httpRequest, createServer, type IncomingMessage } from "node:http";
import { connect as netConnect } from "node:net";

import { ProxyAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { Agent } from "../../export/agent.ts";
import { dispatchOnce } from "../helpers/dispatch.ts";
import { startServer, type RunningServer } from "../helpers/server.ts";

const USERNAME = "user";
const PASSWORD = "pass";
const EXPECTED_TOKEN = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

interface AuthProxy extends RunningServer {
  authedCount: () => number;
  rejectedCount: () => number;
}

let origin: RunningServer | null = null;
let proxy: AuthProxy | null = null;
let agent: Agent | null = null;
let undici: ProxyAgent | null = null;

afterEach(async () => {
  await agent?.destroy().catch(() => undefined);
  agent = null;
  await undici?.destroy().catch(() => undefined);
  undici = null;
  await proxy?.stop();
  proxy = null;
  await origin?.stop();
  origin = null;
});

async function startOrigin(): Promise<RunningServer> {
  return startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`origin saw ${req.method ?? ""} ${req.url ?? ""}`);
  });
}

async function startAuthProxy(): Promise<AuthProxy> {
  let authed = 0;
  let rejected = 0;

  const server = createServer((req, res) => {
    if (req.headers["proxy-authorization"] !== EXPECTED_TOKEN) {
      rejected += 1;
      res.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="test"',
        "Content-Type": "text/plain",
      });
      res.end("proxy auth required");
      return;
    }
    authed += 1;
    forward(req, res);
  });

  server.on("connect", (req, clientSocket, head) => {
    if (req.headers["proxy-authorization"] !== EXPECTED_TOKEN) {
      rejected += 1;
      clientSocket.write(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="test"\r\n' +
          "Content-Length: 0\r\n\r\n",
      );
      clientSocket.end();
      return;
    }
    authed += 1;
    const [host, portStr] = (req.url ?? "").split(":");
    const upstream = netConnect(Number(portStr), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port,
    authedCount: () => authed,
    rejectedCount: () => rejected,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function forward(req: IncomingMessage, res: import("node:http").ServerResponse): void {
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    res.writeHead(400).end("bad target");
    return;
  }
  const headers = { ...req.headers };
  delete headers["proxy-authorization"];
  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    },
  );
  upstream.on("error", () => res.writeHead(502).end());
  req.pipe(upstream);
}

describe("proxy basic-auth (HTTP origin)", () => {
  describe("proxy URI without credentials, proxy demands auth", () => {
    it("undici ProxyAgent: CONNECT 407 surfaces as RequestAbortedError", async () => {
      origin = await startOrigin();
      proxy = await startAuthProxy();
      undici = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` });

      const r = await dispatchOnce(undici, {
        origin: `http://127.0.0.1:${origin.port}`,
        path: "/x",
        method: "GET",
      });

      expect(r.status).toBeNull();
      expect(r.error).not.toBeNull();
      expect(r.error?.message).toBe("Proxy response (407) !== 200 when HTTP Tunneling");
      expect(r.bytes.length).toBe(0);
      expect(proxy.rejectedCount()).toBe(1);
      expect(proxy.authedCount()).toBe(0);
    });

    it("node-reqwest Agent: forwarded 407 surfaces as a normal response", async () => {
      origin = await startOrigin();
      proxy = await startAuthProxy();
      agent = new Agent({
        proxy: { type: "custom", uri: `http://127.0.0.1:${proxy.port}` },
      });

      const r = await dispatchOnce(agent, {
        origin: `http://127.0.0.1:${origin.port}`,
        path: "/x",
        method: "GET",
      });

      expect(r.error).toBeNull();
      expect(r.status).toBe(407);
      expect(r.headers?.["proxy-authenticate"]).toBe('Basic realm="test"');
      expect(r.bytes.toString("utf8")).toContain("proxy auth required");
      expect(proxy.rejectedCount()).toBe(1);
      expect(proxy.authedCount()).toBe(0);
    });
  });

  describe("credentials embedded in the proxy URI", () => {
    it("undici ProxyAgent authenticates from URI userinfo", async () => {
      origin = await startOrigin();
      proxy = await startAuthProxy();
      undici = new ProxyAgent({
        uri: `http://${USERNAME}:${PASSWORD}@127.0.0.1:${proxy.port}`,
      });

      const r = await dispatchOnce(undici, {
        origin: `http://127.0.0.1:${origin.port}`,
        path: "/ok",
        method: "GET",
      });

      expect(r.error).toBeNull();
      expect(r.status).toBe(200);
      expect(r.bytes.toString("utf8")).toBe("origin saw GET /ok");
      expect(proxy.authedCount()).toBe(1);
      expect(proxy.rejectedCount()).toBe(0);
    });

    it("node-reqwest Agent authenticates from URI userinfo", async () => {
      origin = await startOrigin();
      proxy = await startAuthProxy();
      agent = new Agent({
        proxy: {
          type: "custom",
          uri: `http://${USERNAME}:${PASSWORD}@127.0.0.1:${proxy.port}`,
        },
      });

      const r = await dispatchOnce(agent, {
        origin: `http://127.0.0.1:${origin.port}`,
        path: "/ok",
        method: "GET",
      });

      expect(r.error).toBeNull();
      expect(r.status).toBe(200);
      expect(r.bytes.toString("utf8")).toBe("origin saw GET /ok");
      expect(proxy.authedCount()).toBe(1);
      expect(proxy.rejectedCount()).toBe(0);
    });
  });
});
