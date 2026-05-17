// SPDX-License-Identifier: Apache-2.0 OR MIT

import { bench, describe } from "vitest";
import type { Dispatcher } from "undici";
import { Agent as UndiciAgent } from "undici";

import { Agent as NodeReqwestAgent } from "../export/agent.ts";

import { makeParallelRequests, type RequestRunner, warmup } from "./util/index.ts";
import { startHttp1Server } from "./util/server.ts";

// Top-level setup: vitest 4 bench mode does not invoke `beforeAll`,
// so we prime server + agents + warm-up at module load.
const server = await startHttp1Server();
const undiciAgent = new UndiciAgent();
const reqwestAgent = new NodeReqwestAgent();
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

describe("HTTP/1 GET dispatch", () => {
  bench("undici.Agent", async () => {
    await makeParallelRequests(runUndici);
  });
  bench("node-reqwest.Agent", async () => {
    await makeParallelRequests(runReqwest);
  });
});
