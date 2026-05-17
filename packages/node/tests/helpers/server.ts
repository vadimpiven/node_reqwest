// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RunningServer {
  port: number;
  stop: () => Promise<void>;
}

/** Start an ephemeral-port HTTP server bound to 127.0.0.1. */
export async function startServer(handler: RequestListener): Promise<RunningServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
