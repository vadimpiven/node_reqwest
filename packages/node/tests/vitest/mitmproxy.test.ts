// SPDX-License-Identifier: Apache-2.0 OR MIT

import { request, Agent as UndiciAgent } from "undici";
import { it } from "vitest";

it.runIf(process.env.MITM_PROXY)("should fail with standard undici agent", async ({ expect }) => {
  // Since undici does not pick up the system proxy by default,
  // it should fail to resolve echo.lan (or fail to connect).
  const response = request("https://echo.lan", { dispatcher: new UndiciAgent() });
  await expect(response).rejects.toThrow();
});

it("should succeed with node_reqwest agent", async () => {
  // TODO: implement
});
