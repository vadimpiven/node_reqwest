import { Dispatcher } from 'undici';
import { Addon } from './addon.ts';
import type { Agent as AgentDef, AgentOptions } from './agent-def.ts';

class AgentImpl extends Dispatcher {
  constructor(_options?: AgentOptions) {
    super();
  }

  dispatch(_options: Dispatcher.DispatchOptions, _handler: Dispatcher.DispatchHandler): boolean {
    return true;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

export const Agent: AgentDef = AgentImpl;

export const hello = (): string => Addon.hello();
