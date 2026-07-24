import { chatCompletionWithTools, type ChatMessage, type ToolDefinition } from "../ai.ts";
import type { AgentConfig } from "../agent-config.ts";
import type { LlmConfig } from "../llm-config.ts";
import { debugError, debugInfo, debugLog } from "../debug.ts";
import { WEB_SEARCH_TOOL, executeWebSearchToolDetailed } from "../search/search-tools.ts";
import { READ_URL_TOOL, executeReadUrlTool } from "../search/read-url.ts";
import { runSearchWithRetry } from "../search/search-coordinator.ts";
import { BROWSER_AGENT_TOOLS } from "../browser/browser-tools.ts";
import type { BrowserAgentExecution } from "../browser/browser-runtime.ts";
import { AGENT_WORKSPACE_TOOLS, executeAgentWorkspaceTool } from "../workspace/agent-workspace-tools.ts";
import { SKILL_TOOLS, executeSkillTool } from "../skills/skill-tools.ts";
import type { SkillManager } from "../skills/skill-manager.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { getMexicoCityNow } from "../utils.ts";
import { agentLogData, withAgentExecutionContext, type AgentBackend } from "./execution-context.ts";
import type {
  AgentDefinition,
  AgentEventHandler,
  AgentToolBinding,
  SpawnAgentReport,
} from "./agent-types.ts";

function aliasToolDefinition(definition: ToolDefinition, logicalName: string): ToolDefinition {
  if (definition.function.name === logicalName) return definition;
  return {
    ...definition,
    function: {
      ...definition.function,
      name: logicalName,
    },
  };
}

const TOOL_BINDINGS = new Map<string, Omit<AgentToolBinding, "execute">>([
  ["web_search", { definition: aliasToolDefinition(WEB_SEARCH_TOOL, "web_search") }],
  // READ_URL_TOOL usa un nombre namespaced en el agente principal. El
  // researcher-web expone deliberadamente el alias corto `read_url`, que es el
  // nombre de su allowlist, prompts y ejecutor. No debemos enviar al modelo un
  // schema con un nombre distinto al que executeBoundTool sabe despachar.
  ["read_url", { definition: aliasToolDefinition(READ_URL_TOOL, "read_url") }],
  ...BROWSER_AGENT_TOOLS.map((definition) => [definition.function.name, { definition }] as const),
  ...AGENT_WORKSPACE_TOOLS.map((definition) => [definition.function.name, { definition }] as const),
  ...SKILL_TOOLS.filter((definition) => ["skill_search", "skill_load", "skill_read_resource"].includes(definition.function.name))
    .map((definition) => [definition.function.name, { definition }] as const),
]);

