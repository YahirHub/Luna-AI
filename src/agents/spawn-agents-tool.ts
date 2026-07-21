import type { ToolDefinition } from "../ai.ts";
import type { AgentConfig } from "../agent-config.ts";
import type { LlmConfig } from "../llm-config.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { TaskRuntime } from "../orchestration/task-runtime.ts";
import { debugError, debugInfo, debugLog } from "../debug.ts";
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
      "Crea subagentes especializados con contexto aislado. Puede ejecutarlos en primer plano o en segundo plano.",
      "Úsala para delegar trabajos independientes en paralelo. El backend api-search consulta proveedores configurados en /setup-search; browser-agent controla un navegador real mediante agent-browser.",
      "Cada subagente puede usar sus propias herramientas y devuelve únicamente su respuesta final compacta.",
      "La herramienta NO crea PDFs ni entrega archivos: cuando termine, tú recuperas el control, revisas los resultados, puedes lanzar investigaciones adicionales si algo falta y después debes crear/sintetizar los archivos solicitados con las herramientas normales.",
      "Internamente usa agent_type=researcher-web para api-search y agent_type=browser-web para browser-agent. En mensajes, estados y logs siempre se mostrarán los nombres públicos api-search o browser-agent.",
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
              name: {
                type: "string",
                description: "Nombre corto opcional para identificar al agente en el supervisor.",
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
        background: {
          type: "boolean",
          description: "Si es true, inicia la tarea y devuelve control inmediatamente para seguir conversando mientras los agentes trabajan.",
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
      "Lanza un único agente api-search en un contexto aislado usando los proveedores configurados mediante /setup-search.",
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
      "Lanza un browser-agent aislado que controla agent-browser para navegar sitios interactivos, iniciar sesión mediante credential_ref segura, extraer datos, tomar capturas o descargar archivos.",
      "El agente trabaja sin visión usando snapshots de accesibilidad y texto renderizado. Los archivos físicos quedan en el workdir y tú recuperas el control para crear PDFs o enviarlos por el chat activo.",
      "Nunca incluyas una contraseña en prompt ni en argumentos: usa únicamente la credential_ref segura que el sistema haya colocado en el mensaje.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre corto opcional para identificar esta tarea/agente de navegador." },
        prompt: { type: "string", description: "Misión exacta y autocontenida de navegación." },
        credential_ref: { type: "string", description: "Referencia segura opcional capturada fuera del LLM. Nunca contiene la contraseña." },
        background: { type: "boolean", description: "Por defecto true. Permite seguir conversando mientras el navegador trabaja." },
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
    description: "Solicita al sistema capturar una contraseña de navegador fuera del LLM antes de iniciar una navegación. Úsala principalmente cuando el usuario quiera configurar una credencial por adelantado. Para una tarea browser_agent ya iniciada, deja que browser-web use browser_request_user_input para pausar y reanudar la misma sesión sin crear otra tarea.",
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

export const BROWSER_CREDENTIAL_CONTROL_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "browser_credentials_list",
      description: "Lista las cuentas de navegador guardadas por el sistema para el usuario actual. Devuelve URL, correo/usuario y una referencia opaca, nunca contraseñas. Soporta varias cuentas por sitio.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          username: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_credentials_save",
      description: "Guarda o reemplaza de forma cifrada una credencial temporal browser-cred-* que el sistema ya capturó fuera del LLM. Úsala cuando el usuario pida configurar/guardar credenciales sin necesidad de navegar.",
      parameters: {
        type: "object",
        properties: {
          credential_ref: { type: "string" },
          label: { type: "string" },
        },
        required: ["credential_ref"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_credentials_delete",
      description: "Elimina un perfil de credenciales de navegador guardado para el usuario actual.",
      parameters: {
        type: "object",
        properties: { credential_ref: { type: "string" } },
        required: ["credential_ref"],
        additionalProperties: false,
      },
    },
  },
];

