// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";

import { pack, wget } from "./commands.ts";
import { isSecurityError } from "./util/security-error.ts";

/**
 * CLI entry point. Dispatches to pack() or wget() based on
 * process.argv[2].
 */
export function runSlsa(): void {
  process.once("unhandledRejection", (reason) => {
    console.error(reason);
    process.exit(1);
  });

  const command = process.argv[2];
  const packageDir = process.cwd();

  let task: Promise<void>;

  switch (command) {
    case "pack":
      task = pack(packageDir);
      break;
    case "wget":
      task = wget(packageDir);
      break;
    default:
      console.error(`Unknown command: ${command}. Use "pack" or "wget".`);
      process.exit(1);
      return;
  }

  task.catch((err: unknown) => {
    if (isSecurityError(err)) {
      console.error(err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
