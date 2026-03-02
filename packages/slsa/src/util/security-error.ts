// SPDX-License-Identifier: Apache-2.0 OR MIT

const SECURITY_ADVICE =
  "Do not use this package version. " + "Report this issue to the maintainer.";

export class SecurityError extends Error {
  constructor(message: string) {
    super(`SECURITY: ${message}\n${SECURITY_ADVICE}`);
    this.name = "SecurityError";
  }
}

export function isSecurityError(err: unknown): err is SecurityError {
  return err instanceof SecurityError;
}
