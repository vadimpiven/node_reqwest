import { Dispatcher } from "undici";
import { Addon } from "./addon.ts";
import type { AgentCreationOptions, AgentDispatchOptions, AgentInstance } from "./addon-def.ts";
import type { Agent as AgentDef, AgentOptions } from "./agent-def.ts";
import { normalizeBody, normalizeHeaders, normalizePem } from "./normalize.ts";

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