export const AGENT_TASK_TOOLS: ToolDefinition[] = [
  { type: "function", function: { name: "task_list", description: "Lista tareas recientes y su estado de revisión.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "task_status", description: "Consulta el estado persistido de una tarea y sus agentes, incluyendo qué hace cada uno ahora.", parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false } } },
  { type: "function", function: { name: "task_inspect", description: "Inspecciona la carpeta completa de una tarea: resultados, eventos, capturas, descargas y archivos creados. Úsala para revisar realmente una tarea antes de responder.", parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false } } },
  { type: "function", function: { name: "task_review", description: "Marca como revisado el resultado de una tarea terminada después de inspeccionarlo.", parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false } } },
  { type: "function", function: { name: "task_cancel", description: "Cancela una tarea activa y todos sus agentes sin cancelar la conversación principal.", parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false } } },
  { type: "function", function: { name: "task_cancel_all", description: "Cancela todas las tareas de fondo activas del usuario sin detener la conversación principal.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "agent_list", description: "Lista agentes recientes, activos y terminados pendientes de revisión.", parameters: { type: "object", properties: { task_id: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "agent_status", description: "Consulta el estado de un agente por ID o nombre.", parameters: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"], additionalProperties: false } } },
  { type: "function", function: { name: "agent_review", description: "Marca como revisado un agente terminado después de inspeccionar su resultado.", parameters: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"], additionalProperties: false } } },
  { type: "function", function: { name: "agent_cancel", description: "Cancela un agente activo concreto por ID o nombre sin afectar a los demás ni a la conversación.", parameters: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"], additionalProperties: false } } },
];

export function getMainAgentTools(config: AgentConfig): ToolDefinition[] {
  const tools: ToolDefinition[] = [SPAWN_AGENTS_TOOL, BROWSER_WEB_DIRECT_TOOL, BROWSER_CREDENTIAL_REQUEST_TOOL, ...BROWSER_CREDENTIAL_CONTROL_TOOLS];
  if (config.webSearchEnabled && config.researchSubagentEnabled) tools.push(RESEARCHER_WEB_DIRECT_TOOL);
  return [...tools, ...AGENT_TASK_TOOLS];
}

export type SpawnAgentsProgress =
  | { type: "task_registered"; taskId: string; title: string; total: number; background: boolean }
  | { type: "agent_started"; taskId: string; agentId: string; agentName: string; backend: "browser-agent" | "api-search"; index: number; total: number; agentType: string; prompt: string }
  | { type: "agent_activity"; taskId: string; agentId: string; agentName: string; backend: "browser-agent" | "api-search"; activity: string }
  | { type: "agent_completed"; taskId: string; agentId: string; agentName: string; backend: "browser-agent" | "api-search"; index: number; total: number; agentType: string; status: SpawnAgentReport["status"] }
  | { type: "task_completed"; taskId: string; status: "completed" | "partial" | "failed" | "cancelled"; background?: boolean };

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
  /** Texto original del usuario, usado para reanudar una tarea después de pedir un dato humano. */
  resumePrompt?: string;
  /** Permite al subagente pedir datos al usuario mediante un mensaje de sistema. */
  onSystemMessage?: (text: string) => void | Promise<void>;
  /** Envía una captura/archivo generado por el agente mientras espera datos. */
  onSystemArtifact?: (path: string, caption: string) => void | Promise<void>;
  /** Activa la revisión automática del orquestador al terminar una tarea background. */
  onBackgroundCompleted?: (taskId: string) => void | Promise<void>;
}

function parseRequests(args: Record<string, unknown>): SpawnAgentRequest[] {
  if (!Array.isArray(args.agents)) return [];
  return args.agents.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    const agentType = typeof raw.agent_type === "string" ? raw.agent_type.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    const params = raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)
      ? raw.params as Record<string, unknown>
      : undefined;
    if (!agentType || !prompt) return [];
    return [{ agent_type: agentType, name: name || undefined, prompt, params }];
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

function conciseAgentName(prompt: string, fallback: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return clean ? clean.slice(0, 72) : fallback;
}

function describeAgentActivity(toolName: string, args: Record<string, unknown>): string {
  const text = (key: string) => typeof args[key] === "string" ? String(args[key]).trim() : "";
  switch (toolName) {
    case "browser_open": return `Abriendo ${text("url") || "el sitio"}`;
    case "browser_snapshot": return "Inspeccionando los campos y controles de la página";
    case "browser_read": return "Leyendo el contenido visible de la página";
    case "browser_click": return `Haciendo clic en ${text("selector") || "un control"}`;
    case "browser_fill": return `Escribiendo en ${text("selector") || "un campo"}`;
    case "browser_fill_secret": return `Completando de forma segura ${text("selector") || "un campo protegido"}`;
    case "browser_type": return `Escribiendo en ${text("selector") || "un campo"}`;
    case "browser_press": return `Enviando la tecla ${text("key") || "solicitada"}`;
    case "browser_wait": return "Esperando que la página termine de cargar";
    case "browser_get_text": return `Leyendo ${text("selector") || "un elemento"}`;
    case "browser_get_url": return "Comprobando la página actual";
    case "browser_screenshot": return `Tomando la captura ${text("filename") || "solicitada"}`;
    case "browser_download": return `Descargando ${text("filename") || "un archivo"}`;
    case "browser_auth_profiles": return "Buscando una credencial cifrada compatible";
    case "browser_auth_login": return "Intentando iniciar sesión con una credencial segura";
    case "browser_auth_confirm": return "Confirmando y guardando el acceso cifrado";
    case "browser_request_user_input": return `Esperando ${text("field_name") || "un dato del usuario"}`;
    case "web_search": return `Consultando proveedores API: ${text("query") || "información en la web"}`;
    case "read_url": return `Verificando fuente encontrada por API: ${text("url") || "una URL"}`;
    default: return `Ejecutando ${toolName}`;
  }
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

async function runSpawnTask(
  uniqueAgents: SpawnAgentRequest[],
  originalToUniqueIndex: number[],
  task: ReturnType<TaskRuntime["create"]>,
  dependencies: SpawnAgentsDependencies,
  background: boolean,
): Promise<string> {
  const taskBase = task.record.taskPath;
  let completed = 0;
  const agentRecords: Array<ReturnType<TaskRuntime["createAgent"]>["record"] | undefined> = [];

  try {
    const settled = await Promise.allSettled(uniqueAgents.map(async (request, index) => {
      const definition = validateSpawnableAgent(request.agent_type, MAIN_SPAWNABLE_AGENTS);
      const runId = `${task.record.id}-${safeSegment(definition.id)}-${index + 1}`;
      const agentDir = `${taskBase}/agents/${String(index + 1).padStart(2, "0")}-${safeSegment(definition.id)}`;
      const agentName = request.name?.trim()
        || conciseAgentName(request.prompt ?? "", definition.displayName);
      const tracked = dependencies.tasks.createAgent(dependencies.jid, task.record.id, {
        name: agentName,
        agentType: definition.id,
        backend: definition.backend,
        runId,
        agentPath: agentDir,
        prompt: request.prompt ?? "",
      });
      agentRecords[index] = tracked.record;
      debugInfo(`supervisor.${definition.backend}`, "agent_registered", {
        backend: definition.backend,
        taskId: task.record.id,
        agentId: tracked.record.id,
        agentName,
        agentType: definition.id,
        runId,
        action: "Agente registrado y en cola",
      });

      const credentialRef = definition.id === "browser-web" && typeof request.params?.credential_ref === "string"
        ? request.params.credential_ref.trim()
        : "";
      const agentPrompt = credentialRef && !request.prompt?.includes(credentialRef)
        ? `${request.prompt}\n\n[SISTEMA: Usa credential_ref=${credentialRef} únicamente con browser_auth_login. La contraseña está fuera del LLM.]`
        : request.prompt ?? "";
      const events: AgentEvent[] = [];
      dependencies.workspace.writeText(dependencies.jid, `${agentDir}/request.json`, `${JSON.stringify({
        agentId: tracked.record.id,
        agentName,
        agentType: definition.id,
        backend: definition.backend,
        displayName: definition.displayName,
        prompt: agentPrompt,
        params: request.params ?? null,
        runId,
      }, null, 2)}\n`);

      const browserExecution = definition.id === "browser-web" && dependencies.browserCredentials
        ? new BrowserAgentExecution({
            jid: dependencies.jid,
            runId,
            taskId: task.record.id,
            agentId: tracked.record.id,
            agentName,
            agentDir,
            workspace: dependencies.workspace,
            credentials: dependencies.browserCredentials,
            resumePrompt: dependencies.resumePrompt ?? request.prompt ?? "",
            onStateChange: async (state) => {
              dependencies.tasks.updateAgent(dependencies.jid, tracked.record.id, {
                status: state,
                ...(state === "running" ? {
                  waitingFieldName: undefined,
                  waitingRequestId: undefined,
                  waitingScreenshotPath: undefined,
                } : {}),
              });
            },
            onUserInputRequest: async (input) => {
              const secret = input.kind === "password" || input.kind === "otp";
              const heading = secret ? "🔐 MENSAJE DEL SISTEMA" : "🧩 MENSAJE DEL SISTEMA";
              dependencies.tasks.updateAgent(dependencies.jid, tracked.record.id, {
                status: "waiting_user",
                activity: `Esperando ${input.fieldName}`,
                waitingFieldName: input.fieldName,
                waitingRequestId: input.requestId,
                waitingScreenshotPath: input.screenshotPath,
              });
              const lines = [
                heading,
                "",
                secret
                  ? `Envía ahora ${input.fieldName} para continuar.`
                  : (input.message || `La tarea necesita ${input.fieldName} para continuar.`),
              ];
              if (input.url) lines.push(`Sitio: ${input.url}`);
              if (input.username) lines.push(`Cuenta: ${input.username}`);
              lines.push(
                `Agente: browser-agent ${tracked.record.id} — ${agentName}`,
                "",
                `Responde con: ${tracked.record.id} <dato>`,
                input.kind === "text"
                  ? "Para datos libres usa siempre el ID del agente, así puedes seguir conversando sin que otro mensaje se interprete como respuesta."
                  : "Si esta es la única solicitud pendiente, también puedes enviar solo un usuario, contraseña o código con formato inequívoco.",
                secret
                  ? "El valor se capturará fuera del modelo y se inyectará únicamente en esta tarea. Si la cuenta es incorrecta, escribe: corregir usuario."
                  : "La misma sesión del navegador permanecerá abierta mientras respondes.",
              );
              if (input.screenshotPath) {
                try {
                  await dependencies.onSystemArtifact?.(
                    input.screenshotPath,
                    `Vista actual de browser-agent ${tracked.record.id}. Revisa el campo solicitado antes de responder.`,
                  );
                } catch (error) {
                  debugError("agents.spawn", "input_screenshot_send_failed", error, {
                    taskId: task.record.id,
                    agentId: tracked.record.id,
                    path: input.screenshotPath,
                  });
                }
              }
              await dependencies.onSystemMessage?.(lines.join("\n"));
            },
          })
        : undefined;

      const unregisterTerminator = browserExecution
        ? dependencies.tasks.registerAgentTerminator(dependencies.jid, tracked.record.id, (reason) => browserExecution.cancel(reason))
        : () => undefined;

      let report: SpawnAgentReport;
      try {
        report = await (dependencies.agentRunner ?? runAgent)({
          definition,
          prompt: agentPrompt,
          model: dependencies.model,
          llmConfig: dependencies.llmConfig,
          agentConfig: dependencies.agentConfig,
          runId,
          parentRunId: task.record.id,
          supervisorAgentId: tracked.record.id,
          supervisorAgentName: agentName,
          parentSignal: tracked.signal,
          browserExecution,
          onEvent: async (event) => {
            events.push(event);
            dependencies.workspace.writeText(
              dependencies.jid,
              `${agentDir}/events.jsonl`,
              `${events.map((item) => JSON.stringify(item)).join("\n")}\n`,
            );
            if (event.type === "agent_started") {
              dependencies.tasks.update(dependencies.jid, task.record.id, { status: "running" });
              dependencies.tasks.updateAgent(dependencies.jid, tracked.record.id, {
                status: "running",
                activity: "Analizando la misión y preparando el primer paso",
              });
              await emit(dependencies.onProgress, {
                type: "agent_started",
                taskId: task.record.id,
                agentId: tracked.record.id,
                agentName,
                backend: definition.backend,
                index,
                total: uniqueAgents.length,
                agentType: definition.id,
                prompt: request.prompt ?? "",
              });
              debugInfo(`supervisor.${definition.backend}`, "agent_started", {
                backend: definition.backend, taskId: task.record.id, agentId: tracked.record.id, agentName, agentType: definition.id, runId,
                action: definition.backend === "browser-agent" ? "Navegación interactiva iniciada" : "Investigación mediante APIs iniciada",
              });
            } else if (event.type === "tool_started") {
              const activity = describeAgentActivity(event.toolName, event.args);
              dependencies.tasks.updateAgentActivity(dependencies.jid, tracked.record.id, activity, event.toolName);
              await emit(dependencies.onProgress, {
                type: "agent_activity",
                taskId: task.record.id,
                agentId: tracked.record.id,
                agentName,
                backend: definition.backend,
                activity,
              });
              debugLog(`supervisor.${definition.backend}`, "agent_activity", {
                backend: definition.backend, taskId: task.record.id, agentId: tracked.record.id, agentName, agentType: definition.id, runId,
                tool: event.toolName, action: activity,
              });
            } else if (event.type === "tool_completed") {
              dependencies.tasks.updateAgentActivity(
                dependencies.jid,
                tracked.record.id,
                event.ok ? `Procesando el resultado de ${event.toolName}` : `Recuperándose de un error en ${event.toolName}`,
              );
            }
          },
        });
      } finally {
        unregisterTerminator();
        if (browserExecution) await browserExecution.finalize();
      }

      const fullResult = report.result ?? "";
      const resultPath = `${agentDir}/result.md`;
      dependencies.workspace.writeText(
        dependencies.jid,
        resultPath,
        fullResult || `# ${definition.displayName}\n\nEstado: ${report.status}\n\nError: ${report.error ?? "Sin respuesta"}\n`,
      );
      const latestAgentState = dependencies.tasks.getAgent(dependencies.jid, tracked.record.id);
      if (latestAgentState?.status === "cancelled" && report.status !== "cancelled") {
        report = { ...report, status: "cancelled", result: undefined, error: latestAgentState.error ?? "Cancelado por el usuario." };
      }
      dependencies.workspace.writeText(dependencies.jid, `${agentDir}/result.json`, `${JSON.stringify(report, null, 2)}\n`);
      dependencies.tasks.updateAgent(dependencies.jid, tracked.record.id, {
        status: report.status,
        reviewStatus: "pending",
        resultPath,
        error: report.error,
      });

      completed += 1;
      dependencies.tasks.update(dependencies.jid, task.record.id, { completedWorkers: completed });
      await emit(dependencies.onProgress, {
        type: "agent_completed",
        taskId: task.record.id,
        agentId: tracked.record.id,
        agentName,
        backend: definition.backend,
        index,
        total: uniqueAgents.length,
        agentType: definition.id,
        status: report.status,
      });
      debugInfo(`supervisor.${definition.backend}`, "agent_completed", {
        backend: definition.backend, taskId: task.record.id, agentId: tracked.record.id, agentName, agentType: definition.id, runId,
        action: report.status === "completed" ? "Agente terminado" : report.status === "cancelled" ? "Agente cancelado" : "Agente falló",
        status: report.status,
      });
      return report;
    }));

    const uniqueReports: SpawnAgentReport[] = settled.map((entry, index) => {
      if (entry.status === "fulfilled") return entry.value;
      const request = uniqueAgents[index];
      const agentType = normalizeAgentType(request?.agent_type ?? "unknown");
      const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
      const tracked = agentRecords[index];
      const current = tracked ? dependencies.tasks.getAgent(dependencies.jid, tracked.id) : undefined;
      const workerStatus: "cancelled" | "failed" = current?.status === "cancelled" || task.signal.aborted ? "cancelled" : "failed";
      if (tracked) {
        dependencies.tasks.updateAgent(dependencies.jid, tracked.id, {
          status: workerStatus,
          reviewStatus: "pending",
          error: reason,
        });
      }
      debugError("agents.spawn", "worker_crashed", entry.reason, { taskId: task.record.id, index, agentType });
      return {
        agentType,
        agentName: request?.name || agentType,
        prompt: request?.prompt ?? "",
        runId: `${task.record.id}-${agentType}-${index + 1}`,
        status: workerStatus,
        error: reason,
        toolsCalled: [],
      };
    });

    const reports = originalToUniqueIndex.map((uniqueIndex) => uniqueReports[uniqueIndex]).filter((item): item is SpawnAgentReport => Boolean(item));
    const completedCount = uniqueReports.filter((report) => report.status === "completed").length;
    const cancelledCount = uniqueReports.filter((report) => report.status === "cancelled").length;
    const failedCount = uniqueReports.filter((report) => report.status === "failed").length;
    const status: "completed" | "partial" | "failed" | "cancelled" = task.signal.aborted
      ? "cancelled"
      : completedCount === uniqueReports.length
        ? "completed"
        : completedCount > 0
          ? "partial"
          : cancelledCount === uniqueReports.length
            ? "cancelled"
            : "failed";

    dependencies.workspace.writeText(dependencies.jid, `${taskBase}/result.json`, `${JSON.stringify({ taskId: task.record.id, status, reports: uniqueReports }, null, 2)}\n`);
    dependencies.tasks.update(dependencies.jid, task.record.id, {
      status,
      reviewStatus: "pending",
      completedWorkers: uniqueReports.length,
      error: status === "cancelled" ? "Cancelada por el usuario." : failedCount > 0 ? `${failedCount} subagente(s) no completaron la tarea.` : undefined,
    });
    await emit(dependencies.onProgress, { type: "task_completed", taskId: task.record.id, status, background });
    if (background && status !== "cancelled") {
      try {
        await dependencies.onBackgroundCompleted?.(task.record.id);
      } catch (error) {
        debugError("agents.spawn", "background_review_failed", error, { taskId: task.record.id });
      }
    }
    debugInfo("agents.spawn", status === "cancelled" ? "task_cancelled" : "task_completed", {
      taskId: task.record.id, status, completed: completedCount, failed: failedCount, cancelled: cancelledCount,
    });

    if (status === "cancelled") return `Error: la tarea ${task.record.id} fue cancelada por el usuario.`;
    const resultBudget = parentReportBudget(reports.length);
    return JSON.stringify({
      task_id: task.record.id,
      status,
      reports: reports.map((report, index) => ({
        agent_id: agentRecords[originalToUniqueIndex[index] ?? index]?.id,
        agent_type: report.agentType,
        backend: agentRecords[originalToUniqueIndex[index] ?? index]?.backend,
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
    const status: "cancelled" | "failed" = cancelled ? "cancelled" : "failed";
    dependencies.tasks.update(dependencies.jid, task.record.id, {
      status,
      reviewStatus: "pending",
      error: reason,
    });
    await emit(dependencies.onProgress, { type: "task_completed", taskId: task.record.id, status, background });
    if (background && !cancelled) {
      try {
        await dependencies.onBackgroundCompleted?.(task.record.id);
      } catch (reviewError) {
        debugError("agents.spawn", "background_review_failed", reviewError, { taskId: task.record.id });
      }
    }
    debugError("agents.spawn", cancelled ? "task_cancelled" : "task_failed", error, { taskId: task.record.id });
    return cancelled ? `Error: la tarea ${task.record.id} fue cancelada.` : `Error: la tarea ${task.record.id} falló: ${reason}`;
  }
}

export async function executeSpawnAgentsTool(
  args: Record<string, unknown>,
  dependencies: SpawnAgentsDependencies,
): Promise<string> {
  let requested = parseRequests(args);
  if (requested.length === 0) return "Error: agents debe contener al menos un subagente con agent_type y prompt.";
  if (requested.length > MAX_AGENTS_PER_CALL) return `Error: solo se permiten ${MAX_AGENTS_PER_CALL} subagentes por llamada.`;
  if (dependencies.filterRequests) requested = dependencies.filterRequests(requested);
  if (requested.length === 0) return JSON.stringify({ status: "deduplicated", reports: [], message: "Las solicitudes equivalentes de subagentes ya se ejecutaron en esta ronda." });

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
      ? `${uniqueAgents[0]?.name || "Tarea"}: ${uniqueAgents[0]?.prompt?.slice(0, 70) ?? "subagente"}`
      : `Tarea paralela con ${uniqueAgents.length} subagentes`;
  const task = dependencies.tasks.create(dependencies.jid, title, uniqueAgents.length);
  const background = args.background === true;

  debugInfo("agents.spawn", "task_started", { taskId: task.record.id, jid: dependencies.jid, requested: requested.length, unique: uniqueAgents.length, title, background, backends: uniqueAgents.map((agent) => validateSpawnableAgent(agent.agent_type, MAIN_SPAWNABLE_AGENTS).backend) });
  await emit(dependencies.onProgress, {
    type: "task_registered",
    taskId: task.record.id,
    title: task.record.title,
    total: uniqueAgents.length,
    background,
  });

  if (background) {
    void runSpawnTask(uniqueAgents, originalToUniqueIndex, task, dependencies, true).catch((error) => {
      debugError("agents.spawn", "background_task_crashed", error, { taskId: task.record.id });
    });
    return JSON.stringify({
      task_id: task.record.id,
      title: task.record.title,
      status: "queued",
      background: true,
      message: "La tarea quedó registrada y el supervisor confirmará cuando el agente comience realmente. Puedes seguir conversando. Usa task_list/agent_list para verla o task_cancel/agent_cancel para detenerla.",
    }, null, 2);
  }

  const result = await runSpawnTask(uniqueAgents, originalToUniqueIndex, task, dependencies, false);
  if (!result.startsWith("Error:")) dependencies.tasks.reviewTask(dependencies.jid, task.record.id);
  return result;
}

export async function executeResearcherWebTool(
  args: Record<string, unknown>,
  dependencies: SpawnAgentsDependencies,
): Promise<string> {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return "Error: prompt es obligatorio.";
  const raw = await executeSpawnAgentsTool(
    { title: `Investigación web: ${prompt.slice(0, 70)}`, background: false, agents: [{ agent_type: "researcher-web", prompt }] },
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
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const background = args.background !== false;
  const raw = await executeSpawnAgentsTool(
    {
      title: name || `Navegación web: ${prompt.slice(0, 70)}`,
      background,
      agents: [{ agent_type: "browser-web", name: name || undefined, prompt, params: credentialRef ? { credential_ref: credentialRef } : undefined }],
    },
    dependencies,
  );
  if (background || raw.startsWith("Error:")) return raw;
  try {
    const parsed = JSON.parse(raw) as { reports?: Array<{ result?: string; error?: string }>; task_id?: string };
    const report = parsed.reports?.[0];
    if (report?.result) return JSON.stringify({ task_id: parsed.task_id, result: report.result }, null, 2);
    return report?.error ? `Error: ${report.error}` : raw;
  } catch {
    return raw;
  }
}

export function executeBrowserCredentialControlTool(
  name: string,
  args: Record<string, unknown>,
  dependencies: Pick<SpawnAgentsDependencies, "jid" | "browserCredentials">,
): string {
  const store = dependencies.browserCredentials;
  if (!store) return "Error: el almacén de credenciales del navegador no está disponible.";

  if (name === "browser_credentials_list") {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    const username = typeof args.username === "string" ? args.username.trim() : "";
    const profiles = store.listProfiles(dependencies.jid, url || undefined, username || undefined);
    if (profiles.length === 0) return "No hay credenciales de navegador guardadas que coincidan.";
    return JSON.stringify(profiles.map((profile) => ({
      credential_ref: profile.ref,
      url: profile.url,
      username: profile.username,
      label: profile.label,
      last_used_at: profile.lastUsedAt,
    })), null, 2);
  }

  const ref = typeof args.credential_ref === "string" ? args.credential_ref.trim() : "";
  if (!ref) return "Error: credential_ref es obligatorio.";

  if (name === "browser_credentials_save") {
    const label = typeof args.label === "string" ? args.label.trim() : "";
    const profile = store.saveProfileFromTemporary(ref, dependencies.jid, label || undefined);
    if (!profile) return "Error: la credencial temporal no existe, expiró o pertenece a otro usuario.";
    store.delete(ref);
    return JSON.stringify({
      ok: true,
      credential_ref: profile.ref,
      url: profile.url,
      username: profile.username,
      label: profile.label,
      message: "Credencial guardada de forma cifrada. Podrá reutilizarse cuando expire la sesión web.",
    }, null, 2);
  }

  if (name === "browser_credentials_delete") {
    return store.deleteProfile(ref, dependencies.jid)
      ? "✅ Credencial de navegador eliminada."
      : "Error: no existe esa credencial o pertenece a otro usuario.";
  }

  return `Error: herramienta de credenciales desconocida "${name}".`;
}

export function executeAgentTaskTool(
  name: string,
  args: Record<string, unknown>,
  dependencies: Pick<SpawnAgentsDependencies, "jid" | "tasks" | "workspace">,
): string {
  if (name === "task_list") {
    const tasks = dependencies.tasks.list(dependencies.jid);
    if (tasks.length === 0) return "No hay tareas registradas.";
    return tasks.map((task, index) => `${index + 1}. ${task.id} — ${task.status}/${task.reviewStatus} — ${task.title} — ${task.completedWorkers}/${task.totalWorkers}`).join("\n");
  }
  if (name === "agent_list") {
    const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const agents = dependencies.tasks.listAgents(dependencies.jid, taskId || undefined);
    if (agents.length === 0) return "No hay agentes registrados.";
    return agents.map((agent, index) => {
      const detail = agent.activity ? ` — ahora: ${agent.activity}` : "";
      const waiting = agent.waitingFieldName ? ` — espera: ${agent.waitingFieldName}` : "";
      return `${index + 1}. ${agent.id} — ${agent.backend} — ${agent.status}/${agent.reviewStatus} — ${agent.name}${detail}${waiting} — tarea ${agent.taskId}`;
    }).join("\n");
  }
  if (name === "task_cancel_all") {
    const count = dependencies.tasks.cancelAll(dependencies.jid);
    return count > 0 ? `✅ Se cancelaron ${count} tarea(s) de fondo.` : "No hay tareas activas que cancelar.";
  }

  const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  const agentSelector = typeof args.agent === "string" ? args.agent.trim() : "";
  if (name.startsWith("task_") && !taskId) return "Error: task_id es obligatorio.";
  if (name.startsWith("agent_") && !agentSelector) return "Error: agent es obligatorio.";

  if (name === "task_status") {
    const task = dependencies.tasks.get(dependencies.jid, taskId);
    if (!task) return `Error: no existe la tarea ${taskId}.`;
    return JSON.stringify({ task, agents: dependencies.tasks.listAgents(dependencies.jid, taskId) }, null, 2);
  }
  if (name === "task_inspect") {
    const task = dependencies.tasks.get(dependencies.jid, taskId);
    if (!task) return `Error: no existe la tarea ${taskId}.`;
    const agents = dependencies.tasks.listAgents(dependencies.jid, taskId).map((agent) => {
      let result: string | undefined;
      if (agent.resultPath) {
        try { result = dependencies.workspace.readText(dependencies.jid, agent.resultPath, 16_000); } catch { /* archivo ausente */ }
      }
      return { ...agent, result };
    });
    let files: string[] = [];
    try { files = dependencies.workspace.listRecursive(dependencies.jid, task.taskPath, 400); } catch { /* carpeta ausente */ }
    const artifacts = dependencies.workspace.listArtifacts(dependencies.jid).filter((item) => item.taskId === taskId);
    return JSON.stringify({ task, agents, files, artifacts }, null, 2);
  }
  if (name === "task_review") {
    const task = dependencies.tasks.get(dependencies.jid, taskId);
    if (!task || ["queued", "running", "synthesizing"].includes(task.status)) {
      return `Error: la tarea ${taskId} no existe o todavía no terminó.`;
    }
    const agents = dependencies.tasks.listAgents(dependencies.jid, taskId);
    const reviewed = agents.map((agent) => {
      let result: string | undefined;
      if (agent.resultPath) {
        try { result = dependencies.workspace.readText(dependencies.jid, agent.resultPath, 12_000); } catch { /* resultado faltante */ }
      }
      return {
        agent_id: agent.id,
        name: agent.name,
        type: agent.agentType,
        backend: agent.backend,
        status: agent.status,
        error: agent.error,
        result_path: agent.resultPath,
        result,
      };
    });
    dependencies.tasks.reviewTask(dependencies.jid, taskId);
    return JSON.stringify({
      task_id: task.id,
      title: task.title,
      status: task.status,
      review_status: "reviewed",
      agents: reviewed,
    }, null, 2);
  }
  if (name === "task_cancel") {
    return dependencies.tasks.cancel(dependencies.jid, taskId)
      ? `✅ Tarea ${taskId} cancelada. La conversación principal continúa activa.`
      : `Error: no se encontró una tarea activa con ID ${taskId}.`;
  }
  if (name === "agent_status") {
    const agent = dependencies.tasks.findAgent(dependencies.jid, agentSelector);
    return agent ? JSON.stringify(agent, null, 2) : `Error: no existe un agente que coincida con ${agentSelector}.`;
  }
  if (name === "agent_review") {
    const agent = dependencies.tasks.findAgent(dependencies.jid, agentSelector);
    if (!agent || ["queued", "running", "waiting_user"].includes(agent.status)) {
      return "Error: el agente no existe o todavía no terminó.";
    }
    let result: string | undefined;
    if (agent.resultPath) {
      try { result = dependencies.workspace.readText(dependencies.jid, agent.resultPath, 16_000); } catch { /* resultado faltante */ }
    }
    dependencies.tasks.reviewAgent(dependencies.jid, agent.id);
    return JSON.stringify({
      agent_id: agent.id,
      name: agent.name,
      type: agent.agentType,
      backend: agent.backend,
      status: agent.status,
      review_status: "reviewed",
      error: agent.error,
      result_path: agent.resultPath,
      result,
    }, null, 2);
  }
  if (name === "agent_cancel") {
    const agent = dependencies.tasks.findAgent(dependencies.jid, agentSelector);
    if (!agent) return `Error: no existe un agente que coincida con ${agentSelector}.`;
    return dependencies.tasks.cancelAgent(dependencies.jid, agent.id)
      ? `✅ ${agent.backend} ${agent.id} (${agent.name}) cancelado. Los demás agentes y la conversación continúan.`
      : `Error: el agente ${agent.id} ya terminó o no está activo.`;
  }
  return `Error: herramienta de tareas desconocida "${name}".`;
}

