import { chatCompletionWithTools, type ChatMessage } from "../ai.ts";
import type { AgentConfig } from "../agent-config.ts";
import type { LlmConfig } from "../llm-config.ts";
import { debugError, debugInfo, debugLog } from "../debug.ts";
import { WEB_SEARCH_TOOL, executeWebSearchToolDetailed } from "../search/search-tools.ts";
import { READ_URL_TOOL, executeReadUrlTool } from "../search/read-url.ts";
import { runSearchWithRetry } from "../search/search-coordinator.ts";
import { BROWSER_AGENT_TOOLS } from "../browser/browser-tools.ts";
import type { BrowserAgentExecution } from "../browser/browser-runtime.ts";
import { getMexicoCityNow } from "../utils.ts";
import type {
  AgentDefinition,
  AgentEventHandler,
  AgentToolBinding,
  SpawnAgentReport,
} from "./agent-types.ts";

const TOOL_BINDINGS = new Map<string, Omit<AgentToolBinding, "execute">>([
  ["web_search", { definition: WEB_SEARCH_TOOL }],
  ["read_url", { definition: READ_URL_TOOL }],
  ...BROWSER_AGENT_TOOLS.map((definition) => [definition.function.name, { definition }] as const),
]);

function childAbortController(parentSignal: AbortSignal | undefined, timeoutMs: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`agent-timeout:${timeoutMs}`));
    }
  }, timeoutMs);

  const onParentAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason ?? new Error("parent-cancelled"));
  };
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  return {
    controller,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function isCancelled(signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const message = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "");
  return !message.startsWith("agent-timeout:");
}

function agentMessages(definition: AgentDefinition, prompt: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        definition.systemPrompt,
        definition.instructionsPrompt ?? "",
        getMexicoCityNow().text,
      ].filter(Boolean).join("\n\n"),
    },
    { role: "user", content: prompt },
  ];
}

function toolDefinitions(definition: AgentDefinition) {
  return definition.toolNames.flatMap((name) => {
    const binding = TOOL_BINDINGS.get(name);
    return binding ? [binding.definition] : [];
  });
}

export interface RunAgentOptions {
  definition: AgentDefinition;
  prompt: string;
  model: string;
  llmConfig: LlmConfig;
  agentConfig: AgentConfig;
  runId: string;
  parentRunId?: string;
  supervisorAgentId?: string;
  supervisorAgentName?: string;
  parentSignal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: AgentEventHandler;
  webSearchExecutor?: typeof executeWebSearchToolDetailed;
  readUrlExecutor?: typeof executeReadUrlTool;
  browserExecution?: BrowserAgentExecution;
}

