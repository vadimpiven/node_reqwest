// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { fetch, request, setGlobalDispatcher } from "undici";

import { Agent } from "../../export/index.ts";

const currentFilename: string = fileURLToPath(import.meta.url);
const currentDirname: string = path.dirname(currentFilename);

interface ScenarioResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface ScenarioReport {
  ok: boolean;
  results: ScenarioResult[];
}

/**
 * Run a multi-scenario integration suite inside Electron's main process and
 * report aggregated results. Exercising the addon here proves it works under
 * V8's sandboxed-pointer regime — the regime that forbids `JsBuffer::external`
 * and that crashes Node's c-ares on Windows for nonexistent domains.
 */
async function runScenarios(): Promise<ScenarioReport> {
  const results: ScenarioResult[] = [];
  const record = (name: string, pass: boolean, detail = ""): void => {
    results.push({ name, pass, detail });
  };

  // In-process HTTP server: keeps the test self-contained (no DNS, no network).
  const server = createServer((req, res) => {
    if (req.url === "/hello") {
      res.writeHead(200, { "Content-Type": "text/plain", "X-Custom": "ok" });
      res.end("hello");
    } else if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 5_000);
    } else if (req.url === "/echo" && req.method === "POST") {
      let len = 0;
      req.on("data", (c: Buffer) => {
        len += c.length;
      });
      req.on("end", () => {
        res.writeHead(200);
        res.end(`Received ${len}`);
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const agent = new Agent();

  // Route undici.fetch() and undici.request() through our agent.
  setGlobalDispatcher(agent);

  try {
    // 1) The addon loads and constructs an Agent.
    record("Agent constructs", agent instanceof Agent);

    // 2) fetch() routes through us and gets a 200 with the right body.
    {
      const res = await fetch(`${baseUrl}/hello`);
      const text = await res.text();
      record(
        "fetch() routes through Agent",
        res.status === 200 && text === "hello",
        `status=${res.status} body=${text}`,
      );
    }

    // 3) Response headers are visible (proves the rawHeaders/fetch path).
    {
      const res = await fetch(`${baseUrl}/hello`);
      await res.text();
      const custom = res.headers.get("x-custom");
      record("response headers visible", custom === "ok", `x-custom=${custom}`);
    }

    // 4) undici.request() with body upload.
    {
      const { statusCode, body } = await request(`${baseUrl}/echo`, {
        method: "POST",
        body: "A".repeat(1024),
      });
      const text = await body.text();
      record("POST upload echoes byte count", statusCode === 200 && text === "Received 1024", text);
    }

    // 5) AbortSignal mid-flight cancels the in-flight request.
    {
      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error("aborted")), 50);
      let threw = false;
      try {
        await fetch(`${baseUrl}/slow`, { signal: ac.signal });
      } catch {
        threw = true;
      }
      record("AbortSignal mid-flight cancels", threw);
    }

    // 6) Concurrent fetches all complete.
    {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => fetch(`${baseUrl}/hello`).then((r) => r.text())),
      );
      record(
        "10 concurrent fetches complete",
        responses.every((t) => t === "hello"),
        `bodies=${responses.length}`,
      );
    }

    // 7) Lifecycle: agent.close() succeeds.
    {
      const closingAgent = new Agent();
      await closingAgent.close();
      record("Agent close() resolves", true);
    }
  } catch (err) {
    record("scenario suite", false, err instanceof Error ? err.message : String(err));
  } finally {
    await agent.destroy().catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
  }

  return { ok: results.every((r) => r.pass), results };
}

app.whenReady().then(() => {
  ipcMain.handle("run-scenarios", runScenarios);

  const isHeadless = process.argv.includes("--headless");
  const window = new BrowserWindow({
    show: !isHeadless,
    webPreferences: {
      sandbox: false,
      preload: path.join(currentDirname, "preload.mjs"),
    },
  });
  window.loadFile(path.join(currentDirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