function childAbortController(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  pauseTimeout?: () => boolean,
): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let budgetTimer: ReturnType<typeof setInterval> | undefined;

  if (!pauseTimeout) {
    timeout = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(new Error(`agent-timeout:${timeoutMs}`));
    }, timeoutMs);
  } else {
    let remainingMs = timeoutMs;
    let previousTick = Date.now();
    const intervalMs = Math.min(250, Math.max(10, Math.floor(timeoutMs / 20)));
    budgetTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.max(0, now - previousTick);
      previousTick = now;
      if (controller.signal.aborted || pauseTimeout()) return;
      remainingMs -= elapsed;
      if (remainingMs <= 0) controller.abort(new Error(`agent-timeout:${timeoutMs}`));
    }, intervalMs);
    budgetTimer.unref?.();
  }

  const onParentAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason ?? new Error("parent-cancelled"));
  };
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  return {
    controller,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      if (budgetTimer) clearInterval(budgetTimer);
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

function buildAgentCapabilityLoadTool(definition: AgentDefinition): ToolDefinition | null {
  const groups = definition.toolGroups ?? {};
  const ids = Object.keys(groups).sort();
  if (ids.length === 0) return null;
  const catalog = ids.map((id) => `${id}=${groups[id]!.description}`).join("; ");
  return {
    type: "function",
    function: {
      name: "agent_capability_load",
      description: `Carga durante ESTA ejecución un grupo adicional de tools del subagente. Úsalo solo cuando haga falta. Grupos: ${catalog}.`,
      parameters: {
        type: "object",
        properties: { group: { type: "string", enum: ids } },
        required: ["group"],
        additionalProperties: false,
      },
    },
  };
}

function toolDefinitions(definition: AgentDefinition, loadedGroups: Iterable<string> = []): ToolDefinition[] {
  const names = new Set(definition.initialToolNames ?? definition.toolNames);
  for (const rawGroupId of loadedGroups) {
    const groupId = rawGroupId.trim().toLowerCase();
    const group = definition.toolGroups?.[groupId];
    if (!group) continue;
    for (const name of group.toolNames) names.add(name);
  }

  // Nunca permitimos que un grupo amplíe el allowlist total del agente.
  const authorized = new Set(definition.toolNames);
  const result = [...names].flatMap((name) => {
    if (!authorized.has(name)) return [];
    const binding = TOOL_BINDINGS.get(name);
    return binding ? [binding.definition] : [];
  });
  const loader = buildAgentCapabilityLoadTool(definition);
  if (loader) result.push(loader);
  return result;
}

export interface RunAgentOptions {
  definition: AgentDefinition;
  prompt: string;
  model: string;
  llmConfig: LlmConfig;
  agentConfig: AgentConfig;
  runId: string;
  parentRunId?: string;
  parentSignal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: AgentEventHandler;
  webSearchExecutor?: typeof executeWebSearchToolDetailed;
  readUrlExecutor?: typeof executeReadUrlTool;
  browserExecution?: BrowserAgentExecution;
  taskId?: string;
  supervisorAgentId?: string;
  supervisorAgentName?: string;
  backend?: AgentBackend;
  workspace?: WorkspaceManager;
  jid?: string;
  agentDir?: string;
  skills?: SkillManager;
}

async function runAgentInternal(options: RunAgentOptions): Promise<SpawnAgentReport> {
  const timeoutMs = options.timeoutMs ?? (options.definition.id === "researcher-web"
    ? options.agentConfig.researcherTimeoutMs
    : options.definition.timeoutMs);
  const { controller, cleanup } = childAbortController(
    options.parentSignal,
    timeoutMs,
    options.browserExecution ? () => options.browserExecution!.isWaitingForUser() : undefined,
  );
  const signal = controller.signal;
  const toolsCalled: string[] = [];
  const loadedToolGroups = new Set<string>();

  await options.onEvent?.({
    type: "agent_started",
    runId: options.runId,
    parentRunId: options.parentRunId,
    agentId: options.definition.id,
    displayName: options.definition.displayName,
    prompt: options.prompt,
    timeoutMs,
  });
  debugInfo(`agent.${options.backend ?? (options.definition.id === "browser-web" ? "browser-agent" : "api-search")}`, "started", agentLogData({
    agentId: options.definition.id,
    runId: options.runId,
    parentRunId: options.parentRunId,
    timeoutMs,
    maxSteps: options.definition.maxSteps,
    toolNames: options.definition.toolNames,
  }));

  const executeBoundTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    await options.onEvent?.({
      type: "tool_started",
      runId: options.runId,
      agentId: options.definition.id,
      toolName: name,
      args,
    });
    debugLog(`agent.${options.backend ?? (options.definition.id === "browser-web" ? "browser-agent" : "api-search")}`, "tool_started", agentLogData({
      agentId: options.definition.id,
      runId: options.runId,
      tool: name,
      args,
    }));

    let toolResult: string;
    try {
      if (name === "agent_capability_load") {
        const groupId = typeof args.group === "string" ? args.group.trim().toLowerCase() : "";
        const group = options.definition.toolGroups?.[groupId];
        if (!group) {
          toolResult = `Error: grupo de tools no disponible para ${options.definition.id}: ${groupId || "(vacío)"}`;
        } else if (loadedToolGroups.has(groupId)) {
          toolResult = `El grupo '${groupId}' ya estaba cargado.`;
        } else {
          loadedToolGroups.add(groupId);
          toolResult = [
            `Grupo '${groupId}' cargado. Sus tools estarán disponibles en la siguiente ronda.`,
            ...(group.instructions ?? []).map((instruction) => `- ${instruction}`),
          ].join("\n");
        }
      } else if (name === "web_search") {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        toolResult = (await runSearchWithRetry(
          `${options.runId}:${query || "web_search"}`,
          () => (options.webSearchExecutor ?? executeWebSearchToolDetailed)(args, options.agentConfig.defaultSearchDepth, signal),
          signal,
        )).text;
      } else if (name === "read_url") {
        toolResult = await (options.readUrlExecutor ?? executeReadUrlTool)(args, signal);
      } else if (name.startsWith("browser_") && options.browserExecution) {
        toolResult = await options.browserExecution.executeTool(name, args, signal);
      } else if (name.startsWith("agent_workspace_") && options.workspace && options.jid && options.agentDir) {
        toolResult = await executeAgentWorkspaceTool(name, args, options.workspace, options.jid, options.agentDir);
      } else if (name.startsWith("skill_") && options.skills && options.workspace && options.jid) {
        toolResult = await executeSkillTool(name, args, options.skills, options.workspace, options.jid, signal, {
          executeDynamicCommands: false,
          allowScripts: false,
          destinationPrefix: options.agentDir,
        });
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
      runId: options.runId,
      agentId: options.definition.id,
      toolName: name,
      ok,
      resultChars: toolResult.length,
    });
    debugLog(`agent.${options.backend ?? (options.definition.id === "browser-web" ? "browser-agent" : "api-search")}`, "tool_completed", agentLogData({
      agentId: options.definition.id,
      runId: options.runId,
      tool: name,
      ok,
      resultChars: toolResult.length,
    }));
    return toolResult;
  };

  const complete = async (messages: ChatMessage[]) => await chatCompletionWithTools(
    messages,
    options.model,
    options.llmConfig,
    toolDefinitions(options.definition, loadedToolGroups),
    executeBoundTool,
    5,
    undefined,
    {
      maxRounds: options.definition.maxSteps,
      maxTokens: options.definition.maxOutputTokens,
      truncationRecoveryAttempts: 2,
      signal,
      usage: options.jid ? { jid: options.jid, purpose: options.backend === "browser-agent" ? "browser-agent" : "api-search" } : undefined,
      resolveTools: () => toolDefinitions(options.definition, loadedToolGroups),
    },
  );

  try {
    let result = await complete(agentMessages(options.definition, options.prompt));

    let output = result.content.trim();

    // browser-web no puede cerrar una misión únicamente porque le falte un dato
    // humano. El prompt sigue siendo la primera defensa, pero este guard vuelve
    // la regla autoritativa: intercepta el cierre, pide el dato con la tool
    // segura y continúa sobre la MISMA BrowserAgentExecution/sesión.
    if (options.definition.id === "browser-web" && options.browserExecution) {
      const MAX_AUTOMATIC_INPUT_RECOVERIES = 4;
      for (let recovery = 0; recovery < MAX_AUTOMATIC_INPUT_RECOVERIES; recovery += 1) {
        const request = await options.browserExecution.resolveAutomaticInputRequest(output, options.prompt, signal);
        if (!request) break;

        debugInfo("agent.browser-agent", "automatic_user_input_guard", agentLogData({
          agentId: options.definition.id,
          runId: options.runId,
          recovery: recovery + 1,
          kind: request.kind,
          fieldName: request.field_name,
          hasUrl: Boolean(request.url),
          hasUsername: Boolean(request.username),
        }));

        const previousOutput = output;
        const inputResult = await executeBoundTool("browser_request_user_input", request as unknown as Record<string, unknown>);
        if (inputResult.startsWith("Error:")) {
          output = `${previousOutput}\n\n${inputResult}`.trim();
          break;
        }

        const continuationPrompt = [
          options.prompt,
          "",
          "[SISTEMA: El runtime interceptó un cierre prematuro porque todavía faltaba un dato humano imprescindible. No finalices por ese bloqueo.]",
          `Respuesta final prematura anterior: ${previousOutput.slice(0, 4000)}`,
          `Resultado seguro de browser_request_user_input: ${inputResult.slice(0, 6000)}`,
          "Continúa la misión desde la página y sesión de navegador que siguen abiertas. Inspecciona el estado actual y usa las herramientas necesarias. Si falta otro dato humano, llama browser_request_user_input; no te limites a decir que lo necesitas.",
        ].join("\n");
        result = await complete(agentMessages(options.definition, continuationPrompt));
        output = result.content.trim();
      }

      const unresolved = await options.browserExecution.resolveAutomaticInputRequest(output, options.prompt, signal);
      if (unresolved) {
        throw new Error(
          `browser-web intentó cerrar repetidamente con un dato humano pendiente (${unresolved.field_name}). `
          + "El runtime evitó marcar la tarea como completada para no perder el flujo de autenticación.",
        );
      }
    }

    if (!output) throw new Error("El subagente terminó sin devolver una respuesta útil.");

    await options.onEvent?.({
      type: "agent_finished",
      runId: options.runId,
      agentId: options.definition.id,
      outputChars: output.length,
      toolsCalled: [...toolsCalled],
    });
    debugInfo(`agent.${options.backend ?? (options.definition.id === "browser-web" ? "browser-agent" : "api-search")}`, "finished", agentLogData({
      agentId: options.definition.id,
      runId: options.runId,
      outputChars: output.length,
      toolsCalled,
    }));

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
      runId: options.runId,
      agentId: options.definition.id,
      cancelled,
      error: message,
    });
    debugError(`agent.${options.backend ?? (options.definition.id === "browser-web" ? "browser-agent" : "api-search")}`, cancelled ? "cancelled" : timedOut ? "timeout" : "failed", error, agentLogData({
      agentId: options.definition.id,
      runId: options.runId,
      timeoutMs,
      toolsCalled,
    }));

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

export async function runAgent(options: RunAgentOptions): Promise<SpawnAgentReport> {
  const backend = options.backend ?? (options.definition.id === "browser-web" ? "browser-agent" : "api-search");
  return withAgentExecutionContext({
    backend,
    taskId: options.taskId ?? options.parentRunId,
    agentId: options.supervisorAgentId,
    agentName: options.supervisorAgentName,
    agentType: options.definition.id,
    runId: options.runId,
  }, () => runAgentInternal({ ...options, backend }));
}
