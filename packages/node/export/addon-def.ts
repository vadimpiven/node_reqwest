// SPDX-License-Identifier: Apache-2.0 OR MIT

export interface Addon {
  readonly _: unique symbol;

  hello(): string;
}
