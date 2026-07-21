import { AsyncLocalStorage } from "node:async_hooks";

export type AgentBackend = "browser-agent" | "api-search";
export interface AgentExecutionContext {
  backend: AgentBackend;
  taskId?: string;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  runId?: string;
}

const storage = new AsyncLocalStorage<AgentExecutionContext>();

export function withAgentExecutionContext<T>(context: AgentExecutionContext, operation: () => T): T {
  return storage.run(context, operation);
}

export function getAgentExecutionContext(): AgentExecutionContext | undefined {
  return storage.getStore();
}

export function agentLogData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, ...(storage.getStore() ?? {}) };
}
