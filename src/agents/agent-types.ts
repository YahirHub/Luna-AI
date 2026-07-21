import type { ToolDefinition } from "../ai.ts";

export type AgentOutputMode = "last_message" | "structured_output";
export type AgentExecutionBackend = "browser-agent" | "api-search";

export interface AgentExecutionLogContext {
  backend: AgentExecutionBackend;
  taskId?: string;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  runId?: string;
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  /** Motor real usado por el agente; se muestra en chat, supervisor y logs. */
  backend: AgentExecutionBackend;
  /** Prompt breve que ayuda al agente padre a decidir cuándo delegar. */
  spawnerPrompt: string;
  /** Herramientas disponibles dentro del contexto aislado del subagente. */
  toolNames: string[];
  /** Subagentes que este agente puede crear. Vacío para investigadores hoja. */
  spawnableAgents: string[];
  includeMessageHistory: boolean;
  outputMode: AgentOutputMode;
  systemPrompt: string;
  instructionsPrompt?: string;
  /** Techo de seguridad; el agente debe terminar antes cuando ya tenga evidencia suficiente. */
  timeoutMs: number;
  /** Protección contra loops, no objetivo de consumo. */
  maxSteps: number;
  /** Presupuesto máximo de salida por respuesta del subagente. */
  maxOutputTokens: number;
}

export interface SpawnAgentRequest {
  agent_type: string;
  name?: string;
  prompt?: string;
  params?: Record<string, unknown>;
}

export interface SpawnAgentReport {
  agentType: string;
  agentName: string;
  prompt: string;
  runId: string;
  status: "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
  toolsCalled: string[];
}

export type AgentEvent =
  | {
      type: "agent_started";
      backend: AgentExecutionBackend;
      taskId?: string;
      supervisorAgentId?: string;
      supervisorAgentName?: string;
      runId: string;
      parentRunId?: string;
      agentId: string;
      displayName: string;
      prompt: string;
      timeoutMs: number;
    }
  | {
      type: "tool_started";
      backend: AgentExecutionBackend;
      taskId?: string;
      supervisorAgentId?: string;
      supervisorAgentName?: string;
      runId: string;
      agentId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_completed";
      backend: AgentExecutionBackend;
      taskId?: string;
      supervisorAgentId?: string;
      supervisorAgentName?: string;
      runId: string;
      agentId: string;
      toolName: string;
      ok: boolean;
      resultChars: number;
    }
  | {
      type: "agent_finished";
      backend: AgentExecutionBackend;
      taskId?: string;
      supervisorAgentId?: string;
      supervisorAgentName?: string;
      runId: string;
      agentId: string;
      outputChars: number;
      toolsCalled: string[];
    }
  | {
      type: "agent_failed";
      backend: AgentExecutionBackend;
      taskId?: string;
      supervisorAgentId?: string;
      supervisorAgentName?: string;
      runId: string;
      agentId: string;
      cancelled: boolean;
      error: string;
    };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

export interface AgentToolBinding {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
}
