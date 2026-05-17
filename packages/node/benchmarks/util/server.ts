// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Lightweight in-process servers for bench files. Each bench owns its
//! server lifecycle via `beforeAll` / `afterAll` so files are self-contained.

import http, { type Server as HttpServer } from "node:http";
import http2, { type Http2SecureServer } from "node:http2";
import type { AddressInfo } from "node:net";

import selfsigned from "selfsigned";

const RESPONSE_BODY = Buffer.from("Hello, World!");

export interface BenchServer {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

export interface TlsServer extends BenchServer {
  /** Server-cert chain root, PEM, for `tls.ca` on the client. */
  caPem: string;
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === "POST") {
    req.on("data", () => undefined);
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": 2 });
      res.end("OK");
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": RESPONSE_BODY.length });
  res.end(RESPONSE_BODY);
}

export async function startHttp1Server(): Promise<BenchServer> {
  const server: HttpServer = http.createServer(handleRequest);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

export async function startHttp2Server(): Promise<TlsServer> {
  const ca = await selfsigned.generate([{ name: "commonName", value: "Bench CA" }], {
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: true },
      { name: "keyUsage", keyCertSign: true, digitalSignature: true },
    ],
  });
  const leaf = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    keySize: 2048,
    algorithm: "sha256",
    ca: { key: ca.private, cert: ca.cert },
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

  const server: Http2SecureServer = http2.createSecureServer(
    { key: leaf.private, cert: leaf.cert },
    handleRequest as http2.Http2ServerRequest extends never
      ? never
      : (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void,
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://127.0.0.1:${port}`,
    port,
    caPem: ca.cert,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
