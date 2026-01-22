// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { ReadableStreamBYOBReader } from "node:stream/web";

export type AgentCreationOptions = {
  allowH2: boolean;
  ca: string[];
  keepAliveInitialDelay: number;
  keepAliveTimeout: number;
  localAddress: string | null;
  maxCachedSessions: number;
  proxy:
    | { type: "no-proxy" | "system" }
    | {
        type: "custom";
        uri: string;
        headers: Record<string, string>;
        token: string | null;
      };
  rejectInvalidHostnames: boolean;
  rejectUnauthorized: boolean;
  timeout: number;
};

export type AgentDispatchOptions = {
  blocking: boolean;
  body: ReadableStreamBYOBReader | null;
  bodyTimeout: number;
  expectContinue: boolean;
  headers: Record<string, string>;
  headersTimeout: number;
  idempotent: boolean;
  method: string;
  origin: string;
  path: string;
  query: string;
  reset: boolean;
  throwOnError: boolean;
  upgrade: string | null;
};

export interface AgentInstance {
  readonly _: unique symbol;
}

export interface Addon {
  hello(): string;

  agentCreate(options: AgentCreationOptions): AgentInstance;
  agentDispatch(agent: AgentInstance, options: AgentDispatchOptions): boolean;
  agentClose(agent: AgentInstance): Promise<void>;
  agentDestroy(agent: AgentInstance): Promise<void>;
}
