// SPDX-License-Identifier: Apache-2.0 OR MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { describe, it } from "vitest";

const gunzipAsync = promisify(gunzip);

const slsaBin = resolve("bin/slsa.mjs");

function run(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [slsaBin, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

describe("slsa bin", () => {
  it("wget skips verification for development version", async ({ expect }) => {
    const dir = await mkdtemp(join(tmpdir(), "slsa-bin-"));
    try {
      const pkg = {
        name: "node-reqwest",
        version: "0.0.0",
        addon: {
          path: "./dist/node_reqwest.node",
          url: "https://example.com/node_reqwest-v{version}-{platform}-{arch}.node.gz",
        },
        repository: {
          url: "git+https://github.com/vadimpiven/node_reqwest.git",
        },
      };
      await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

      const { code } = await run(["wget"], dir);
      expect(code).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("pack compresses binary and produces valid archive", async ({ expect }) => {
    const dir = await mkdtemp(join(tmpdir(), "slsa-bin-"));
    try {
      const distDir = join(dir, "dist");
      await mkdir(distDir, { recursive: true });

      const binaryContent = Buffer.from("fake native addon content for testing");
      await writeFile(join(distDir, "node_reqwest.node"), binaryContent);

      const pkg = {
        name: "node-reqwest",
        version: "1.0.0",
        addon: {
          path: "./dist/node_reqwest.node",
          url: "https://example.com/node_reqwest-v{version}-{platform}-{arch}.node.gz",
        },
        repository: {
          url: "git+https://github.com/vadimpiven/node_reqwest.git",
        },
      };
      await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

      const { code } = await run(["pack"], dir);
      expect(code).toBe(0);

      const platform = process.platform;
      const arch = process.arch;
      const packedPath = join(distDir, `node_reqwest-v1.0.0-${platform}-${arch}.node.gz`);
      const compressed = await readFile(packedPath);
      const decompressed = await gunzipAsync(compressed);
      expect(decompressed).toEqual(binaryContent);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("exits with error for unknown command", async ({ expect }) => {
    const dir = await mkdtemp(join(tmpdir(), "slsa-bin-"));
    try {
      await writeFile(join(dir, "package.json"), "{}");
      const { code, stderr } = await run(["unknown"], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("Unknown command");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
