import type { ToolDefinition } from "../ai.ts";
import type { AgentConfig } from "../agent-config.ts";
import type { LlmConfig } from "../llm-config.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { TaskRuntime } from "../orchestration/task-runtime.ts";
import { debugError, debugInfo } from "../debug.ts";
import { MAIN_SPAWNABLE_AGENTS, normalizeAgentType, validateSpawnableAgent } from "./agent-registry.ts";
import { runAgent } from "./agent-runtime.ts";
import { deduplicateSpawnAgentRequests } from "./spawn-deduper.ts";
import type { AgentEvent, SpawnAgentReport, SpawnAgentRequest } from "./agent-types.ts";
import { BrowserAgentExecution } from "../browser/browser-runtime.ts";
import type { BrowserCredentialStore } from "../browser/browser-credentials.ts";

const MAX_AGENTS_PER_CALL = 8;
const MAX_PARENT_RESULT_CHARS = 8_000;
const MAX_PARENT_TOTAL_CHARS = 24_000;

export const SPAWN_AGENTS_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "spawn_agents",
    description: [
      "Crea subagentes especializados con contexto aislado y espera sus resultados.",
      "Úsala para delegar dos o más investigaciones independientes en paralelo; por ejemplo un researcher-web por proveedor, producto o tema.",
      "Cada subagente puede usar sus propias herramientas y devuelve únicamente su respuesta final compacta.",
      "La herramienta NO crea PDFs ni entrega archivos: cuando termine, tú recuperas el control, revisas los resultados, puedes lanzar investigaciones adicionales si algo falta y después debes crear/sintetizar los archivos solicitados con las herramientas normales.",
      "Para investigación web usa agent_type=researcher-web. Para navegación interactiva, login, extracción desde paneles, capturas o descargas usa agent_type=browser-web.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Nombre opcional para identificar la tarea de subagentes.",
        },
        agents: {
          type: "array",
          minItems: 1,
          maxItems: MAX_AGENTS_PER_CALL,
          items: {
            type: "object",
            properties: {
              agent_type: {
                type: "string",
                enum: ["researcher-web", "browser-web"],
                description: "Tipo de subagente permitido.",
              },
              prompt: {
                type: "string",
                description: "Misión autocontenida y específica para este subagente.",
              },
              params: {
                type: "object",
                description: "Parámetros opcionales reservados para futuras clases de agentes.",
                additionalProperties: true,
              },
            },
            required: ["agent_type", "prompt"],
            additionalProperties: false,
          },
        },
      },
      required: ["agents"],
      additionalProperties: false,
    },
  },
};

export const RESEARCHER_WEB_DIRECT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "researcher_web",
    description: [
      "Lanza un único investigador web en un contexto aislado.",
      "El investigador decide cuántas búsquedas y lecturas necesita, prioriza fuentes oficiales y devuelve una síntesis con URLs y puntos no resueltos.",
      "Después de recibir el resultado tú recuperas el control y decides si debes investigar algo más o realizar otras acciones.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Pregunta o misión exacta que debe resolver el investigador.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
};

export const BROWSER_WEB_DIRECT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_agent",
    description: [
      "Lanza un agente de navegador aislado para navegar sitios interactivos, iniciar sesión mediante credential_ref segura, extraer datos, tomar capturas o descargar archivos.",
      "El agente trabaja sin visión usando snapshots de accesibilidad y texto renderizado. Los archivos físicos quedan en el workdir y tú recuperas el control para crear PDFs o enviarlos por WhatsApp.",
      "Nunca incluyas una contraseña en prompt ni en argumentos: usa únicamente la credential_ref segura que el sistema haya colocado en el mensaje.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Misión exacta y autocontenida de navegación." },
        credential_ref: { type: "string", description: "Referencia segura opcional capturada fuera del LLM. Nunca contiene la contraseña." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
};

export const BROWSER_CREDENTIAL_REQUEST_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_request_credential",
    description: "Solicita al sistema capturar una contraseña de navegador fuera del LLM. Úsala en vez de pedir la contraseña directamente al usuario. El sistema enviará un mensaje claramente marcado como MENSAJE DEL SISTEMA y luego reanudará prompt con una credential_ref segura.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        username: { type: "string" },
        prompt: { type: "string", description: "Misión original que debe reanudarse después de capturar la contraseña." },
      },
      required: ["url", "username", "prompt"],
      additionalProperties: false,
    },
  },
};

export const AGENT_TASK_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "task_list",
      description: "Lista las tareas recientes de subagentes del usuario.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "task_status",
      description: "Consulta el estado y progreso persistido de una tarea de subagentes.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_cancel",
      description: "Cancela una tarea activa de subagentes y propaga la cancelación a sus herramientas.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
  },
];

