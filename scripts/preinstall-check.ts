// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Preinstall guard: refuse non-pnpm installs and surface the active toolchain.
//!
//! Replaces `npx only-allow pnpm` (which read `npm_config_user_agent` — pnpm
//! 11 stopped exporting that var to lifecycle scripts). We instead check the
//! `npm_execpath` env var, which pnpm 11 still sets to the pnpm script path
//! during lifecycle hooks.

import process from "node:process";

import { runCommand } from "./helpers/run-command.ts";

const execpath = process.env.npm_execpath ?? "";
const userAgent = process.env.npm_config_user_agent ?? "";
const looksLikePnpm = /pnpm/i.test(execpath) || userAgent.startsWith("pnpm/");

if (!looksLikePnpm) {
  console.error(
    '\n  Use "pnpm install" for installation in this project.\n' +
      '  If you don\'t have pnpm, enable it via "corepack enable pnpm".\n',
  );
  process.exit(1);
}

await runCommand("rustup", ["show"]);