export async function runAgent(options: RunAgentOptions): Promise<SpawnAgentReport> {
  const timeoutMs = options.timeoutMs ?? (options.definition.id === "researcher-web"
    ? options.agentConfig.researcherTimeoutMs
    : options.definition.timeoutMs);
  const { controller, cleanup } = childAbortController(options.parentSignal, timeoutMs);
  const signal = controller.signal;
  const toolsCalled: string[] = [];
  const backend = options.definition.backend;
  const supervisorAgentId = options.supervisorAgentId ?? options.definition.id;
  const supervisorAgentName = options.supervisorAgentName ?? options.definition.displayName;
  const logScope = `agent.${backend}`;
  const logContext = {
    backend,
    taskId: options.parentRunId,
    agentId: supervisorAgentId,
    agentName: supervisorAgentName,
    agentType: options.definition.id,
    runId: options.runId,
  };

  await options.onEvent?.({
    type: "agent_started",
    backend,
    taskId: options.parentRunId,
    supervisorAgentId,
    supervisorAgentName,
    runId: options.runId,
    parentRunId: options.parentRunId,
    agentId: options.definition.id,
    displayName: options.definition.displayName,
    prompt: options.prompt,
    timeoutMs,
  });
  debugInfo(logScope, "started", {
    ...logContext,
    action: backend === "browser-agent" ? "Iniciando navegación interactiva" : "Iniciando investigación mediante APIs de búsqueda",
    parentRunId: options.parentRunId,
    timeoutMs,
    maxSteps: options.definition.maxSteps,
    toolNames: options.definition.toolNames,
  });

  try {
    const result = await chatCompletionWithTools(
      agentMessages(options.definition, options.prompt),
      options.model,
      options.llmConfig,
      toolDefinitions(options.definition),
      async (name, args) => {
        await options.onEvent?.({
          type: "tool_started",
          backend,
          taskId: options.parentRunId,
          supervisorAgentId,
          supervisorAgentName,
          runId: options.runId,
          agentId: options.definition.id,
          toolName: name,
          args,
        });
        debugLog(logScope, "tool_started", {
          ...logContext,
          action: `Ejecutando ${name}`,
          tool: name,
          args,
        });

        let toolResult: string;
        try {
          if (name === "web_search") {
            const query = typeof args.query === "string" ? args.query.trim() : "";
            toolResult = (await runSearchWithRetry(
              `${options.runId}:${query || "web_search"}`,
              () => (options.webSearchExecutor ?? executeWebSearchToolDetailed)(args, options.agentConfig.defaultSearchDepth, signal, logContext),
              signal,
              logContext,
            )).text;
          } else if (name === "read_url") {
            toolResult = await (options.readUrlExecutor ?? executeReadUrlTool)(args, signal, logContext);
          } else if (name.startsWith("browser_") && options.browserExecution) {
            toolResult = await options.browserExecution.executeTool(name, args, signal);
          } else {
            toolResult = `Error: la herramienta "${name}" no está permitida para ${options.definition.id}.`;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          toolResult = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }

        const ok = !toolResult.startsWith("Error:");
        toolsCalled.push(name);
        await options.onEvent?.({
          type: "tool_completed",
          backend,
          taskId: options.parentRunId,
          supervisorAgentId,
          supervisorAgentName,
          runId: options.runId,
          agentId: options.definition.id,
          toolName: name,
          ok,
          resultChars: toolResult.length,
        });
        debugLog(logScope, "tool_completed", {
          ...logContext,
          action: ok ? `Finalizó ${name}` : `Falló ${name}`,
          tool: name,
          ok,
          resultChars: toolResult.length,
        });
        return toolResult;
      },
      5,
      undefined,
      {
        maxRounds: options.definition.maxSteps,
        maxTokens: options.definition.maxOutputTokens,
        truncationRecoveryAttempts: 2,
        signal,
      },
    );

    const output = result.content.trim();
    if (!output) throw new Error("El subagente terminó sin devolver una respuesta útil.");

    await options.onEvent?.({
      type: "agent_finished",
      backend,
      taskId: options.parentRunId,
      supervisorAgentId,
      supervisorAgentName,
      runId: options.runId,
      agentId: options.definition.id,
      outputChars: output.length,
      toolsCalled: [...toolsCalled],
    });
    debugInfo(logScope, "finished", {
      ...logContext,
      action: "Agente terminado",
      outputChars: output.length,
      toolsCalled,
    });

    return {
      agentType: options.definition.id,
      agentName: options.definition.displayName,
      prompt: options.prompt,
      runId: options.runId,
      status: "completed",
      result: output,
      toolsCalled,
    };
  } catch (error) {
    const cancelled = isCancelled(signal);
    const timedOut = signal.aborted && !cancelled;
    const message = timedOut
      ? `El subagente excedió su timeout de seguridad de ${Math.round(timeoutMs / 60_000)} minutos.`
      : error instanceof Error ? error.message : String(error);

    await options.onEvent?.({
      type: "agent_failed",
      backend,
      taskId: options.parentRunId,
      supervisorAgentId,
      supervisorAgentName,
      runId: options.runId,
      agentId: options.definition.id,
      cancelled,
      error: message,
    });
    debugError(logScope, cancelled ? "cancelled" : timedOut ? "timeout" : "failed", error, {
      ...logContext,
      action: cancelled ? "Agente cancelado" : timedOut ? "Agente agotó su tiempo" : "Agente falló",
      timeoutMs,
      toolsCalled,
    });

    return {
      agentType: options.definition.id,
      agentName: options.definition.displayName,
      prompt: options.prompt,
      runId: options.runId,
      status: cancelled ? "cancelled" : "failed",
      error: message,
      toolsCalled,
    };
  } finally {
    cleanup();
  }
}
