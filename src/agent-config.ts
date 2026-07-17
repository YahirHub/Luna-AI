import { join } from "node:path";
import { getAppDir } from "./utils.ts";
import { readJsonFile, writeJsonFileAtomically } from "./storage.ts";

export type SearchDepth = "standard" | "deep";

export interface AgentConfig {
  version: 1;
  webSearchEnabled: boolean;
  researchSubagentEnabled: boolean;
  defaultSearchDepth: SearchDepth;
  researcherTimeoutMs: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  version: 1,
  webSearchEnabled: true,
  researchSubagentEnabled: true,
  defaultSearchDepth: "standard",
  researcherTimeoutMs: 120_000,
};

export function getAgentConfigPath(): string {
  return join(getAppDir(), "persistent", "agent-config.json");
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_AGENT_CONFIG.researcherTimeoutMs;
  }
  return Math.min(300_000, Math.max(30_000, Math.trunc(value)));
}

export function normalizeAgentConfig(value: unknown): AgentConfig {
  const raw = value && typeof value === "object"
    ? value as Partial<AgentConfig>
    : {};

  return {
    version: 1,
    webSearchEnabled: raw.webSearchEnabled !== false,
    researchSubagentEnabled: raw.researchSubagentEnabled !== false,
    defaultSearchDepth: raw.defaultSearchDepth === "deep" ? "deep" : "standard",
    researcherTimeoutMs: normalizeTimeout(raw.researcherTimeoutMs),
  };
}

export function loadAgentConfig(path = getAgentConfigPath()): AgentConfig {
  try {
    return normalizeAgentConfig(readJsonFile<unknown>(path));
  } catch (error) {
    console.warn("[config] No se pudo leer agent-config.json; usando valores seguros:", error);
    return { ...DEFAULT_AGENT_CONFIG };
  }
}

export function saveAgentConfig(
  config: AgentConfig,
  path = getAgentConfigPath(),
): AgentConfig {
  const normalized = normalizeAgentConfig(config);
  writeJsonFileAtomically(path, normalized);
  return normalized;
}

export type AgentConfigFlowResult =
  | { done: false; config: AgentConfig; text: string }
  | { done: true; config: AgentConfig; text: string };

export class AgentConfigFlowManager {
  private activeJids = new Set<string>();

  constructor(private readonly configPath = getAgentConfigPath()) {}

  has(jid: string): boolean {
    return this.activeJids.has(jid);
  }

  start(jid: string): void {
    this.activeJids.add(jid);
  }

  cancel(jid: string): void {
    this.activeJids.delete(jid);
  }

  render(config: AgentConfig): string {
    return [
      "⚙️ CONFIGURACIÓN DEL AGENTE",
      "",
      `1. Búsqueda web directa: ${config.webSearchEnabled ? "ACTIVA" : "INACTIVA"}`,
      `2. Subagente investigador: ${config.researchSubagentEnabled ? "ACTIVO" : "INACTIVO"}`,
      `3. Profundidad predeterminada: ${config.defaultSearchDepth === "deep" ? "PROFUNDA" : "ESTÁNDAR"}`,
      `4. Timeout del investigador: ${Math.round(config.researcherTimeoutMs / 1000)} segundos`,
      "",
      "Envía el número de una opción para cambiarla.",
      "Envía 0 para guardar y salir, o /cancelar para cerrar sin más cambios.",
      "",
      "Las opciones se guardan inmediatamente en persistent/agent-config.json.",
    ].join("\n");
  }

  submit(jid: string, input: string, current: AgentConfig): AgentConfigFlowResult {
    if (!this.has(jid)) {
      throw new Error("No existe una configuración activa.");
    }

    const value = input.trim().toLowerCase();
    if (value === "0" || value === "salir" || value === "listo") {
      this.cancel(jid);
      return {
        done: true,
        config: current,
        text: "✅ Configuración del agente guardada.",
      };
    }

    let next = { ...current };
    switch (value) {
      case "1":
        next.webSearchEnabled = !next.webSearchEnabled;
        break;
      case "2":
        next.researchSubagentEnabled = !next.researchSubagentEnabled;
        break;
      case "3":
        next.defaultSearchDepth = next.defaultSearchDepth === "standard"
          ? "deep"
          : "standard";
        break;
      case "4": {
        const values = [60_000, 120_000, 180_000, 300_000];
        const index = values.indexOf(next.researcherTimeoutMs);
        next.researcherTimeoutMs = values[(index + 1) % values.length] ?? 120_000;
        break;
      }
      default:
        return {
          done: false,
          config: current,
          text: `❌ Opción inválida.\n\n${this.render(current)}`,
        };
    }

    next = saveAgentConfig(next, this.configPath);
    return {
      done: false,
      config: next,
      text: `✅ Opción actualizada.\n\n${this.render(next)}`,
    };
  }
}