export function getMainAgentTools(config: AgentConfig): ToolDefinition[] {
  const tools: ToolDefinition[] = [SPAWN_AGENTS_TOOL, BROWSER_WEB_DIRECT_TOOL, BROWSER_CREDENTIAL_REQUEST_TOOL];
  if (config.webSearchEnabled && config.researchSubagentEnabled) tools.push(RESEARCHER_WEB_DIRECT_TOOL);
  return [...tools, ...AGENT_TASK_TOOLS];
}

export type SpawnAgentsProgress =
  | { type: "task_started"; taskId: string; total: number }
  | { type: "agent_started"; taskId: string; index: number; total: number; agentType: string; prompt: string }
  | { type: "agent_completed"; taskId: string; index: number; total: number; agentType: string; status: SpawnAgentReport["status"] }
  | { type: "task_completed"; taskId: string; status: "completed" | "partial" | "failed" };

export type SpawnAgentsProgressHandler = (event: SpawnAgentsProgress) => void | Promise<void>;

export interface SpawnAgentsDependencies {
  jid: string;
  model: string;
  llmConfig: LlmConfig;
  agentConfig: AgentConfig;
  workspace: WorkspaceManager;
  tasks: TaskRuntime;
  onProgress?: SpawnAgentsProgressHandler;
  agentRunner?: typeof runAgent;
  /** Permite deduplicar llamadas equivalentes emitidas por el mismo mensaje del modelo. */
  filterRequests?: (agents: SpawnAgentRequest[]) => SpawnAgentRequest[];
  browserCredentials?: BrowserCredentialStore;
}

function parseRequests(args: Record<string, unknown>): SpawnAgentRequest[] {
  if (!Array.isArray(args.agents)) return [];
  return args.agents.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    const agentType = typeof raw.agent_type === "string" ? raw.agent_type.trim() : "";
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    const params = raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)
      ? raw.params as Record<string, unknown>
      : undefined;
    if (!agentType || !prompt) return [];
    return [{ agent_type: agentType, prompt, params }];
  });
}

function safeSegment(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "agent";
}

async function emit(handler: SpawnAgentsProgressHandler | undefined, event: SpawnAgentsProgress): Promise<void> {
  try {
    await handler?.(event);
  } catch (error) {
    console.warn("[agents] No se pudo emitir progreso de subagente:", error);
  }
}

function compactForParent(value: string, maxChars = MAX_PARENT_RESULT_CHARS): string {
  if (value.length <= maxChars) return value;
  const tailChars = Math.min(1_500, Math.floor(maxChars * 0.25));
  const headChars = Math.max(1, maxChars - tailChars);
  return `${value.slice(0, headChars)}\n\n[...resumen intermedio omitido para proteger el contexto del agente principal; la versión completa quedó guardada en el workdir...]\n\n${value.slice(-tailChars)}`;
}

function parentReportBudget(reportCount: number): number {
  if (reportCount <= 0) return MAX_PARENT_RESULT_CHARS;
  return Math.max(3_000, Math.min(MAX_PARENT_RESULT_CHARS, Math.floor(MAX_PARENT_TOTAL_CHARS / reportCount)));
}

