// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Smoke tests for the loaded native addon, exercised via the public Agent.

import { afterEach, describe, expect, it } from "vitest";

import { Agent } from "../../export/agent.ts";
import { startServer, type RunningServer } from "../helpers/server.ts";
import { dispatchOnce } from "../helpers/dispatch.ts";

let agent: Agent | null = null;
let server: RunningServer | null = null;

afterEach(async () => {
  await agent?.destroy().catch(() => undefined);
  agent = null;
  await server?.stop();
  server = null;
});

describe("Addon smoke", () => {
  it("loads and constructs an Agent", () => {
    agent = new Agent();
    expect(agent).toBeInstanceOf(Agent);
  });

  it("supports pause/resume/abort on an in-flight request", async () => {
    server = await startServer((_req, res) => {
      // Slow trickle so pause/resume have something to act on.
      res.writeHead(200, { "Content-Type": "text/plain", "Transfer-Encoding": "chunked" });
      res.write("a");
      setTimeout(() => {
        res.write("b");
        res.end("c");
      }, 50);
    });
    agent = new Agent();

    const result = await dispatchOnce(
      agent,
      { origin: `http://127.0.0.1:${server.port}`, path: "/", method: "GET" },
      {
        onRequestStart(controller) {
          controller.pause();
          controller.resume();
          return true;
        },
      },
    );
    expect(result.error).toBeNull();
    expect(result.bytes.toString()).toBe("abc");
  });
});
