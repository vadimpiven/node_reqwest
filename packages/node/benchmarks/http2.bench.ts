// SPDX-License-Identifier: Apache-2.0 OR MIT

import { bench, describe } from "vitest";
import type { Dispatcher } from "undici";
import { Agent as UndiciAgent } from "undici";

import { Agent as NodeReqwestAgent } from "../export/agent.ts";

import { makeParallelRequests, type RequestRunner, warmup } from "./util/index.ts";
import { startHttp2Server } from "./util/server.ts";

// Top-level setup: vitest 4 bench mode does not invoke `beforeAll`.
const server = await startHttp2Server();
const undiciAgent = new UndiciAgent({
  allowH2: true,
  connect: { ca: server.caPem, rejectUnauthorized: true },
});
const reqwestAgent = new NodeReqwestAgent({
  allowH2: true,
  tls: { ca: [server.caPem], rejectUnauthorized: true, rejectInvalidHostnames: true },
});
const options: Dispatcher.DispatchOptions = { origin: server.url, path: "/", method: "GET" };

const runUndici: RequestRunner = (resolve, reject) =>
  undiciAgent.dispatch(options, {
    onRequestStart: () => true,
    onResponseStart: () => true,
    onResponseData: () => true,
    onResponseEnd: () => {
      resolve();
      return true;
    },
    onResponseError: (_c, err) => {
      reject(err);
      return true;
    },
  });

const runReqwest: RequestRunner = (resolve, reject) =>
  reqwestAgent.dispatch(options, {
    onRequestStart: () => true,
    onResponseStart: () => true,
    onResponseData: () => true,
    onResponseEnd: () => {
      resolve();
      return true;
    },
    onResponseError: (_c, err) => {
      reject(err);
      return true;
    },
  });

await warmup(runUndici);
await warmup(runReqwest);

describe("HTTP/2 GET dispatch", () => {
  bench("undici.Agent", async () => {
    await makeParallelRequests(runUndici);
  });
  bench("node-reqwest.Agent", async () => {
    await makeParallelRequests(runReqwest);
  });
});
