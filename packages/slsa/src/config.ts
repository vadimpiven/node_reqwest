// SPDX-License-Identifier: Apache-2.0 OR MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod/v4";

const AddonConfigSchema = z.object({
  path: z.string().regex(/^\.\/[^/\\]+\/[^/\\]+\.node$/),
  url: z.url(),
});

const RepositorySchema = z.union([z.url(), z.object({ url: z.url().optional() })]);

const PackageJsonSchema = z.object({
  name: z.string().regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/),
  addon: AddonConfigSchema,
  repository: RepositorySchema,
});

export type AddonConfig = z.infer<typeof AddonConfigSchema>;
export type Repository = z.infer<typeof RepositorySchema>;
export type PackageJson = z.infer<typeof PackageJsonSchema>;

/**
 * Read and parse package.json from the given directory.
 */
export async function readPackageJson(packageDir: string): Promise<PackageJson> {
  const raw = await readFile(join(packageDir, "package.json"), "utf8");
  return PackageJsonSchema.parse(JSON.parse(raw));
}

/**
 * Extract GitHub owner/repo from a repository field.
 * Supports HTTPS URLs, SSH URLs, and optional `.git` suffix.
 * Returns null if the format is not recognized.
 */
export function extractExpectedRepo(repository: Repository): string | null {
  const repoUrl = typeof repository === "string" ? repository : (repository.url ?? "");
  const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("extractExpectedRepo", () => {
    it("extracts from HTTPS URL with .git suffix", ({ expect }) => {
      expect(
        extractExpectedRepo({
          url: "git+https://github.com/owner/repo.git",
        }),
      ).toBe("owner/repo");
    });

    it("extracts from HTTPS URL without .git suffix", ({ expect }) => {
      expect(extractExpectedRepo("https://github.com/owner/repo")).toBe("owner/repo");
    });

    it("extracts from SSH URL", ({ expect }) => {
      expect(extractExpectedRepo("git@github.com:owner/repo.git")).toBe("owner/repo");
    });

    it("returns null for non-GitHub URL", ({ expect }) => {
      expect(extractExpectedRepo("https://gitlab.com/owner/repo")).toBeNull();
    });

    it("returns null for empty string", ({ expect }) => {
      expect(extractExpectedRepo("")).toBeNull();
    });

    it("returns null for missing url in object", ({ expect }) => {
      expect(extractExpectedRepo({})).toBeNull();
    });
  });

  describe("readPackageJson", () => {
    it("reads valid package.json", async ({ expect }) => {
      const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const dir = await mkdtemp(join(tmpdir(), "slsa-test-"));
      try {
        const pkg = {
          name: "test-pkg",
          version: "1.0.0",
          addon: {
            path: "./dist/test.node",
            url: "https://example.com/test-v{version}.node.gz",
          },
          repository: {
            url: "git+https://github.com/owner/repo.git",
          },
        };
        await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

        const result = await readPackageJson(dir);
        expect(result.name).toBe("test-pkg");
        expect(result.version).toBe("1.0.0");
        expect(result.addon.path).toBe("./dist/test.node");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("throws for missing package.json", async ({ expect }) => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const dir = await mkdtemp(join(tmpdir(), "slsa-test-"));
      try {
        await expect(readPackageJson(dir)).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it("throws for missing required fields", async ({ expect }) => {
      const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const dir = await mkdtemp(join(tmpdir(), "slsa-test-"));
      try {
        await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test" }));
        await expect(readPackageJson(dir)).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it("throws for malformed JSON", async ({ expect }) => {
      const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const dir = await mkdtemp(join(tmpdir(), "slsa-test-"));
      try {
        await writeFile(join(dir, "package.json"), "not valid json");
        await expect(readPackageJson(dir)).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  });
}