export async function executeSpawnAgentsTool(
  args: Record<string, unknown>,
  dependencies: SpawnAgentsDependencies,
): Promise<string> {
  let requested = parseRequests(args);
  if (requested.length === 0) return "Error: agents debe contener al menos un subagente con agent_type y prompt.";
  if (requested.length > MAX_AGENTS_PER_CALL) return `Error: solo se permiten ${MAX_AGENTS_PER_CALL} subagentes por llamada.`;

  if (dependencies.filterRequests) requested = dependencies.filterRequests(requested);
  if (requested.length === 0) {
    return JSON.stringify({ status: "deduplicated", reports: [], message: "Las solicitudes equivalentes de subagentes ya se ejecutaron en esta ronda." });
  }

  for (const request of requested) {
    const definition = validateSpawnableAgent(request.agent_type, MAIN_SPAWNABLE_AGENTS);
    if (definition.id === "researcher-web" && (!dependencies.agentConfig.webSearchEnabled || !dependencies.agentConfig.researchSubagentEnabled)) {
      return "Error: el investigador web está desactivado en la configuración actual.";
    }
  }

  const { uniqueAgents, originalToUniqueIndex } = deduplicateSpawnAgentRequests(requested);
  const title = typeof args.title === "string" && args.title.trim()
    ? args.title.trim()
    : uniqueAgents.length === 1
      ? `Investigación: ${uniqueAgents[0]?.prompt?.slice(0, 70) ?? "subagente"}`
      : `Investigación paralela con ${uniqueAgents.length} subagentes`;
  const task = dependencies.tasks.create(dependencies.jid, title, uniqueAgents.length);
  const taskBase = task.record.taskPath;
  let completed = 0;

  debugInfo("agents.spawn", "task_started", {
    taskId: task.record.id,
    jid: dependencies.jid,
    requested: requested.length,
    unique: uniqueAgents.length,
    title,
  });
  await emit(dependencies.onProgress, { type: "task_started", taskId: task.record.id, total: uniqueAgents.length });

  try {
    const settled = await Promise.allSettled(uniqueAgents.map(async (request, index) => {
      const definition = validateSpawnableAgent(request.agent_type, MAIN_SPAWNABLE_AGENTS);
      const runId = `${task.record.id}-${safeSegment(definition.id)}-${index + 1}`;
      const agentDir = `${taskBase}/agents/${String(index + 1).padStart(2, "0")}-${safeSegment(definition.id)}`;
      const credentialRef = definition.id === "browser-web" && typeof request.params?.credential_ref === "string"
        ? request.params.credential_ref.trim()
        : "";
      const agentPrompt = credentialRef && !request.prompt?.includes(credentialRef)
        ? `${request.prompt}\n\n[SISTEMA: Usa credential_ref=${credentialRef} únicamente con browser_auth_login. La contraseña está fuera del LLM.]`
        : request.prompt ?? "";
      const events: AgentEvent[] = [];
      dependencies.workspace.writeText(dependencies.jid, `${agentDir}/request.json`, `${JSON.stringify({
        agentType: definition.id,
        displayName: definition.displayName,
        prompt: agentPrompt,
        params: request.params ?? null,
        runId,
      }, null, 2)}\n`);

      await emit(dependencies.onProgress, {
        type: "agent_started",
        taskId: task.record.id,
        index,
        total: uniqueAgents.length,
        agentType: definition.id,
        prompt: agentPrompt,
      });

      const report = await (dependencies.agentRunner ?? runAgent)({
        definition,
        prompt: agentPrompt,
        model: dependencies.model,
        llmConfig: dependencies.llmConfig,
        agentConfig: dependencies.agentConfig,
        runId,
        parentRunId: task.record.id,
        parentSignal: task.signal,
        browserExecution: definition.id === "browser-web" && dependencies.browserCredentials
          ? new BrowserAgentExecution({
              jid: dependencies.jid,
              runId,
              taskId: task.record.id,
              agentDir,
              workspace: dependencies.workspace,
              credentials: dependencies.browserCredentials,
            })
          : undefined,
        onEvent: async (event) => {
          events.push(event);
          dependencies.workspace.writeText(
            dependencies.jid,
            `${agentDir}/events.jsonl`,
            `${events.map((item) => JSON.stringify(item)).join("\n")}\n`,
          );
        },
      });

      const fullResult = report.result ?? "";
      dependencies.workspace.writeText(
        dependencies.jid,
        `${agentDir}/result.md`,
        fullResult || `# ${definition.displayName}\n\nEstado: ${report.status}\n\nError: ${report.error ?? "Sin respuesta"}\n`,
      );
      dependencies.workspace.writeText(dependencies.jid, `${agentDir}/result.json`, `${JSON.stringify(report, null, 2)}\n`);

      completed += 1;
      dependencies.tasks.update(dependencies.jid, task.record.id, { completedWorkers: completed });
      await emit(dependencies.onProgress, {
        type: "agent_completed",
        taskId: task.record.id,
        index,
        total: uniqueAgents.length,
        agentType: definition.id,
        status: report.status,
      });
      return report;
    }));

    const uniqueReports: SpawnAgentReport[] = settled.map((entry, index) => {
      if (entry.status === "fulfilled") return entry.value;
      const request = uniqueAgents[index];
      const agentType = normalizeAgentType(request?.agent_type ?? "unknown");
      const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
      debugError("agents.spawn", "worker_crashed", entry.reason, {
        taskId: task.record.id,
        index,
        agentType,
      });
      return {
        agentType,
        agentName: agentType,
        prompt: request?.prompt ?? "",
        runId: `${task.record.id}-${agentType}-${index + 1}`,
        status: task.signal.aborted ? "cancelled" : "failed",
        error: reason,
        toolsCalled: [],
      };
    });

    const reports = originalToUniqueIndex.map((uniqueIndex) => uniqueReports[uniqueIndex]).filter((item): item is SpawnAgentReport => Boolean(item));
    const completedCount = uniqueReports.filter((report) => report.status === "completed").length;
    const failedCount = uniqueReports.length - completedCount;
    const status = completedCount === uniqueReports.length
      ? "completed"
      : completedCount > 0
        ? "partial"
        : "failed";

    dependencies.workspace.writeText(dependencies.jid, `${taskBase}/result.json`, `${JSON.stringify({
      taskId: task.record.id,
      status,
      reports: uniqueReports,
    }, null, 2)}\n`);
    dependencies.tasks.update(dependencies.jid, task.record.id, {
      status,
      completedWorkers: uniqueReports.length,
      error: failedCount > 0 ? `${failedCount} subagente(s) no completaron la tarea.` : undefined,
    });
    await emit(dependencies.onProgress, { type: "task_completed", taskId: task.record.id, status });
    debugInfo("agents.spawn", "task_completed", {
      taskId: task.record.id,
      status,
      completed: completedCount,
      failed: failedCount,
    });

    const resultBudget = parentReportBudget(reports.length);
    return JSON.stringify({
      task_id: task.record.id,
      status,
      note: "Los informes completos de cada subagente están guardados en el workdir. Los textos siguientes son handoffs compactos para que el agente principal continúe sin saturar el proveedor LLM.",
      reports: reports.map((report) => ({
        agent_type: report.agentType,
        agent_name: report.agentName,
        prompt: report.prompt.length > 500 ? `${report.prompt.slice(0, 500)}…` : report.prompt,
        status: report.status,
        result: report.result ? compactForParent(report.result, resultBudget) : undefined,
        error: report.error,
      })),
    }, null, 2);
  } catch (error) {
    const cancelled = task.signal.aborted;
    const reason = error instanceof Error ? error.message : String(error);
    dependencies.tasks.update(dependencies.jid, task.record.id, {
      status: cancelled ? "cancelled" : "failed",
      error: reason,
    });
    debugError("agents.spawn", cancelled ? "task_cancelled" : "task_failed", error, { taskId: task.record.id });
    return cancelled
      ? `Error: la tarea ${task.record.id} fue cancelada.`
      : `Error: la tarea ${task.record.id} falló: ${reason}`;
  }
}

