// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, expect, it } from "vitest";
import { Dispatcher } from "undici";
import { Agent } from "../../export/index.ts";

describe("Agent export", () => {
  it("constructs and inherits from undici.Dispatcher", async () => {
    const agent = new Agent();
    expect(agent).toBeInstanceOf(Agent);
    expect(agent).toBeInstanceOf(Dispatcher);
    await agent.close();
  });
});
