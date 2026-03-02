// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Evaluate template string with variables.
 * Replaces `{key}` placeholders with corresponding values.
 */
export function evalTemplate<T extends Record<string, string>>(template: string, vars: T): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("evalTemplate", () => {
    it("substitutes all variables", ({ expect }) => {
      const result = evalTemplate("name-v{version}-{platform}-{arch}.gz", {
        version: "1.0.0",
        platform: "linux",
        arch: "x64",
      });
      expect(result).toBe("name-v1.0.0-linux-x64.gz");
    });

    it("handles missing keys by leaving placeholders", ({ expect }) => {
      const result = evalTemplate("{version}-{platform}-{arch}", {
        version: "1.0.0",
        platform: "",
        arch: "",
      });
      expect(result).toBe("1.0.0--");
    });

    it("returns empty string for empty template", ({ expect }) => {
      const result = evalTemplate("", {
        version: "1.0.0",
        platform: "linux",
        arch: "x64",
      });
      expect(result).toBe("");
    });

    it("handles special characters in values", ({ expect }) => {
      const result = evalTemplate("{version}", {
        version: "1.0.0-beta+build.123",
        platform: "linux",
        arch: "x64",
      });
      expect(result).toBe("1.0.0-beta+build.123");
    });

    it("replaces multiple occurrences of the same key", ({ expect }) => {
      const result = evalTemplate("{version}/{version}", {
        version: "2.0.0",
        platform: "linux",
        arch: "x64",
      });
      expect(result).toBe("2.0.0/2.0.0");
    });
  });
}
