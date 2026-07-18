import type { AgentDefinition } from "./agent-types.ts";
import { RESEARCHER_WEB_AGENT } from "./definitions/researcher-web.ts";

const DEFINITIONS = new Map<string, AgentDefinition>([
  [RESEARCHER_WEB_AGENT.id, RESEARCHER_WEB_AGENT],
]);

export const MAIN_SPAWNABLE_AGENTS = ["researcher-web"] as const;

export function normalizeAgentType(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const segment = raw.split("/").pop() ?? raw;
  return segment.split("@")[0]?.replace(/_/g, "-").toLowerCase() ?? "";
}

export function getAgentDefinition(agentType: string): AgentDefinition | undefined {
  return DEFINITIONS.get(normalizeAgentType(agentType));
}

export function validateSpawnableAgent(agentType: string, allowed: readonly string[]): AgentDefinition {
  const normalized = normalizeAgentType(agentType);
  if (!allowed.some((item) => normalizeAgentType(item) === normalized)) {
    throw new Error(`El agente padre no tiene permiso para crear el subagente "${agentType}".`);
  }
  const definition = getAgentDefinition(normalized);
  if (!definition) throw new Error(`No existe el tipo de subagente "${agentType}".`);
  return definition;
}
