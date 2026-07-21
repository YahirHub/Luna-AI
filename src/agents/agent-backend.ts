import type { AgentExecutionBackend } from "./agent-types.ts";

export const AGENT_BACKEND_LABELS: Record<AgentExecutionBackend, string> = {
  "browser-agent": "browser-agent",
  "api-search": "api-search",
};

export function backendForAgentType(agentType: string): AgentExecutionBackend {
  return agentType === "browser-web" ? "browser-agent" : "api-search";
}

export function formatAgentBackend(backend: AgentExecutionBackend): string {
  return AGENT_BACKEND_LABELS[backend];
}
