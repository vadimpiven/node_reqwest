import type Stream from "node:stream";
import { Dispatcher, type FormData, Response } from "undici";
import { Addon } from "./addon.ts";
import type { AgentCreationOptions, AgentDispatchOptions, AgentInstance } from "./addon-def.ts";
import type { Agent as AgentDef, AgentOptions } from "./agent-def.ts";

function normalizePem(pem?: string | Buffer | (string | Buffer)[]): string[] {
  if (!pem) {
    return [];
  }

  if (Array.isArray(pem)) {
    return pem.flatMap(normalizePem);
  }

  return [Buffer.isBuffer(pem) ? pem.toString() : pem];
}

function normalizeHeaders(
  headers?:
    | Record<string, string | string[] | undefined>
    | Iterable<[string, string | string[] | undefined]>
    | string[]
    | null,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const result: Record<string, string> = {};
  const add = (key: string, value?: string | string[]): void => {
    if (!value) {
      return;
    }
    const k = key.toLowerCase();
    const v = Array.isArray(value) ? value.join(", ") : value;
    const existing = result[k];
    result[k] = existing ? `${existing}, ${v}` : v;
  };

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key = headers[i];
      if (key !== undefined) {
        add(key, headers[i + 1]);
      }
    }
  } else if (Symbol.iterator in headers) {
    for (const [key, value] of headers) {
      add(key, value);
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      add(key, value);
    }
  }

  return result;
}

function normalizeBody(
  body?: string | Buffer | Uint8Array | FormData | Stream.Readable | null,
): ReadableStreamBYOBReader | null {
  if (!body) {
    return null;
  }

  const response = new Response(body);
  if (!response.body) {
    return null;
  }

  return response.body.getReader({ mode: "byob" });
}

class AgentImpl extends Dispatcher {
  #agent: AgentInstance;

  constructor(options?: AgentOptions) {
    super();
    const creationOptions: AgentCreationOptions = {
      allowH2: options?.connection?.allowH2 ?? true,
      ca: normalizePem(options?.connection?.ca),
      keepAliveInitialDelay: options?.connection?.keepAliveInitialDelay ?? 60000,
      keepAliveTimeout: options?.connection?.keepAliveTimeout ?? 4000,
      localAddress: options?.connection?.localAddress ?? null,
      maxCachedSessions: options?.connection?.maxCachedSessions ?? 100,
      proxy: options?.proxy
        ? typeof options.proxy === "string"
          ? { type: options.proxy }
          : {
              type: "custom",
              uri: options.proxy.uri,
              headers: normalizeHeaders(options.proxy.headers),
              token: options.proxy.token ?? null,
            }
        : { type: "system" },
      rejectInvalidHostnames:
        options?.connection?.rejectInvalidHostnames ??
        options?.connection?.rejectUnauthorized ??
        true,
      rejectUnauthorized: options?.connection?.rejectUnauthorized ?? true,
      timeout: options?.connection?.timeout ?? 10000,
    };
    this.#agent = Addon.agentCreate(creationOptions);
  }

  dispatch(options: Dispatcher.DispatchOptions, _handler: Dispatcher.DispatchHandler): boolean {
    const dispatchOptions: AgentDispatchOptions = {
      blocking: options.blocking ?? options.method !== "HEAD",
      body: normalizeBody(options.body),
      bodyTimeout: options.bodyTimeout ?? 300000,
      expectContinue: options.expectContinue ?? false,
      headers: normalizeHeaders(options.headers),
      headersTimeout: options.headersTimeout ?? 300000,
      idempotent: options.idempotent ?? (options.method === "GET" || options.method === "HEAD"),
      method: options.method,
      origin: String(options.origin ?? ""),
      path: options.path,
      query: new URLSearchParams(options.query ?? "").toString(),
      reset: options.reset ?? false,
      throwOnError: options.throwOnError ?? false,
      upgrade: options.upgrade
        ? options.method === "CONNECT"
          ? null
          : options.upgrade === true
            ? "Websocket"
            : options.upgrade
        : null,
    };
    return Addon.agentDispatch(this.#agent, dispatchOptions);
  }

  close(): Promise<void> {
    return Addon.agentClose(this.#agent);
  }

  destroy(): Promise<void> {
    return Addon.agentDestroy(this.#agent);
  }
}

export const Agent: AgentDef = AgentImpl;

export const hello = (): string => Addon.hello();
