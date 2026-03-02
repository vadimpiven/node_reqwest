// SPDX-License-Identifier: Apache-2.0 OR MIT

import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import { extractExpectedRepo, readPackageJson } from "./config.ts";
import { createHashPassthrough, fetchStream } from "./download.ts";
import { SecurityError } from "./util/security-error.ts";
import { evalTemplate } from "./util/template.ts";
import { verifyBinaryProvenance, verifyNpmProvenance } from "./verify.ts";

type TemplateVars = {
  version: string;
  platform: string;
  arch: string;
};

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * Assert that `target` is strictly within `baseDir` to prevent
 * path-traversal attacks through package.json fields.
 */
function assertWithinDir(baseDir: string, target: string, label: string): void {
  const base = resolve(baseDir);
  const resolved = resolve(target);
  if (!resolved.startsWith(base + sep)) {
    throw new SecurityError(
      `${label} escapes the package directory.\n` + `Base: ${base}\n` + `Resolved: ${resolved}`,
    );
  }
}

/**
 * Download, verify, and install the native binary.
 */
export async function wget(packageDir: string): Promise<void> {
  const { name, version, addon, repository } = await readPackageJson(packageDir);

  const expectedRepo = extractExpectedRepo(repository);
  if (!expectedRepo) {
    throw new Error("Could not determine expected repository from package.json");
  }

  const vars: TemplateVars = {
    version,
    platform: process.platform,
    arch: process.arch,
  };

  const resolvedPkgDir = resolve(packageDir);
  const binaryPath = join(resolvedPkgDir, addon.path);
  assertWithinDir(resolvedPkgDir, binaryPath, "addon.path");
  const addonDir = dirname(binaryPath);
  const downloadUrl = evalTemplate(addon.url, vars);

  await mkdir(addonDir, { recursive: true });

  // Skip verification for development version
  if (version === "0.0.0") return;

  // Verify npm package provenance
  const runInvocationURI = await verifyNpmProvenance(name, version, expectedRepo);

  // Stream: download → hash compressed bytes → decompress → write temp file.
  // The hash is computed over the compressed bytes because
  // actions/attest-build-provenance attests the .gz artifact
  // (the GitHub release asset), not the decompressed binary.
  // flags: "wx" (O_EXCL) fails if file exists, preventing symlink attacks.
  const tmpPath = join(addonDir, `.tmp-${randomBytes(8).toString("hex")}.node`);
  const { stream: hashStream, digest } = createHashPassthrough();

  try {
    await pipeline(
      await fetchStream(downloadUrl),
      hashStream,
      createGunzip(),
      createWriteStream(tmpPath, { mode: 0o755, flags: "wx" }),
    );

    // Verify binary provenance against the same workflow run
    await verifyBinaryProvenance(digest(), runInvocationURI, expectedRepo);

    // Guard against symlink at destination. A symlink here should
    // never exist in a legitimate installation — refuse to proceed.
    // Note: this check has a TOCTOU window between lstat and rename.
    // The primary protection is atomic rename(2), which replaces
    // whatever is at binaryPath without following symlinks.
    try {
      const st = await lstat(binaryPath);
      if (st.isSymbolicLink()) {
        throw new SecurityError(
          "Binary destination is a symlink: " +
            `${binaryPath}\n` +
            "This may indicate a symlink attack.",
        );
      }
      await unlink(binaryPath);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }

    await rename(tmpPath, binaryPath);
  } catch (err) {
    await unlink(tmpPath).catch((unlinkErr: unknown) => {
      if (!isEnoent(unlinkErr)) throw unlinkErr;
    });
    throw err;
  }
}

/**
 * Gzip compress the native binary for distribution.
 */
export async function pack(packageDir: string): Promise<void> {
  const { version, addon } = await readPackageJson(packageDir);

  const vars: TemplateVars = {
    version,
    platform: process.platform,
    arch: process.arch,
  };

  const resolvedPkgDir = resolve(packageDir);
  const binaryPath = join(resolvedPkgDir, addon.path);
  assertWithinDir(resolvedPkgDir, binaryPath, "addon.path");
  const addonDir = dirname(binaryPath);
  const packedName = basename(evalTemplate(addon.url, vars));
  const packedFile = join(addonDir, packedName);

  await pipeline(
    createReadStream(binaryPath),
    createGzip({ level: 9 }),
    createWriteStream(packedFile),
  );
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("wget", () => {
    it("skips verification for version 0.0.0", async ({ expect }) => {
      const { access, mkdtemp, rm, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");

      const dir = await mkdtemp(join(tmpdir(), "slsa-test-"));
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

        await wget(dir);

        // dist/ created but no binary downloaded
        await expect(access(join(dir, "dist"))).resolves.toBeUndefined();
        await expect(access(join(dir, "dist", "node_reqwest.node"))).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  });

  describe("pack", () => {
    it("gzip compresses binary and produces valid archive", async ({ expect }) => {
      const { readFile, mkdtemp, rm, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { promisify } = await import("node:util");
      const { gunzip } = await import("node:zlib");
      const gunzipAsync = promisify(gunzip);

      const dir = await mkdtemp(join(tmpdir(), "slsa-test-"));
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

        await pack(dir);

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
  });
}
