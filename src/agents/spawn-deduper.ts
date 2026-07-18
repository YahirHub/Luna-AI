import type { SpawnAgentRequest } from "./agent-types.ts";
import { normalizeAgentType } from "./agent-registry.ts";

function normalizePrompt(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortJson(value ?? null));
  } catch {
    return String(value);
  }
}

export function getSpawnAgentRequestKey(agent: SpawnAgentRequest): string {
  return [
    normalizeAgentType(agent.agent_type),
    normalizePrompt(agent.prompt),
    stableJson(agent.params),
  ].join("\u0000");
}

export function deduplicateSpawnAgentRequests<T extends SpawnAgentRequest>(agents: readonly T[]): {
  uniqueAgents: T[];
  originalToUniqueIndex: number[];
} {
  const uniqueAgents: T[] = [];
  const originalToUniqueIndex: number[] = [];
  const keyToIndex = new Map<string, number>();

  for (const agent of agents) {
    const key = getSpawnAgentRequestKey(agent);
    const existing = keyToIndex.get(key);
    if (existing !== undefined) {
      originalToUniqueIndex.push(existing);
      continue;
    }
    const index = uniqueAgents.length;
    keyToIndex.set(key, index);
    uniqueAgents.push(agent);
    originalToUniqueIndex.push(index);
  }

  return { uniqueAgents, originalToUniqueIndex };
}

export function createSpawnAgentRequestDeduper(): {
  filter: (agents: SpawnAgentRequest[]) => SpawnAgentRequest[];
  reset: () => void;
} {
  const seen = new Set<string>();
  return {
    filter(agents) {
      return agents.filter((agent) => {
        const key = getSpawnAgentRequestKey(agent);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    reset() {
      seen.clear();
    },
  };
}