export async function executeResearcherWebTool(
  args: Record<string, unknown>,
  dependencies: SpawnAgentsDependencies,
): Promise<string> {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return "Error: prompt es obligatorio.";
  const raw = await executeSpawnAgentsTool(
    { title: `Investigación web: ${prompt.slice(0, 70)}`, agents: [{ agent_type: "researcher-web", prompt }] },
    dependencies,
  );
  if (raw.startsWith("Error:")) return raw;
  try {
    const parsed = JSON.parse(raw) as { reports?: Array<{ result?: string; error?: string; status?: string }>; task_id?: string };
    const report = parsed.reports?.[0];
    if (report?.result) return report.result;
    return report?.error ? `Error: ${report.error}` : raw;
  } catch {
    return raw;
  }
}

export async function executeBrowserWebTool(
  args: Record<string, unknown>,
  dependencies: SpawnAgentsDependencies,
): Promise<string> {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return "Error: prompt es obligatorio.";
  const credentialRef = typeof args.credential_ref === "string" ? args.credential_ref.trim() : "";
  const safePrompt = credentialRef
    ? `${prompt}\n\n[SISTEMA: Usa credential_ref=${credentialRef} únicamente con browser_auth_login. La contraseña no está disponible para el LLM y nunca debes pedirla ni repetirla.]`
    : prompt;
  const raw = await executeSpawnAgentsTool(
    { title: `Navegación web: ${prompt.slice(0, 70)}`, agents: [{ agent_type: "browser-web", prompt: safePrompt, params: credentialRef ? { credential_ref: credentialRef } : undefined }] },
    dependencies,
  );
  if (raw.startsWith("Error:")) return raw;
  try {
    const parsed = JSON.parse(raw) as { reports?: Array<{ result?: string; error?: string }>; task_id?: string };
    const report = parsed.reports?.[0];
    if (report?.result) return JSON.stringify({ task_id: parsed.task_id, result: report.result }, null, 2);
    return report?.error ? `Error: ${report.error}` : raw;
  } catch {
    return raw;
  }
}

export function executeAgentTaskTool(
  name: string,
  args: Record<string, unknown>,
  dependencies: Pick<SpawnAgentsDependencies, "jid" | "tasks">,
): string {
  if (name === "task_list") {
    const tasks = dependencies.tasks.list(dependencies.jid);
    if (tasks.length === 0) return "No hay tareas registradas.";
    return tasks.map((task, index) => `${index + 1}. ${task.id} — ${task.status} — ${task.title} — ${task.completedWorkers}/${task.totalWorkers}`).join("\n");
  }
  const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (!taskId) return "Error: task_id es obligatorio.";
  if (name === "task_status") {
    const task = dependencies.tasks.get(dependencies.jid, taskId);
    return task ? JSON.stringify(task, null, 2) : `Error: no existe la tarea ${taskId}.`;
  }
  if (name === "task_cancel") {
    return dependencies.tasks.cancel(dependencies.jid, taskId)
      ? `✅ Tarea ${taskId} cancelada.`
      : `Error: no se encontró una tarea activa con ID ${taskId}.`;
  }
  return `Error: herramienta de tareas desconocida "${name}".`;
}
