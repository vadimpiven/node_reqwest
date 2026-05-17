// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Runs inside the proxied docker stack only (`docker-compose.proxied.yaml`).
//! The dev container has no internet — all traffic must traverse `mitmweb`,
//! which intercepts `echo.lan` and echoes the request body back. These tests
//! prove the value-prop: node-reqwest honors the system proxy out of the
//! box; undici's bare Agent does not.

import { request, Agent as UndiciAgent } from "undici";
import { describe, expect, it } from "vitest";

import { Agent } from "../../export/agent.ts";

describe.runIf(process.env.MITM_PROXY)("system-proxy parity under mitmproxy", () => {
  it("plain undici.Agent cannot reach echo.lan (no proxy auto-pickup)", async () => {
    // echo.lan does not resolve in the dev container's internal_net; the
    // standard undici Agent ignores HTTP_PROXY, so the request must fail.
    await expect(request("https://echo.lan", { dispatcher: new UndiciAgent() })).rejects.toThrow();
  });

  it("node-reqwest Agent reaches echo.lan via the system proxy", async () => {
    // `global-setup.ts` wiped HTTP_PROXY/HTTPS_PROXY but stashed the URI
    // into `MITM_PROXY_URI` first — wire it back as an explicit custom
    // proxy. Equivalent to `proxy: "system"` with the env vars intact.
    const proxyUri = process.env.MITM_PROXY_URI;
    expect(proxyUri, "MITM_PROXY_URI must be set inside the proxied container").toBeTruthy();

    const agent = new Agent({
      proxy: { type: "custom", uri: proxyUri! },
    });
    try {
      const payload = "hello via proxy";
      const { statusCode, body } = await request("https://echo.lan", {
        dispatcher: agent,
        method: "POST",
        body: payload,
      });
      expect(statusCode).toBe(200);
      // The mitmproxy addon echoes the request body back as the response.
      expect(await body.text()).toBe(payload);
    } finally {
      await agent.destroy().catch(() => undefined);
    }
  });
});
