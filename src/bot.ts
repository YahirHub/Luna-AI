import type { MessagingTransport, TransportIncomingMessage } from "./transports/types.ts";
import { debugError, debugInfo, debugWarn } from "./debug.ts";
import {
  registerCommand,
  getCommands,
  parseCommand,
  dispatchCommand,
  isPositiveInteger,
} from "./commands.ts";
import type { ParsedCommand } from "./commands.ts";
import {
  buildAudioContextText,
  buildImageContextText,
  downloadAudioForTranscription,
  downloadImageForOcr,
  getMediaCaption,
  getMediaKind,
} from "./media.ts";
import { MediaProcessorClient } from "./media-processing/client.ts";
import { loadWhisperConfig } from "./whisper-config.ts";
import { WhisperSetupManager } from "./whisper-setup.ts";
import {
  discoverModels,
  discoverProviderModels,
  fetchModels,
  chatCompletion,
  chatCompletionWithTools,
  LlmRetriesExhaustedError,
} from "./ai.ts";
import {
  ProviderSetupManager,
  deleteLlmConfig,
  inferLlmBaseUrl,
  loadGlobalLlmModel,
  saveGlobalLlmModel,
  saveLlmConfig,
} from "./llm-config.ts";
import type {
  LlmConfig,
  ProviderSetupStep,
} from "./llm-config.ts";
import { ContextManager, STATIC_SYSTEM_PROMPT_CONTENT } from "./context.ts";
import { AuthManager } from "./auth.ts";
import type { PendingAction } from "./auth.ts";
import {
  MemoryManager,
  MEMORY_TOOLS,
  executeMemoryTool,
} from "./memory.ts";
import {
  ReminderManager,
  REMINDER_TOOLS,
  executeReminderTool,
} from "./reminder.ts";
import {
  AlarmManager,
  ALARM_TOOLS,
  executeAlarmTool,
} from "./alarm.ts";
import { modelCatalog } from "./models.ts";
import {
  OPENCODE_FREE_PROVIDER_NAME,
  createOpenCodeFreeConfig,
  filterOpenCodeFreeModels,
  getOpenCodeFreeFallbackModels,
} from "./providers/opencode-free.ts";
import {
  selectMessagesForCompaction,
  buildCompactionPrompt,
  parseCompactedResponse,
  estimateRequestTokens,
} from "./compaction.ts";
import { estimateTokensAccurate } from "./ai.ts";
import { sendTextHumanized, startActivity, sendText } from "./messaging.ts";
import { deliverScheduledMessage } from "./scheduled-messages.ts";
import {
  recordAlarmDeliveryInContext,
  recordReminderDeliveryInContext,
} from "./scheduled-context.ts";
import {
  AgentConfigFlowManager,
  loadAgentConfig,
  saveAgentConfig,
} from "./agent-config.ts";
import { SearchSetupManager } from "./search/search-setup.ts";
import {
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDER_LABELS,
  isSearchProviderId,
  normalizeSearchProviderOrder,
  resolveSearchProviderState,
  type SearchProviderId,
} from "./search/search-config.ts";
import {
  loadWebSearchAuth,
  loadWebSearchSettings,
  recordSearchProviderTest,
  removeSearchProviderApiKey,
  saveSearchProviderApiKey,
  setDefaultSearchProvider,
  setSearchFallbackOrder,
  setSearchProviderEnabled,
} from "./search/search-storage.ts";
import { testSearchProvider } from "./search/search-runtime.ts";
import {
  ADMIN_TOOLS,
  executeUserAdminTool,
  executeWhisperAdminTool,
} from "./admin-tools.ts";
import {
  buildConfirmedToolEvent,
  buildVisibleSystemConfirmation,
  guardUnconfirmedScheduledCreationClaim,
  isConfirmedScheduledCreation,
  isConfirmedToolSuccess,
  stripUnrelatedPendingNameQuestion,
  userExplicitlyBlocksScheduledCreation,
} from "./tool-confirmation.ts";
import { WorkspaceManager } from "./workspace/workspace-manager.ts";
import {
  WORKSPACE_TOOLS,
  executeWorkspaceTool,
} from "./workspace/workspace-tools.ts";
import {
  ARTIFACT_TOOLS,
  executeArtifactTool,
} from "./artifacts/artifact-tools.ts";
import { TaskRuntime } from "./orchestration/task-runtime.ts";
import {
  MESSAGING_TOOLS,
  executeMessagingTool,
  sendWorkspacePath,
} from "./tools/messaging-tools.ts";
import {
  executeAgentTaskTool,
  executeBrowserWebTool,
  executeBrowserCredentialControlTool,
  executeResearcherWebTool,
  executeSpawnAgentsTool,
  getMainAgentTools,
  type SpawnAgentsProgress,
} from "./agents/spawn-agents-tool.ts";
import { createSpawnAgentRequestDeduper } from "./agents/spawn-deduper.ts";
import {
  USER_CONTROL_TOOLS,
  ADMIN_CONTROL_TOOLS,
} from "./control-tools.ts";
import { extractSecretTokenFromMessage } from "./utils.ts";
import {
  browserCredentialStore,
  extractBrowserLoginIntent,
  sanitizeBrowserCredentialText,
  type PendingBrowserInputRequest,
} from "./browser/browser-credentials.ts";
import { getActiveTransport } from "./transports/active.ts";

// ─── Estado global ───────────────────────────────────────────────

type LlmProviderMode = "opencode-free" | "custom";

let llmConfig: LlmConfig | null = null;
let llmProviderMode: LlmProviderMode = "opencode-free";
let llmConfigPath = "";
let contextManager: ContextManager | null = null;
let schedulersStarted = false;

/** Modelos disponibles actualmente; siempre incluye el predeterminado. */
let availableModels: string[] = [];

/** Flujo temporal para configurar el proveedor desde el chat activo. */
const providerSetupManager = new ProviderSetupManager();

/** Configuración persistente de herramientas y subagentes. */
let agentConfig = loadAgentConfig();
const agentConfigFlowManager = new AgentConfigFlowManager();
const searchSetupManager = new SearchSetupManager();
const whisperSetupManager = new WhisperSetupManager();
const mediaProcessor = new MediaProcessorClient();

/** Gestor de autenticación y sesiones de usuario. */
const authManager = new AuthManager();

/** Gestor de memoria persistente del bot (por usuario). */
const memoryManager = new MemoryManager();

/** Gestor de recordatorios. */
const reminderManager = new ReminderManager();

/** Gestor de alarmas recurrentes. */
const alarmManager = new AlarmManager();

/** Workdir privado y herramientas extendidas por usuario. */
const workspaceManager = new WorkspaceManager();
const taskRuntime = new TaskRuntime(workspaceManager);

/** JIDs actualmente en proceso de compactación (para ignorar mensajes entrantes). */
const compactingJids = new Set<string>();

/** Ejecución principal activa por usuario. !cancelar aborta también al orquestador,
 * no solo al subagente, para impedir que el modelo lance tareas de seguimiento
 * después de que el usuario ya canceló la solicitud. */
const activeAiRuns = new Map<string, AbortController>();

/** Serializa revisiones automáticas por chat para no mezclar resultados simultáneos. */
const backgroundReviewChains = new Map<string, Promise<void>>();

/** Tools base y herramientas opcionales según /config. */
const BASE_TOOLS = [
  ...MEMORY_TOOLS,
  ...REMINDER_TOOLS,
  ...ALARM_TOOLS,
  ...WORKSPACE_TOOLS,
  ...ARTIFACT_TOOLS,
  ...MESSAGING_TOOLS,
  ...USER_CONTROL_TOOLS,
];

function getAvailableTools(jid?: string): import("./ai.ts").ToolDefinition[] {
  const tools = [...BASE_TOOLS];
  tools.push(...getMainAgentTools(agentConfig));
  if (jid && isAdminSession(jid)) {
    tools.push(...ADMIN_TOOLS);
    tools.push(...ADMIN_CONTROL_TOOLS);
  }
  return tools;
}

const TOOL_NOTIFICATION_TEXTS = new Map<string, string>([
  ["create_reminder", "⏰ Creando recordatorio..."],
  ["delete_reminder", "🗑️ Eliminando recordatorio..."],
  ["list_reminders", "📋 Consultando recordatorios..."],
  ["memory_write", "📝 Escribiendo en memoria..."],
  ["memory_read", "🔍 Leyendo memoria..."],
  ["create_alarm", "⏰ Creando alarma recurrente..."],
  ["delete_alarm", "🗑️ Eliminando alarma..."],
  ["list_alarms", "📋 Consultando alarmas..."],
  ["toggle_alarm", "🔄 Cambiando estado de alarma..."],
  ["whisper_update_config", "🎙️ Actualizando Whisper..."],
  ["whisper_download_model", "⬇️ Descargando modelo Whisper..."],
  ["whisper_cleanup_models", "🗑️ Limpiando modelos Whisper..."],
  ["admin_start_add_user", "👤 Preparando nuevo usuario..."],
  ["admin_ban_user", "🚫 Bloqueando usuario..."],
  ["admin_unban_user", "✅ Desbloqueando usuario..."],
  ["spawn_agents", "🤖 Preparando subagentes paralelos..."],
  ["researcher_web", "🕵️ Preparando investigador web..."],
  ["browser_agent", "🌐 Preparando agente de navegador..."],
  ["create_pdf_from_markdown", "📄 Generando PDF..."],
  ["archive_folder", "🗜️ Comprimiendo carpeta..."],
  ["gitzip", "🗜️ Empaquetando código fuente con reglas .gitignore..."],
  ["message_send", "📤 Preparando envío por el chat activo..."],
  ["workspace_clear", "🧹 Limpiando tu workdir..."],
  ["model_list", "📋 Actualizando modelos disponibles..."],
  ["model_set", "🧠 Cambiando modelo global..."],
  ["llm_provider_start_setup", "🧠 Preparando configuración del proveedor LLM..."],
  ["search_admin_test", "🧪 Probando motores de búsqueda..."],
  ["search_admin_start_set_api_key", "🔑 Preparando configuración segura de API key..."],
]);

// ─── Compactación de contexto ──────────────────────────────────

/** Función externa (inyectada) para obtener la memoria de un JID. */
function getMemoryContent(jid: string): string {
  try {
    return memoryManager.getContent(jid);
  } catch {
    return "";
  }
}

/**
 * Verifica si el contexto del usuario necesita compactación y la ejecuta
 * usando el modelo LLM para generar un resumen estructurado.
 * Mientras compacta, ignora mensajes entrantes del mismo JID.
 */
async function ensureContextCompaction(transport: MessagingTransport, jid: string): Promise<void> {
  if (!contextManager || !llmConfig) return;

  const modelId = contextManager.getModel(jid);
  const messages = contextManager.getMessages(jid);

  if (messages.length <= 2) return; // Solo system + 1 msg

  // Estimar tokens actuales (incluyendo tools)
  const currentTokens = estimateTokensAccurate(messages);
  const toolsTokens = estimateRequestTokens([], getAvailableTools(jid));

  // Obtener presupuesto efectivo del modelo
  const effectiveBudget = modelCatalog.getEffectiveBudget(modelId, toolsTokens);
  const triggerTokens = Math.floor(effectiveBudget * 0.85);

  if (currentTokens < triggerTokens) {
    return; // No necesita compactación
  }

  // Marcar como "compactando" para ignorar mensajes entrantes
  compactingJids.add(jid);
  try {
    // Notificar al usuario
    void sendText(transport, jid, "🧹 Espera un momento, estoy limpiando mi memoria...", { waitForDelivery: false });

    console.log(
      `[compact] Contexto de ${jid}: ~${currentTokens} tokens, ` +
      `presupuesto ${effectiveBudget}, activando compactación...`,
    );

    // 1. Seleccionar mensajes para compactar
    const split = selectMessagesForCompaction({
      messages,
      preserveRecentTurns: 10,
      targetTokens: Math.floor(effectiveBudget * 0.55),
    });

    if (split.messagesToCompact.length === 0) {
      console.log("[compact] No hay mensajes que compactar");
      return;
    }

    // 2. Obtener memoria persistente para el prompt de compactación
    const persistentMemory = getMemoryContent(jid);

    // 3. Construir prompt para el LLM compactador
    const previousSummary = contextManager.getCompactionSummary(jid);
    const compactionMessages = buildCompactionPrompt({
      previousSummary: previousSummary ?? null,
      messagesToCompact: split.messagesToCompact,
      persistentMemory,
    });

    // 4. Llamar al LLM para que genere el resumen
    // max_tokens generoso para que el modelo pueda completar el JSON
    try {
      const compactRaw = await chatCompletion(
        compactionMessages,
        modelId,
        llmConfig,
        2,
        4096,
      );

      const parsedSummary = parseCompactedResponse(compactRaw);

      if (parsedSummary) {
        const tokensAfter = estimateTokensAccurate(split.messagesToKeep);
        contextManager.applyCompaction(
          jid,
          split.messagesToKeep,
          parsedSummary,
          currentTokens,
          tokensAfter,
          split.messagesToCompact.length,
        );

        console.log(
          `[compact] Compactación exitosa para ${jid}: ` +
          `${currentTokens} → ~${tokensAfter} tokens ` +
          `(${split.messagesToCompact.length} mensajes compactados)`,
        );
      } else {
        console.warn(
          "[compact] No se pudo parsear el resumen del LLM, " +
          "conservando contexto original",
        );
        // Log del raw response para debugging (truncado a 500 chars)
        console.warn(
          "[compact] Raw response (primeros 500 chars):",
          compactRaw.slice(0, 500),
        );
        console.warn(
          "[compact] Raw response (últimos 200 chars):",
          compactRaw.slice(-200),
        );
      }
    } catch (err) {
      console.error("[compact] Error al compactar con LLM:", err);
      // Si falla la compactación, no borramos mensajes — el contexto original
      // se conserva intacto
    }
  } finally {
    compactingJids.delete(jid);
  }
}

/** Actualiza modelos desde el endpoint y aplica el fallback del proveedor activo. */
async function refreshAvailableModels(): Promise<boolean> {
  const configSnapshot = llmConfig;
  const modeSnapshot = llmProviderMode;
  if (!configSnapshot) {
    availableModels = getOpenCodeFreeFallbackModels();
    return true;
  }

  if (modeSnapshot === "opencode-free") {
    try {
      const discovered = await fetchModels(configSnapshot);

      // Ignorar una respuesta tardía si el administrador cambió de proveedor.
      if (llmConfig !== configSnapshot || llmProviderMode !== modeSnapshot) {
        return true;
      }

      const filtered = filterOpenCodeFreeModels(discovered);
      const useLocalCatalog = filtered.length === 0;
      availableModels = useLocalCatalog
        ? getOpenCodeFreeFallbackModels()
        : filtered;
      return useLocalCatalog;
    } catch (error) {
      if (llmConfig !== configSnapshot || llmProviderMode !== modeSnapshot) {
        return true;
      }

      availableModels = getOpenCodeFreeFallbackModels();
      console.warn(
        `[models] No se pudo consultar ${configSnapshot.modelsUrl}; ` +
        "se usará el catálogo local de OpenCode Free.",
        error,
      );
      return true;
    }
  }

  const result = await discoverModels(configSnapshot);

  // Ignorar una respuesta tardía si el administrador cambió de proveedor.
  if (llmConfig !== configSnapshot || llmProviderMode !== modeSnapshot) {
    return true;
  }

  availableModels = result.models;

  if (result.error) {
    console.warn(
      `[models] No se pudo consultar ${configSnapshot.modelsUrl}; ` +
      `se usará el modelo predeterminado "${configSnapshot.defaultModel}".`,
      result.error,
    );
  }

  return result.usedFallback;
}

/** Inicia una sola vez los verificadores de mensajes programados. */
function ensureSchedulersStarted(): void {
  if (schedulersStarted) return;
  schedulersStarted = true;
  reminderManager.startChecker(onReminderDue);
  alarmManager.startChecker(onAlarmDue);
}

/**
 * Inicializa o reemplaza la configuración LLM en caliente.
 * config=null activa automáticamente el proveedor integrado OpenCode Free.
 */
export function initLlm(
  config: LlmConfig | null,
  configPath: string,
): void {
  llmConfigPath = configPath;
  ensureSchedulersStarted();

  const baseConfig = config ?? createOpenCodeFreeConfig();
  const persistedGlobalModel = loadGlobalLlmModel(baseConfig.modelsUrl, configPath);
  const activeConfig = persistedGlobalModel
    ? { ...baseConfig, defaultModel: persistedGlobalModel }
    : baseConfig;
  llmProviderMode = config ? "custom" : "opencode-free";
  llmConfig = activeConfig;
  availableModels =
    llmProviderMode === "opencode-free"
      ? getOpenCodeFreeFallbackModels()
      : [activeConfig.defaultModel];

  if (contextManager) {
    contextManager.setDefaultModel(activeConfig.defaultModel);
  } else {
    contextManager = new ContextManager(activeConfig.defaultModel);
    contextManager.setMemoryManager(memoryManager);
  }

  // No bloquear el arranque ni /setup-provider por una caída de /models.
  void refreshAvailableModels();
}

/**
 * Cambia el modelo activo de Luna para todos los chats, tareas y subagentes.
 * La selección queda persistida y vinculada al catálogo del provider actual.
 */
function applyGlobalModelSelection(model: string): string {
  if (!llmConfig || !contextManager) {
    throw new Error("El proveedor LLM todavía no está inicializado.");
  }

  const nextConfig: LlmConfig = { ...llmConfig, defaultModel: model };
  llmConfig = llmProviderMode === "custom"
    ? saveLlmConfig(nextConfig, llmConfigPath)
    : nextConfig;

  saveGlobalLlmModel(llmConfig, llmConfigPath);
  contextManager.setGlobalModel(llmConfig.defaultModel);
  return llmConfig.defaultModel;
}

/** Activa OpenCode Free y fija su modelo predeterminado como selección global. */
function activateOpenCodeFreeGlobally(): void {
  deleteLlmConfig(llmConfigPath);
  const freeConfig = createOpenCodeFreeConfig();
  saveGlobalLlmModel(freeConfig, llmConfigPath);
  initLlm(null, llmConfigPath);
}

/** Callback cuando una alarma recurrente debe dispararse. */
async function onAlarmDue(
  alarm: import("./alarm.ts").RecurringAlarm,
): Promise<void> {
  const transport = getActiveTransport();
  if (!transport) {
    throw new Error("Transporte de mensajería no disponible para entregar la alarma.");
  }

  const dayName = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
  }).format(new Date());

  const deliveredText = await deliverScheduledMessage({
    transport,
    jid: alarm.jid,
    model: contextManager?.getModel(alarm.jid),
    llmConfig: llmConfig ?? undefined,
    dynamicContext: contextManager?.buildDynamicContext(alarm.jid),
    prompt: [
      "Debes entregar ahora esta alarma recurrente.",
      `Contenido obligatorio: ${alarm.text}`,
      `Día actual: ${dayName}`,
    ].join("\n"),
    fallbackText: alarm.deliveryMessage,
    title: `⏰ ALARMA RECURRENTE (${dayName})`,
    logLabel: "alarm",
  });

  // La entrega real se incorpora al historial persistente. Un fallo de disco
  // no debe provocar que el transporte entregue la misma alarma nuevamente.
  if (contextManager) {
    try {
      await contextManager.withLock(alarm.jid, async () => {
        if (contextManager) {
          recordAlarmDeliveryInContext(
            contextManager,
            alarm.jid,
            alarm.text,
            dayName,
            deliveredText,
          );
        }
      });
    } catch (error) {
      console.error(`[alarm] La alarma se entregó, pero no pudo agregarse al contexto de ${alarm.jid}:`, error);
    }
  }

  console.log(`[alarm] Alarma disparada para ${alarm.jid}`);
}

/** Callback cuando un recordatorio debe dispararse. */
async function onReminderDue(
  reminder: import("./reminder.ts").Reminder,
): Promise<void> {
  const transport = getActiveTransport();
  if (!transport) {
    throw new Error("Transporte de mensajería no disponible para entregar el recordatorio.");
  }

  const deliveredText = await deliverScheduledMessage({
    transport,
    jid: reminder.jid,
    model: contextManager?.getModel(reminder.jid),
    llmConfig: llmConfig ?? undefined,
    dynamicContext: contextManager?.buildDynamicContext(reminder.jid),
    prompt: [
      "Debes entregar ahora este recordatorio de una sola vez.",
      `Contenido obligatorio: ${reminder.text}`,
      `Fecha programada: ${reminder.date}`,
      `Hora programada: ${String(reminder.hour).padStart(2, "0")}:${String(reminder.minute).padStart(2, "0")}`,
    ].join("\n"),
    fallbackText: reminder.deliveryMessage,
    title: "⏰ RECORDATORIO",
    logLabel: "reminder",
  });

  if (contextManager) {
    try {
      const scheduledTime = `${String(reminder.hour).padStart(2, "0")}:${String(reminder.minute).padStart(2, "0")}`;
      await contextManager.withLock(reminder.jid, async () => {
        if (contextManager) {
          recordReminderDeliveryInContext(
            contextManager,
            reminder.jid,
            reminder.text,
            reminder.date,
            scheduledTime,
            deliveredText,
          );
        }
      });
    } catch (error) {
      console.error(
        `[reminder] El recordatorio se entregó, pero no pudo agregarse al contexto de ${reminder.jid}:`,
        error,
      );
    }
  }

  console.log(`[reminder] Recordatorio disparado para ${reminder.jid}`);
}

function isAdminSession(jid: string): boolean {
  const username = authManager.getUsername(jid);
  return Boolean(username && authManager.isAdmin(username));
}

const SLASH_COMMANDS = new Set([
  "setup-provider",
  "setup-search",
  "config",
]);

function formatCommandName(name: string): string {
  return `${SLASH_COMMANDS.has(name) ? "/" : "!"}${name}`;
}

function formatSpawnAgentsProgress(event: SpawnAgentsProgress): string[] {
  switch (event.type) {
    case "task_registered":
      return [`📌 Tarea registrada: ${event.title}\nID: ${event.taskId}\nEstado: en cola; te confirmaré cuando el agente empiece realmente.`];
    case "agent_started": {
      const prefix = `🚀 Agente ${event.agentId} activo — ${event.agentName}`;
      const prompt = event.prompt.replace(/\s+/g, " ").trim();
      return [prompt ? `${prefix}\nMisión: ${prompt.slice(0, 700)}` : prefix];
    }
    case "agent_activity":
      return [];
    case "agent_completed": {
      if (event.status === "cancelled") return [];
      const icon = event.status === "completed" ? "✅" : "❌";
      const label = event.status === "completed" ? "terminó" : "falló";
      return [`${icon} Agente ${event.agentId} — ${event.agentName}: ${label}.`];
    }
    case "task_completed": {
      if (event.status === "cancelled") return [];
      if (event.background) {
        return [`🧠 Tarea ${event.taskId} ${event.status === "partial" ? "terminó parcialmente" : event.status === "failed" ? "terminó con errores" : "terminó"}. Luna revisará automáticamente resultados, carpeta y archivos antes de responderte.`];
      }
      return [`✅ Tarea ${event.taskId} ${event.status === "partial" ? "completada parcialmente" : event.status === "failed" ? "fallida" : "completada"}.`];
    }
  }
}

function compactReviewText(value: string, maxChars = 18_000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.floor(maxChars * 0.7))}\n\n[...contenido intermedio omitido...]\n\n${value.slice(-Math.floor(maxChars * 0.3))}`;
}

function buildDeterministicTaskSummary(taskId: string, title: string, status: string, agents: Array<{ name: string; status: string; result?: string; error?: string }>): string {
  const lines = [
    `📋 Revisión automática: ${title}`,
    "",
    `Estado de la tarea: ${status}`,
  ];
  for (const agent of agents) {
    lines.push("", `- ${agent.name}: ${agent.status}`);
    if (agent.error) lines.push(`  Error: ${agent.error}`);
    if (agent.result) lines.push(`  Resultado: ${agent.result.replace(/\s+/g, " ").slice(0, 800)}`);
  }
  lines.push("", `ID: ${taskId}`);
  return lines.join("\n");
}

async function reviewBackgroundTask(
  transport: MessagingTransport,
  jid: string,
  taskId: string,
): Promise<void> {
  const previous = backgroundReviewChains.get(jid) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const cm = contextManager;
    const cfg = llmConfig;
    if (!cm || !cfg) return;

    const task = taskRuntime.get(jid, taskId);
    if (!task || task.reviewStatus === "reviewed" || task.status === "cancelled") return;
    if (["queued", "running", "synthesizing"].includes(task.status)) return;

    const finalStatus = task.status;
    taskRuntime.update(jid, taskId, { status: "synthesizing" });
    let reviewDelivered = false;
    try {
      const agents = taskRuntime.listAgents(jid, taskId).map((agent) => {
        let result: string | undefined;
        if (agent.resultPath) {
          try { result = workspaceManager.readText(jid, agent.resultPath, 18_000); } catch { /* resultado ausente */ }
        }
        return {
          id: agent.id,
          name: agent.name,
          type: agent.agentType,
          status: agent.status,
          activity: agent.activity,
          error: agent.error,
          resultPath: agent.resultPath,
          result,
        };
      });
      let files: string[] = [];
      try { files = workspaceManager.listRecursive(jid, task.taskPath, 400); } catch { /* carpeta ausente */ }
      const artifacts = workspaceManager.listArtifacts(jid)
        .filter((artifact) => artifact.taskId === taskId && artifact.createdBy !== "browser-web-input")
        .slice(0, 8);

      const payload = compactReviewText(JSON.stringify({
        task: { id: task.id, title: task.title, status: finalStatus, taskPath: task.taskPath },
        agents,
        files,
        artifacts,
      }, null, 2), 45_000);

      let summary = "";
      try {
        summary = (await chatCompletion([
          {
            role: "system",
            content: `${STATIC_SYSTEM_PROMPT_CONTENT}\n\nREVISIÓN AUTOMÁTICA DE TAREA:\n- Estás revisando una tarea de fondo que ya terminó.\n- Analiza realmente resultados, errores, carpeta y artefactos incluidos.\n- No afirmes que sigue activa si el estado es terminal.\n- Explica exactamente qué logró cada agente y qué faltó.\n- Si hay capturas o archivos, indica que el sistema los enviará después de tu mensaje.\n- No lances nuevas tareas ni pidas permiso para revisar: esta revisión ya fue solicitada por el sistema.\n- No inventes contenido que no aparezca en el paquete.`,
          },
          {
            role: "user",
            content: `[Resultado de tarea de fondo confirmado por el sistema]\n\n${payload}`,
          },
        ], cm.getModel(jid), cfg, 3, 3500)).trim();
      } catch (error) {
        debugError("agents.review", "llm_review_failed", error, { jid, taskId });
      }

      if (!summary) {
        summary = buildDeterministicTaskSummary(task.id, task.title, finalStatus, agents);
      }

      // El análisis LLM y el envío de artefactos no deben monopolizar el lock del
      // chat. Solo serializamos la escritura breve del resultado en el contexto,
      // de modo que el usuario pueda seguir conversando mientras Luna revisa.
      await cm.withLock(jid, async () => {
        cm.addMessage(jid, {
          role: "user",
          content: `[Resultado de tarea de fondo confirmado por el sistema]\nTarea ${task.id} (${task.title}) terminó con estado ${finalStatus}.`,
        });
        cm.addMessage(jid, { role: "assistant", content: summary });
      });

      await sendTextHumanized(transport, jid, summary, 1_000, 2_000);

      for (const artifact of artifacts) {
        try {
          await sendWorkspacePath(
            transport,
            jid,
            workspaceManager,
            artifact.path,
            `Resultado de ${task.title}`,
          );
        } catch (error) {
          debugError("agents.review", "artifact_send_failed", error, { jid, taskId, path: artifact.path });
        }
      }

      taskRuntime.update(jid, taskId, { status: finalStatus });
      taskRuntime.reviewTask(jid, taskId);
      reviewDelivered = true;
      debugInfo("agents.review", "completed", { jid, taskId, artifactsSent: artifacts.length });
    } catch (error) {
      debugError("agents.review", "automatic_review_failed", error, { jid, taskId });
    } finally {
      taskRuntime.update(jid, taskId, { status: finalStatus });
      if (!reviewDelivered) {
        debugWarn("agents.review", "left_pending_for_retry", { jid, taskId, finalStatus });
      }
    }
  }).finally(() => {
    if (backgroundReviewChains.get(jid) === current) backgroundReviewChains.delete(jid);
  });
  backgroundReviewChains.set(jid, current);
  await current;
}

function formatAgentEventAge(timestamp?: string): string {
  if (!timestamp) return "sin eventos registrados";
  const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
  if (!Number.isFinite(elapsed)) return "hora desconocida";
  if (elapsed < 60_000) return "hace menos de un minuto";
  if (elapsed < 3_600_000) return `hace ${Math.floor(elapsed / 60_000)} min`;
  return `hace ${Math.floor(elapsed / 3_600_000)} h`;
}

function isTaskProgressQuestion(value: string): boolean {
  const normalized = normalizeNaturalText(value);
  return /(?:como|cómo|estado|avance|progreso|que tal|qué tal).{0,35}(?:tarea|tareas|proceso|procesos|agente|agentes)/iu.test(normalized)
    || /(?:tarea|tareas|proceso|procesos|agente|agentes).{0,35}(?:como va|cómo va|como van|cómo van|estado|avance|progreso)/iu.test(normalized)
    || /^(?:como|cómo) va(?:n)?(?: el| la| los| las)? (?:proceso|procesos|tarea|tareas|agente|agentes)/iu.test(normalized);
}

function formatTaskProgressForUser(jid: string): string {
  const tasks = taskRuntime.list(jid);
  const agents = taskRuntime.listAgents(jid);
  const activeAgents = agents.filter((agent) => ["queued", "running", "waiting_user"].includes(agent.status));
  const activeTasks = tasks.filter((task) => ["queued", "running", "synthesizing"].includes(task.status));
  const recentTerminal = tasks.filter((task) => ["completed", "partial", "failed", "cancelled", "interrupted"].includes(task.status)).slice(0, 6);
  const lines = ["📋 ESTADO REAL DE TAREAS"];

  if (activeAgents.length === 0 && activeTasks.length === 0) {
    lines.push("", "No hay agentes ejecutándose en este momento.");
  } else {
    if (activeAgents.length > 0) {
      lines.push("", "Activos:");
      for (const agent of activeAgents.slice(0, 12)) {
        const task = tasks.find((item) => item.id === agent.taskId);
        const state = agent.status === "waiting_user"
          ? `esperando ${agent.waitingFieldName ?? "un dato"}`
          : agent.status === "queued"
            ? "en cola"
            : "en ejecución";
        lines.push(
          `• ${agent.id} — ${agent.name}`,
          `  Estado: ${state}`,
          `  Ahora: ${agent.activity ?? "Preparando el siguiente paso"}`,
          `  Último evento: ${formatAgentEventAge(agent.lastEventAt)}`,
          `  Tarea: ${task?.title ?? agent.taskId}`,
        );
      }
    }
    const representedTaskIds = new Set(activeAgents.map((agent) => agent.taskId));
    for (const task of activeTasks.filter((item) => !representedTaskIds.has(item.id))) {
      if (task.status === "queued") {
        lines.push("", `⏳ ${task.title}: registrada y en cola; todavía no hay un agente confirmado como iniciado.`);
      } else if (task.status === "synthesizing") {
        lines.push("", `🧠 ${task.title}: Luna está revisando resultados, carpeta y artefactos.`);
      } else {
        lines.push("", `🔄 ${task.title}: el supervisor está conciliando sus agentes activos.`);
      }
    }
  }

  if (recentTerminal.length > 0) {
    lines.push("", "Recientes:");
    for (const task of recentTerminal) {
      const review = task.reviewStatus === "reviewed" ? "revisada" : "pendiente de revisión/reintento";
      lines.push(`• ${task.title}: ${task.status}, ${review} — ${task.id}`);
    }
  }
  return lines.join("\n");
}

function retryPendingBackgroundReviews(transport: MessagingTransport, jid: string): void {
  const pending = taskRuntime.list(jid)
    .filter((task) => task.reviewStatus === "pending" && ["completed", "partial", "failed", "interrupted"].includes(task.status))
    .slice(0, 3);
  for (const task of pending) {
    void reviewBackgroundTask(transport, jid, task.id).catch((error) => {
      debugError("agents.review", "retry_failed", error, { jid, taskId: task.id });
    });
  }
}

function providerSetupPrompt(step: ProviderSetupStep, models: readonly string[] = []): string {
  switch (step) {
    case "baseUrl":
      return [
        "1/3 — URL BASE DEL PROVEEDOR",
        "",
        "Envía únicamente la URL base compatible con OpenAI.",
        "Ejemplo: https://api.example.com/v1",
        "",
        "Luna detectará automáticamente /models y /chat/completions.",
        "También puedes pegar por error una URL terminada en /models o /chat/completions: se normalizará sola.",
      ].join("\n");
    case "apiKey":
      return [
        "2/3 — API KEY",
        "",
        "Envía la clave del proveedor.",
        "Si no requiere clave, responde: sin-clave",
        "",
        "Al recibirla consultaré automáticamente el catálogo /models.",
        "Por seguridad intentaré eliminar este mensaje después de leerlo.",
      ].join("\n");
    case "defaultModel": {
      const rows = models.map((model, index) => `${index + 1}. ${model}`);
      return [
        "3/3 — MODELO GLOBAL",
        "",
        "Catálogo detectado correctamente. Elige el número del modelo que usará Luna globalmente:",
        "",
        ...rows,
        "",
        `Responde con un número entre 1 y ${models.length}.`,
      ].join("\n");
    }
  }
}

async function deleteSensitiveIncomingMessage(
  transport: MessagingTransport,
  message: TransportIncomingMessage,
): Promise<void> {
  try {
    await transport.deleteMessage(message);
  } catch {
    // Best-effort: una plataforma sin borrado no debe romper el flujo seguro.
  }
}

function buildHelpText(jid: string): string {
  const username = authManager.getUsername(jid);
  const admin = username ? authManager.isAdmin(username) : false;
  const commands = getCommands(admin)
    .map((item) => `${formatCommandName(item.name)} — ${item.description}`)
    .join("\n");
  return [
    "🤖 COMANDOS DISPONIBLES",
    "",
    commands,
    "",
    "💬 También puedes pedirme estas acciones con lenguaje natural.",
  ].join("\n");
}

function cancelCurrentOperation(jid: string): string {
  let cancelledSomething = false;
  let cancelledTasks = 0;

  if (browserCredentialStore.getPendingInput(jid)) {
    browserCredentialStore.cancelPendingInput(jid, new Error("Solicitud cancelada por el usuario."));
    cancelledSomething = true;
  }

  cancelledTasks = taskRuntime.cancelAll(jid);
  if (cancelledTasks > 0) cancelledSomething = true;

  const activeRun = activeAiRuns.get(jid);
  if (activeRun && !activeRun.signal.aborted) {
    activeRun.abort(new Error("user-cancelled-current-operation"));
    cancelledSomething = true;
  }

  if (providerSetupManager.has(jid)) {
    providerSetupManager.cancel(jid);
    cancelledSomething = true;
  }
  if (searchSetupManager.has(jid)) {
    searchSetupManager.cancel(jid);
    cancelledSomething = true;
  }
  if (agentConfigFlowManager.has(jid)) {
    agentConfigFlowManager.cancel(jid);
    cancelledSomething = true;
  }
  if (whisperSetupManager.has(jid)) {
    whisperSetupManager.cancel(jid);
    cancelledSomething = true;
  }
  if (contextManager?.isAwaitingModelSelection(jid)) {
    contextManager.clearAwaitingModelSelection(jid);
    cancelledSomething = true;
  }

  if (!cancelledSomething) return "No hay una operación interactiva o tarea activa que cancelar.";
  if (cancelledTasks > 1) return `✅ Operación actual cancelada. Se detuvieron ${cancelledTasks} tareas de subagentes y el orquestador no las reanudará.`;
  if (cancelledTasks === 1) return "✅ Operación actual cancelada. Se detuvo la tarea de subagentes y el orquestador no lanzará tareas de seguimiento.";
  return "✅ Operación actual cancelada.";
}

async function formatModelsForUser(): Promise<string> {
  if (!llmConfig || !contextManager) return "Error: el proveedor LLM todavía está iniciando.";
  const usedFallback = await refreshAvailableModels();
  const current = llmConfig.defaultModel || "ninguno";
  const rows = availableModels.map((model, index) => `${index + 1}. ${model}`);
  return [
    "📋 MODELOS DISPONIBLES",
    "",
    ...rows,
    "",
    `Modelo global actual: ${current}`,
    ...(usedFallback ? ["Nota: se está mostrando un catálogo de respaldo porque el endpoint de modelos no respondió correctamente."] : []),
  ].join("\n");
}

function formatAgentConfigStatus(config = agentConfig): string {
  return [
    "⚙️ CONFIGURACIÓN DEL AGENTE",
    `Acceso web: ${config.webSearchEnabled ? "activo" : "inactivo"}`,
    `Subagente investigador: ${config.researchSubagentEnabled ? "activo" : "inactivo"}`,
    `Profundidad predeterminada: ${config.defaultSearchDepth}`,
    `Timeout investigador: ${Math.round(config.researcherTimeoutMs / 60_000)} minutos`,
  ].join("\n");
}

function formatSearchAdminStatus(): string {
  const settings = loadWebSearchSettings();
  const auth = loadWebSearchAuth();
  const rows = SEARCH_PROVIDER_IDS.map((provider) => {
    const state = resolveSearchProviderState(provider, settings, auth);
    const status = state.enabled ? "activo" : state.configured ? "desactivado" : "sin API key";
    const defaultMark = settings.defaultProvider === provider ? " · predeterminado" : "";
    const test = state.lastTest ? ` · última prueba: ${state.lastTest.ok ? "correcta" : "fallida"}` : "";
    return `- ${SEARCH_PROVIDER_LABELS[provider]}: ${status}${defaultMark}${test}`;
  });
  return [
    "🔎 MOTORES DE BÚSQUEDA",
    ...rows,
    `Orden de fallback: ${settings.fallbackOrder.map((provider) => SEARCH_PROVIDER_LABELS[provider]).join(" → ")}`,
  ].join("\n");
}

function parseSearchProviderArg(value: unknown): SearchProviderId | null {
  if (isSearchProviderId(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  const aliases: Record<string, SearchProviderId> = {
    tavily: "tavily",
    brave: "brave",
    bravesearch: "brave",
    exa: "exa",
    exaai: "exa",
    linkup: "linkup",
    firecrawl: "firecrawl",
    fireclaw: "firecrawl",
    serpapi: "serpapi",
    zenserp: "zenserp",
  };
  return aliases[normalized] ?? null;
}

async function testSearchProvidersNatural(providerArg: unknown): Promise<string> {
  const settings = loadWebSearchSettings();
  const auth = loadWebSearchAuth();
  const requested = providerArg === "all"
    ? SEARCH_PROVIDER_IDS.filter((provider) => resolveSearchProviderState(provider, settings, auth).enabled)
    : [parseSearchProviderArg(providerArg)].filter((provider): provider is SearchProviderId => Boolean(provider));
  if (requested.length === 0) return "Error: no hay motores activos para probar o el proveedor indicado no es válido.";
  const rows: string[] = [];
  for (const provider of requested) {
    const result = await testSearchProvider(provider, { settings: loadWebSearchSettings(), auth: loadWebSearchAuth() });
    recordSearchProviderTest(provider, result);
    rows.push(`${result.ok ? "✅" : "❌"} ${SEARCH_PROVIDER_LABELS[provider]}: ${result.message}`);
  }
  return rows.join("\n");
}

async function executeUserControlTool(
  name: string,
  args: Record<string, unknown>,
  jid: string,
): Promise<string> {
  switch (name) {
    case "control_help":
      return buildHelpText(jid);
    case "control_ping":
      return "🏓 pong";
    case "control_get_id":
      return `🆔 Tu identificador de chat: ${jid}`;
    case "control_cancel":
      return cancelCurrentOperation(jid);
    case "conversation_clear":
      contextManager?.clearConversation(jid);
      return "✅ Conversación reiniciada. La memoria persistente y el workdir se conservaron.";
    case "account_password_change_start": {
      const username = authManager.getUsername(jid);
      if (!username) return "Error: necesitas una sesión autenticada para cambiar la contraseña.";
      authManager.setPendingAction(jid, { type: "change-password", step: "awaiting-password", username });
      return "🔐 Envía tu nueva contraseña en el siguiente mensaje. Se procesará fuera del LLM y Luna intentará borrar el mensaje después.";
    }
    case "model_status":
      return `Modelo global actual: ${llmConfig?.defaultModel ?? "ninguno"}`;
    case "model_list":
      return await formatModelsForUser();
    case "model_set": {
      if (!contextManager) return "Error: el gestor de contexto no está disponible.";
      const requested = typeof args.model_id === "string" ? args.model_id.trim() : "";
      if (!requested) return "Error: model_id es obligatorio.";
      await refreshAvailableModels();
      const exact = availableModels.find((model) => model.toLowerCase() === requested.toLowerCase());
      if (!exact) {
        const partial = availableModels.filter((model) => model.toLowerCase().includes(requested.toLowerCase()));
        if (partial.length === 1) {
          const selected = applyGlobalModelSelection(partial[0]!);
          return `✅ Modelo global seleccionado: ${selected}`;
        }
        return `Error: el modelo '${requested}' no está disponible. Usa model_list para consultar los modelos actuales.`;
      }
      const selected = applyGlobalModelSelection(exact);
      return `✅ Modelo global seleccionado: ${selected}`;
    }
    default:
      return `Error: herramienta de control desconocida '${name}'.`;
  }
}

async function executeAdminControlTool(
  name: string,
  args: Record<string, unknown>,
  jid: string,
): Promise<string> {
  if (!isAdminSession(jid)) return "Error: esta herramienta requiere una sesión administradora activa.";

  switch (name) {
    case "llm_provider_status":
      return [
        "🧠 PROVEEDOR LLM",
        `Modo: ${llmProviderMode === "opencode-free" ? OPENCODE_FREE_PROVIDER_NAME : "personalizado"}`,
        `URL base: ${llmConfig ? inferLlmBaseUrl(llmConfig) : "no disponible"}`,
        `Modelo global: ${llmConfig?.defaultModel ?? "no disponible"}`,
        `API key configurada: ${llmConfig?.apiKey ? "sí" : "no"}`,
      ].join("\n");

    case "llm_provider_use_opencode_free":
      if (args.confirmed !== true) return "Error: restaurar OpenCode Free requiere una petición explícita y confirmed=true.";
      providerSetupManager.cancel(jid);
      activateOpenCodeFreeGlobally();
      return `✅ ${OPENCODE_FREE_PROVIDER_NAME} activado como proveedor global.`;

    case "llm_provider_start_setup":
      providerSetupManager.start(jid, llmProviderMode === "custom" ? llmConfig : null);
      return [
        "✅ Flujo seguro de configuración LLM iniciado.",
        providerSetupPrompt("baseUrl"),
      ].join("\n\n");

    case "search_admin_status":
      return formatSearchAdminStatus();

    case "search_admin_set_enabled": {
      const provider = parseSearchProviderArg(args.provider);
      if (!provider || typeof args.enabled !== "boolean") return "Error: provider y enabled son obligatorios.";
      try {
        setSearchProviderEnabled(provider, args.enabled);
        return `✅ ${SEARCH_PROVIDER_LABELS[provider]} ${args.enabled ? "activado" : "desactivado"}.`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    case "search_admin_set_default": {
      const provider = parseSearchProviderArg(args.provider);
      if (!provider) return "Error: proveedor inválido.";
      try {
        setDefaultSearchProvider(provider);
        return `✅ ${SEARCH_PROVIDER_LABELS[provider]} establecido como motor predeterminado.`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    case "search_admin_set_fallback_order": {
      const raw = Array.isArray(args.providers) ? args.providers : [];
      const providers = raw.filter((value): value is SearchProviderId => isSearchProviderId(value));
      if (providers.length === 0) return "Error: indica al menos un proveedor válido.";
      const normalized = normalizeSearchProviderOrder(providers);
      setSearchFallbackOrder(normalized);
      return `✅ Orden de fallback actualizado: ${normalized.map((provider) => SEARCH_PROVIDER_LABELS[provider]).join(" → ")}`;
    }

    case "search_admin_test":
      return await testSearchProvidersNatural(args.provider);

    case "search_admin_start_set_api_key": {
      const provider = parseSearchProviderArg(args.provider);
      if (!provider) return "Error: proveedor inválido.";
      return `✅ Flujo seguro iniciado.\n\n${searchSetupManager.startApiKey(jid, provider)}`;
    }

    case "search_admin_remove_api_key": {
      const provider = parseSearchProviderArg(args.provider);
      if (!provider) return "Error: proveedor inválido.";
      if (args.confirmed !== true) return "Error: eliminar la API key requiere una petición explícita y confirmed=true.";
      removeSearchProviderApiKey(provider);
      return `✅ API key de ${SEARCH_PROVIDER_LABELS[provider]} eliminada y motor desactivado.`;
    }

    case "agent_config_status":
      agentConfig = loadAgentConfig();
      return formatAgentConfigStatus(agentConfig);

    case "agent_config_update": {
      const next = { ...agentConfig };
      if (typeof args.web_search_enabled === "boolean") next.webSearchEnabled = args.web_search_enabled;
      if (typeof args.research_subagent_enabled === "boolean") next.researchSubagentEnabled = args.research_subagent_enabled;
      if (args.default_search_depth === "standard" || args.default_search_depth === "deep") {
        next.defaultSearchDepth = args.default_search_depth;
      }
      if (typeof args.researcher_timeout_minutes === "number" && Number.isFinite(args.researcher_timeout_minutes)) {
        const allowedTimeouts = new Set([5, 10, 15, 30]);
        const minutes = Math.trunc(args.researcher_timeout_minutes);
        if (!allowedTimeouts.has(minutes)) {
          return "Error: researcher_timeout_minutes debe ser 5, 10, 15 o 30, igual que en /config.";
        }
        next.researcherTimeoutMs = minutes * 60_000;
      }
      agentConfig = saveAgentConfig(next);
      return `✅ Configuración del agente actualizada.\n${formatAgentConfigStatus(agentConfig)}`;
    }

    default:
      return `Error: herramienta administrativa de control desconocida '${name}'.`;
  }
}

// ─── Registro de comandos ────────────────────────────────────────

registerCommand(
  "ayuda",
  "Muestra todos los comandos disponibles",
  (_cmd, senderJid) => {
    const sessionUsername = authManager.getUsername(senderJid);
    const isAdmin = sessionUsername ? authManager.isAdmin(sessionUsername) : false;
    const cmds = getCommands(isAdmin);
    const lista = cmds
      .map((c) => `${formatCommandName(c.name)} — ${c.description}`)
      .join("\n");

    return {
      text: [
        "🤖 COMANDOS DISPONIBLES",
        "",
        lista,
        "",
        "💬 También puedes hablarme directamente.",
        "   ¡Recuerdo la conversación!",
      ].join("\n"),
    };
  },
);

registerCommand(
  "ping",
  "Responde con pong",
  () => ({
    text: "🏓 pong",
  }),
);

registerCommand(
  "id",
  "Muestra tu identificador de chat",
  (_cmd, senderJid) => ({
    text: `🆔 Tu identificador de chat: ${senderJid}`,
  }),
);

registerCommand(
  "cambiar-password",
  "Cambia la contraseña de tu propia cuenta",
  async (cmd, senderJid) => {
    const username = authManager.getUsername(senderJid);
    if (!username) return { text: "⚠️ Debes iniciar sesión para cambiar tu contraseña." };
    const inlinePassword = cmd.body.trim();
    if (inlinePassword) {
      if (inlinePassword.length < 4) {
        return { text: "❌ La contraseña debe tener al menos 4 caracteres." };
      }
      await authManager.changePassword(username, inlinePassword);
      return { text: "✅ Tu contraseña fue actualizada correctamente." };
    }
    authManager.setPendingAction(senderJid, {
      type: "change-password",
      step: "awaiting-password",
      username,
    });
    return { text: "🔐 Envía tu nueva contraseña en el siguiente mensaje. Luna intentará borrar ese mensaje después." };
  },
);

registerCommand(
  "cancelar",
  "Cancela completamente la operación actual y evita reintentos o tareas de seguimiento",
  (_cmd, senderJid) => ({ text: cancelCurrentOperation(senderJid) }),
);

registerCommand(
  "clear",
  "Reinicia la conversación borrando todo el historial",
  (_cmd, senderJid) => {
    contextManager?.clearConversation(senderJid);
    return { text: "🧹 Conversación reiniciada. Empezamos de cero." };
  },
);

const clearWorkdirCommandHandler = (cmd: import("./commands.ts").ParsedCommand, senderJid: string) => {
  const confirmed = ["confirmar", "confirmo", "si", "sí", "yes"].includes(cmd.args[0]?.toLowerCase() ?? "");
  if (!confirmed) {
    return {
      text: [
        "⚠️ Esto eliminará todos los archivos temporales, tareas e informes de tu workdir.",
        "No elimina tu conversación, memoria, usuario ni configuraciones.",
        "",
        `Para continuar usa ${formatCommandName(cmd.name)} confirmar`,
      ].join("\n"),
    };
  }
  const hasActiveTask = taskRuntime.list(senderJid).some((task) => task.status === "running" || task.status === "synthesizing");
  if (hasActiveTask) {
    return { text: "❌ No se puede limpiar el workdir mientras hay una tarea de subagentes activa. Cancélala o espera a que termine." };
  }
  workspaceManager.clearWorkdir(senderJid);
  return { text: "🧹 Workdir limpiado por completo. Se recrearon tasks, inbox y exports." };
};

registerCommand(
  "clear-workdir",
  "Limpia todos los archivos y tareas del workdir privado del usuario",
  clearWorkdirCommandHandler,
);

registerCommand(
  "limpiar-workdir",
  "Alias en español para limpiar el workdir privado del usuario",
  clearWorkdirCommandHandler,
);

registerCommand(
  "modelos",
  "Lista los modelos del proveedor activo y permite seleccionar uno",
  async (_cmd, senderJid, _sock) => {
    if (!llmConfig) {
      return { text: "⚠️ El proveedor LLM todavía está iniciando. Intenta de nuevo." };
    }

    const usedFallback = await refreshAvailableModels();
    contextManager?.setAwaitingModelSelection(senderJid);

    const list = availableModels
      .map((name, index) => `${index + 1}. ${name}`)
      .join("\n");
    const currentModel = llmConfig.defaultModel || "ninguno";
    const fallbackNotice = usedFallback
      ? llmProviderMode === "opencode-free"
        ? [
            "",
            "⚠️ El endpoint no respondió o no devolvió modelos gratuitos.",
            "Se muestra el catálogo local de emergencia de OpenCode Free.",
          ]
        : [
            "",
            "⚠️ El endpoint no respondió o no devolvió modelos utilizables.",
            `Se muestra el modelo global configurado: ${llmConfig.defaultModel}`,
          ]
      : [];

    return {
      text: [
        "📋 MODELOS DISPONIBLES",
        "",
        list,
        "",
        `📌 Modelo global actual: ${currentModel}`,
        ...fallbackNotice,
        "",
        "✏️ Responde con el NUMERO del modelo que quieras usar.",
      ].join("\n"),
    };
  },
);

registerCommand(
  "setup-provider",
  "Configura o reemplaza el proveedor LLM (solo administrador)",
  async (cmd, senderJid) => {
    if (!isAdminSession(senderJid)) {
      return { text: "⚠️ Solo el administrador puede configurar el proveedor." };
    }

    const requestedMode = cmd.body.trim().toLowerCase();
    if (["gratis", "free", "opencode", "opencode-free"].includes(requestedMode)) {
      providerSetupManager.cancel(senderJid);
      activateOpenCodeFreeGlobally();
      return {
        text: [
          "✅ OPENCODE FREE ACTIVADO",
          "",
          "Se eliminó la configuración personalizada y se restauró el proveedor gratuito integrado.",
          "Usa !modelos para actualizar y elegir un modelo gratuito.",
        ].join("\n"),
      };
    }

    providerSetupManager.start(
      senderJid,
      llmProviderMode === "custom" ? llmConfig : null,
    );
    return {
      text: [
        "🧠 CONFIGURAR PROVEEDOR LLM",
        "",
        llmProviderMode === "custom"
          ? "La configuración personalizada actual se reemplazará al completar los 3 pasos."
          : `${OPENCODE_FREE_PROVIDER_NAME} seguirá activo hasta completar los 3 pasos.`,
        "Este comando es opcional: Luna funciona con modelos gratuitos sin configurarlo.",
        "Puedes cancelar en cualquier momento con /cancelar.",
        "",
        providerSetupPrompt("baseUrl"),
      ].join("\n"),
    };
  },
  true,
);

registerCommand(
  "config",
  "Configura herramientas, búsqueda y subagente (solo administrador)",
  (_cmd, senderJid) => {
    if (!isAdminSession(senderJid)) {
      return { text: "⚠️ Solo el administrador puede cambiar la configuración global." };
    }
    agentConfig = loadAgentConfig();
    agentConfigFlowManager.start(senderJid);
    return { text: agentConfigFlowManager.render(agentConfig) };
  },
  true,
);

function startSearchSetup(senderJid: string): { text: string } {
  if (!isAdminSession(senderJid)) {
    return { text: "⚠️ Solo el administrador puede configurar motores de búsqueda." };
  }
  return { text: searchSetupManager.start(senderJid) };
}

registerCommand(
  "setup-search",
  "Configura motores de búsqueda y fallback (solo administrador)",
  (_cmd, senderJid) => startSearchSetup(senderJid),
  true,
);

registerCommand(
  "setup-whisper",
  "Configura el modelo y parámetros globales de transcripción (solo administrador)",
  (_cmd, senderJid) => {
    if (!isAdminSession(senderJid)) {
      return { text: "⚠️ Solo el administrador puede configurar Whisper." };
    }
    return { text: whisperSetupManager.start(senderJid) };
  },
  true,
);
// ─── Comandos de autenticación ────────────────────────────────────

registerCommand(
  "setup",
  "Crea la primera cuenta de administrador del bot",
  async (_cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu conversación." };
    }
    if (authManager.userExists()) {
      return { text: "⚠️ Ya existe una cuenta de administrador. Usa !login para iniciar sesión." };
    }
    authManager.setPendingAction(senderJid, { type: "setup", step: "awaiting-username" });
    return {
      text: [
        "🛠️ CREAR CUENTA DE ADMINISTRADOR",
        "",
        "Ingresa el nombre de usuario para el administrador:",
      ].join("\n"),
    };
  },
);

registerCommand(
  "login",
  "Inicia sesión en el bot",
  async (_cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu conversación." };
    }
    if (authManager.isLoggedIn(senderJid)) {
      const loggedUsername = authManager.getUsername(senderJid);
      return { text: `⚠️ Ya has iniciado sesión como ${loggedUsername ?? "desconocido"}.` };
    }
    authManager.setPendingAction(senderJid, { type: "login", step: "awaiting-username" });
    return {
      text: [
        "🔑 INICIO DE SESIÓN",
        "",
        "Ingresa tu nombre de usuario:",
      ].join("\n"),
    };
  },
);

registerCommand(
  "adduser",
  "Crea un nuevo usuario (solo administrador)",
  async (_cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu conversación." };
    }
    const adjUsername = authManager.getUsername(senderJid);
    if (!adjUsername || !authManager.isAdmin(adjUsername)) {
      return { text: "⚠️ Solo el administrador puede crear usuarios." };
    }
    authManager.setPendingAction(senderJid, { type: "adduser", step: "awaiting-username" });
    return {
      text: [
        "👤 CREAR NUEVO USUARIO",
        "",
        "Ingresa el nombre de usuario para el nuevo usuario:",
      ].join("\n"),
    };
  },
  true,
);

registerCommand(
  "banuser",
  "Bloquea el acceso de un usuario (solo administrador)",
  async (cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu conversación." };
    }
    const adjUsername = authManager.getUsername(senderJid);
    if (!adjUsername || !authManager.isAdmin(adjUsername)) {
      return { text: "⚠️ Solo el administrador puede banear usuarios." };
    }
    const target = cmd.args[0]?.toLowerCase();
    if (!target) {
      return { text: "⚠️ Uso: !banuser nombredeusuario" };
    }
    if (!authManager.findUser(target)) {
      return { text: `❌ Usuario '${target}' no encontrado.` };
    }
    if (target === adjUsername) {
      return { text: "⚠️ No puedes banearte a ti mismo." };
    }
    authManager.banUser(target);
    return { text: `🚫 Usuario ${target} ha sido baneado.` };
  },
  true,
);

registerCommand(
  "desban",
  "Desbloquea el acceso de un usuario (solo administrador)",
  async (cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu conversación." };
    }
    const adjUsername = authManager.getUsername(senderJid);
    if (!adjUsername || !authManager.isAdmin(adjUsername)) {
      return { text: "⚠️ Solo el administrador puede desbanear usuarios." };
    }
    const target = cmd.args[0]?.toLowerCase();
    if (!target) {
      return { text: "⚠️ Uso: !desban nombredeusuario" };
    }
    if (!authManager.findUser(target)) {
      return { text: `❌ Usuario '${target}' no encontrado.` };
    }
    authManager.unbanUser(target);
    return { text: `✅ Usuario ${target} ha sido desbaneado.` };
  },
  true,
);

registerCommand(
  "userlist",
  "Muestra todos los usuarios registrados (solo administrador)",
  async (_cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu conversación." };
    }
    const ulUsername = authManager.getUsername(senderJid);
    if (!ulUsername || !authManager.isAdmin(ulUsername)) {
      return { text: "⚠️ Solo el administrador puede ver la lista de usuarios." };
    }
    const users = authManager.getUserList();
    if (users.length === 0) {
      return { text: "👥 No hay usuarios registrados." };
    }
    const lines = users.map((u, i) => {
      const roleIcon = u.role === "admin" ? "👑" : "👤";
      const roleName = u.role === "admin" ? "Administrador" : "Usuario";
      const jidOfUser = authManager.getJid(u.username);
      const status = u.banned
        ? "🔴 Baneado"
        : jidOfUser
          ? "🟢 En línea"
          : "⚪ Desconectado";
      return `${i + 1}. ${u.username} — ${roleIcon} ${roleName} — ${status}`;
    });
    return {
      text: ["👥 USUARIOS REGISTRADOS", "", ...lines].join("\n"),
    };
  },
  true,
);

// ─── Procesamiento de flujo interactivo de auth ─────────────────

/**
 * Procesa la entrada del usuario durante un flujo interactivo
 * de autenticación (login, setup, adduser).
 */
async function handlePendingAuthAction(
  transport: MessagingTransport,
  message: TransportIncomingMessage,
  jid: string,
  text: string,
): Promise<void> {
  const action = authManager.getPendingAction(jid);
  if (!action) return;

  if (action.step === "awaiting-password") {
    await deleteSensitiveIncomingMessage(transport, message);
  }

  try {
    switch (action.type) {
      case "setup":
        await handleSetupStep(transport, jid, text, action);
        break;
      case "login":
        await handleLoginStep(transport, jid, text, action);
        break;
      case "adduser":
        await handleAdduserStep(transport, jid, text, action);
        break;
      case "change-password":
        await handleChangePasswordStep(transport, jid, text, action);
        break;
    }
  } catch (err) {
    console.error(`[auth] Error en flujo ${action.type}:`, err);
    await sendTextHumanized(
      transport,
      jid,
      "❌ No se pudo guardar el cambio. Revisa permisos y espacio en disco e inténtalo de nuevo.",
    );
  }
}

async function handleSetupStep(
  transport: MessagingTransport,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  if (action.step === "awaiting-username") {
    const username = text.trim().toLowerCase();
    if (!username || username.length < 2 || !/^[a-z0-9_]+$/.test(username)) {
      await sendTextHumanized(
        transport,
        jid,
        "❌ Nombre de usuario inválido. Usa solo letras, números y guion bajo (mín 2 caracteres).\n\nIntenta de nuevo:",
      );
      return;
    }
    if (authManager.findUser(username)) {
      await sendTextHumanized(
        transport,
        jid,
        "❌ Ese nombre de usuario ya existe. Elige otro:",
      );
      return;
    }
    authManager.setPendingAction(jid, {
      type: "setup",
      step: "awaiting-password",
      username,
    });
    await sendTextHumanized(transport, jid, `Ingresa la contraseña para ${username}:`);
    return;
  }

  // step === "awaiting-password"
  const password = text.trim();
  if (!password || password.length < 4) {
    await sendTextHumanized(
      transport,
      jid,
      "❌ La contraseña debe tener al menos 4 caracteres.\n\nIntenta de nuevo:",
    );
    return;
  }
  const setupUsername = action.username;
  if (!setupUsername) {
    authManager.clearPendingAction(jid);
    await sendTextHumanized(transport, jid, "❌ Error interno. Intenta de nuevo con !setup.");
    return;
  }
  await authManager.createAdmin(setupUsername, password);
  await authManager.login(jid, setupUsername, password);
  authManager.clearPendingAction(jid);
  await sendTextHumanized(
    transport,
    jid,
    [
      `✅ Cuenta de administrador creada exitosamente. Bienvenido, ${setupUsername}.`,
      "",
      llmConfig
        ? "El proveedor LLM ya está disponible."
        : "Ahora configura el proveedor con /setup-provider.",
    ].join("\n"),
  );
}

async function handleLoginStep(
  transport: MessagingTransport,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  if (action.step === "awaiting-username") {
    const username = text.trim().toLowerCase();
    const user = authManager.findUser(username);
    if (!user) {
      await sendTextHumanized(
        transport,
        jid,
        "❌ Usuario no encontrado. Intenta de nuevo:",
      );
      return;
    }
    if (user.banned) {
      authManager.clearPendingAction(jid);
      await sendTextHumanized(
        transport,
        jid,
        "🚫 Tu cuenta ha sido baneada. Contacta al administrador.",
      );
      return;
    }
    authManager.setPendingAction(jid, {
      type: "login",
      step: "awaiting-password",
      username,
    });
    await sendTextHumanized(transport, jid, "Ingresa tu contraseña:");
    return;
  }

  // step === "awaiting-password"
  const password = text.trim();
  const loginUsername = action.username;
  if (!loginUsername) {
    authManager.clearPendingAction(jid);
    await sendTextHumanized(transport, jid, "❌ Error interno. Intenta de nuevo con !login.");
    return;
  }
  // Verificar si fue baneado entre el paso de usuario y contraseña
  const userCheck = authManager.findUser(loginUsername);
  if (userCheck?.banned) {
    authManager.clearPendingAction(jid);
    await sendTextHumanized(
      transport,
      jid,
      "🚫 Tu cuenta ha sido baneada durante el inicio de sesión. Contacta al administrador.",
    );
    return;
  }
  const success = await authManager.login(jid, loginUsername, password);
  if (success) {
    authManager.clearPendingAction(jid);
    await sendTextHumanized(
      transport,
      jid,
      `✅ Inicio de sesión exitoso. Bienvenido, ${loginUsername}.`,
    );
  } else {
    await sendTextHumanized(
      transport,
      jid,
      "❌ Contraseña incorrecta. Intenta de nuevo:",
    );
  }
}

async function handleAdduserStep(
  transport: MessagingTransport,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  if (action.step === "awaiting-username") {
    const username = text.trim().toLowerCase();
    if (!username || username.length < 2 || !/^[a-z0-9_]+$/.test(username)) {
      await sendTextHumanized(
        transport,
        jid,
        "❌ Nombre de usuario inválido. Usa solo letras, números y guion bajo (mín 2 caracteres).\n\nIntenta de nuevo:",
      );
      return;
    }
    if (authManager.findUser(username)) {
      await sendTextHumanized(
        transport,
        jid,
        "❌ Ese nombre de usuario ya existe. Elige otro:",
      );
      return;
    }
    authManager.setPendingAction(jid, {
      type: "adduser",
      step: "awaiting-password",
      username,
    });
    await sendTextHumanized(transport, jid, `Ingresa la contraseña para ${username}:`);
    return;
  }

  // step === "awaiting-password"
  const password = text.trim();
  if (!password || password.length < 4) {
    await sendTextHumanized(
      transport,
      jid,
      "❌ La contraseña debe tener al menos 4 caracteres.\n\nIntenta de nuevo:",
    );
    return;
  }
  const addUsername = action.username;
  if (!addUsername) {
    authManager.clearPendingAction(jid);
    await sendTextHumanized(transport, jid, "❌ Error interno. Intenta de nuevo con !adduser.");
    return;
  }
  await authManager.addUser(addUsername, password, "user");
  authManager.clearPendingAction(jid);
  await sendTextHumanized(
    transport,
    jid,
    `✅ Usuario ${addUsername} creado exitosamente.`,
  );
}

async function handleChangePasswordStep(
  transport: MessagingTransport,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  const username = action.username ?? authManager.getUsername(jid);
  if (!username) {
    authManager.clearPendingAction(jid);
    await sendTextHumanized(transport, jid, "❌ No pude identificar tu cuenta activa.");
    return;
  }
  const password = text.trim();
  if (!password || password.length < 4) {
    await sendTextHumanized(transport, jid, "❌ La contraseña debe tener al menos 4 caracteres. Intenta de nuevo:");
    return;
  }
  await authManager.changePassword(username, password);
  authManager.clearPendingAction(jid);
  await sendTextHumanized(transport, jid, "✅ Tu contraseña fue actualizada correctamente.");
}

async function handlePendingProviderSetup(
  transport: MessagingTransport,
  message: TransportIncomingMessage,
  jid: string,
  text: string,
): Promise<void> {
  const currentStep = providerSetupManager.getStep(jid);
  if (!currentStep) return;

  try {
    const result = providerSetupManager.submit(jid, text);

    if (result.kind === "next") {
      await sendTextHumanized(transport, jid, providerSetupPrompt(result.nextStep));
      return;
    }

    if (result.kind === "discover-models") {
      if (result.secretInput) {
        await deleteSensitiveIncomingMessage(transport, message);
      }

      const draft = providerSetupManager.getDiscoveryDraft(jid);
      try {
        const discovered = await discoverProviderModels(
          draft.baseUrlCandidates,
          draft.apiKey,
          draft.requestTimeoutMs,
        );
        providerSetupManager.setDiscoveredModels(
          jid,
          discovered.baseUrl,
          discovered.models,
        );
        await sendTextHumanized(
          transport,
          jid,
          providerSetupPrompt("defaultModel", discovered.models),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        providerSetupManager.resetToBaseUrl(jid);
        console.warn(`[provider-setup] No se pudo descubrir el catálogo: ${reason}`);
        await sendTextHumanized(
          transport,
          jid,
          [
            `❌ ${reason}`,
            "",
            "La configuración no se guardó. Vuelve a indicar la URL base para reintentar.",
            "",
            providerSetupPrompt("baseUrl"),
          ].join("\n"),
        );
      }
      return;
    }

    const savedConfig = saveLlmConfig(result.config, llmConfigPath);
    saveGlobalLlmModel(savedConfig, llmConfigPath);
    initLlm(savedConfig, llmConfigPath);
    providerSetupManager.cancel(jid);

    await sendTextHumanized(
      transport,
      jid,
      [
        "✅ PROVEEDOR CONFIGURADO",
        "",
        `URL base: ${inferLlmBaseUrl(savedConfig)}`,
        `Modelo global: ${savedConfig.defaultModel}`,
        "El catálogo se detectó y validó antes de guardar la configuración.",
        "La configuración personalizada tiene prioridad sobre OpenCode Free.",
        "",
        "Este modelo queda activo globalmente para todos los chats existentes y nuevos.",
        "Cualquier cambio posterior con !modelos también se aplicará globalmente.",
      ].join("\n"),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const step = providerSetupManager.getStep(jid) ?? currentStep;
    const models = step === "defaultModel"
      ? providerSetupManager.getAvailableModels(jid)
      : [];
    console.warn(`[provider-setup] Entrada inválida en ${step}: ${reason}`);
    await sendTextHumanized(
      transport,
      jid,
      [
        `❌ ${reason}`,
        "",
        providerSetupPrompt(step, models),
      ].join("\n"),
    );
  }
}

async function handlePendingAgentConfig(
  transport: MessagingTransport,
  jid: string,
  text: string,
): Promise<void> {
  try {
    const result = agentConfigFlowManager.submit(jid, text, agentConfig);
    agentConfig = result.config;
    await sendTextHumanized(transport, jid, result.text);
  } catch (error) {
    await sendTextHumanized(
      transport,
      jid,
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handlePendingSearchSetup(
  transport: MessagingTransport,
  message: TransportIncomingMessage,
  jid: string,
  text: string,
): Promise<void> {
  try {
    const result = await searchSetupManager.submit(jid, text);
    if (result.secretInput) {
      await deleteSensitiveIncomingMessage(transport, message);
    }
    await sendTextHumanized(transport, jid, result.text);
  } catch (error) {
    await sendTextHumanized(
      transport,
      jid,
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handlePendingWhisperSetup(
  transport: MessagingTransport,
  jid: string,
  text: string,
): Promise<void> {
  let lastProgress = -25;
  const activity = await startActivity(transport, jid);
  try {
    const result = await whisperSetupManager.submit(jid, text, async (progress) => {
      if (progress.percent < 100 && progress.percent < lastProgress + 25) return;
      lastProgress = progress.percent;
      await sendText(transport, jid, `⬇️ Descargando ${progress.model.id}: ${progress.percent}%`, { waitForDelivery: false });
    });
    await sendTextHumanized(transport, jid, result.text);
  } catch (error) {
    await sendTextHumanized(
      transport,
      jid,
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await activity.stop();
  }
}

function normalizeNaturalText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[¿?¡!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Durante una espera segura del navegador, el mensaje completo no llega al LLM.
 * Esta extracción conserva símbolos de contraseña como !@#$ y solo elimina una
 * aclaración humana entre paréntesis escrita después del secreto.
 */
function isLikelyUnprefixedBrowserInput(value: string, pending: PendingBrowserInputRequest): boolean {
  const raw = value.trim();
  if (!raw || raw.length > 300) return false;
  const normalized = normalizeNaturalText(raw);
  const controls = new Set(["cancelalo", "cancela", "detenlo", "deten", "dejalo", "olvidalo", "aborta", "continua", "continuar", "sigue", "seguir", "corregir usuario"]);
  if (controls.has(normalized)) return true;
  if (/(?:no es|incorrect|equivoc|cambi|corrig).{0,30}(?:usuario|cuenta|correo|email)/iu.test(raw)) return true;

  if (pending.kind === "otp") return /^\d{4,10}$/u.test(raw.replace(/[\s-]+/g, ""));
  if (pending.kind === "username") {
    if (/\s/u.test(raw)) return false;
    if (["hola", "gracias", "ok", "si", "no", "oye", "continua", "sigue"].includes(normalized)) return false;
    return /^[\p{L}\p{N}._+@-]{2,160}$/u.test(raw);
  }
  if (pending.kind === "password") {
    if (/\s/u.test(raw) || raw.length < 4) return false;
    if (/^https?:\/\//iu.test(raw)) return false;
    if (["hola", "gracias", "como", "estado", "continua", "sigue"].includes(normalized)) return false;
    const hasDigit = /\d/u.test(raw);
    const hasSymbol = /[^\p{L}\p{N}]/u.test(raw);
    const hasCaseMix = /[a-záéíóúñ]/u.test(raw) && /[A-ZÁÉÍÓÚÑ]/u.test(raw);
    return hasDigit || hasSymbol || hasCaseMix;
  }
  // Un dato libre puede ser indistinguible de una conversación normal; exige ID.
  return false;
}

function extractPendingBrowserSecret(text: string): string {
  let value = text.trim();
  if (!value) return "";
  const fenced = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/u.exec(value);
  if (fenced?.[1]) value = fenced[1].trim();
  value = value.replace(/^[`"']+|[`"']+$/g, "").trim();

  const labeled = /(?:contrase(?:ñ|n)a|password|codigo|código|otp)\s*(?:es|:|=)?\s*(.+)$/iu.exec(value);
  if (labeled?.[1]) value = labeled[1].trim();

  // Ejemplo: "Pepe_123! (la cambié por seguridad)" -> "Pepe_123!".
  value = value.replace(/\s+\([^)]*\)\s*$/u, "").trim();
  return value;
}

function extractPendingBrowserUsername(text: string): string {
  const trimmed = text.trim();
  const email = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
  if (email) return email;
  const labeled = /(?:correo|email|usuario|username|user)\s*(?:es|:|=)?\s*[`"']?([^\s,;`"']+)/iu.exec(trimmed)?.[1];
  return (labeled ?? trimmed).trim();
}

function detectSearchProviderMention(text: string): SearchProviderId | null {
  const normalized = normalizeNaturalText(text);
  const aliases: Array<[RegExp, SearchProviderId]> = [
    [/\b(?:firecrawl|fireclaw)\b/i, "firecrawl"],
    [/\b(?:brave(?: search)?)\b/i, "brave"],
    [/\b(?:exa(?: ai)?)\b/i, "exa"],
    [/\btavily\b/i, "tavily"],
    [/\blinkup\b/i, "linkup"],
    [/\bserpapi\b/i, "serpapi"],
    [/\bzenserp\b/i, "zenserp"],
  ];
  for (const [pattern, provider] of aliases) {
    if (pattern.test(normalized)) return provider;
  }
  return null;
}

function hasInlineCredentialIntent(text: string): boolean {
  const normalized = normalizeNaturalText(text);
  return /(api key|apikey|key|clave|token|configur|reemplaz|cambi|agreg|anad|usar|usa|este es el de|es este)/i.test(normalized);
}

async function tryHandleInlineSearchCredential(
  transport: MessagingTransport,
  message: TransportIncomingMessage,
  jid: string,
  text: string,
): Promise<boolean> {
  if (!isAdminSession(jid) || !hasInlineCredentialIntent(text)) return false;
  const provider = detectSearchProviderMention(text);
  if (!provider) return false;
  const secret = extractSecretTokenFromMessage(text);
  // Si el extractor devolvió la frase completa, no encontramos una credencial
  // inequívoca y dejamos que el agente procese la intención normalmente.
  if (!secret || secret === text.trim() || secret.length < 8 || /\s/.test(secret)) return false;

  saveSearchProviderApiKey(provider, secret);
  searchSetupManager.cancel(jid);
  await deleteSensitiveIncomingMessage(transport, message);
  await sendTextHumanized(
    transport,
    jid,
    `✅ API key de ${SEARCH_PROVIDER_LABELS[provider]} actualizada y motor activado.`,
  );
  return true;
}

function containsProtectedBrowserCredential(text: string): boolean {
  // Guardia de seguridad únicamente: no enruta herramientas ni decide usar navegador.
  // Evita que una nota interna con credential_ref se confunda con una petición para
  // cambiar la contraseña de la propia cuenta de Luna.
  return /credential_ref=browser-cred-/i.test(text)
    || /referencia segura browser-cred-/i.test(normalizeNaturalText(text));
}

function userExplicitlyRequestsConversationClear(text: string): boolean {
  const normalized = normalizeNaturalText(text);
  const hasConversationTarget = /\b(conversacion|chat|historial)\b/i.test(normalized);
  const hasClearVerb = /\b(limpi|borr|elimin|reinici|resete|restablec)\w*/i.test(normalized);
  const explicitFreshStart = /\b(empezar|comenzar|iniciar) de cero\b/i.test(normalized);
  return (hasConversationTarget && hasClearVerb) || explicitFreshStart;
}

function userExplicitlyRequestsOwnPasswordChange(text: string): boolean {
  if (containsProtectedBrowserCredential(text)) return false;
  const normalized = normalizeNaturalText(text);
  if (!/\b(contrasena|password)\b/i.test(normalized)) return false;
  if (!/\b(cambi|actualiz|reemplaz|pon|poner)\w*/i.test(normalized)) return false;

  // Solo aceptamos una intención explícita sobre la propia contraseña de Luna.
  // No usamos detección de URLs, dominios ni intención de navegador para decidir
  // esta acción: el orquestador conserva la responsabilidad de elegir herramientas.
  const explicitOwn = /\bmi (?:contrasena|password)\b/i.test(normalized)
    || /\b(?:contrasena|password) de (?:mi )?(?:cuenta de )?luna\b/i.test(normalized);
  const genericWithoutExternalTarget = /^(?:quiero )?(?:cambiar|actualizar|reemplazar) (?:la )?(?:contrasena|password)$/i.test(normalized);
  return explicitOwn || genericWithoutExternalTarget;
}

function extractInlinePasswordChange(text: string): string | null {
  if (!userExplicitlyRequestsOwnPasswordChange(text)) return null;

  // Se trabaja sobre el texto original para preservar mayúsculas y símbolos.
  const patterns = [
    /(?:contrase(?:ñ|n)a|password)\s+(?:a|por|es|sera|será)\s+(.+)$/iu,
    /(?:nueva\s+contrase(?:ñ|n)a|nuevo\s+password)\s*(?:es|:|=)?\s+(.+)$/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text.trim());
    const candidate = match?.[1]?.trim();
    if (candidate && candidate.length >= 4) return candidate;
  }
  return "";
}

async function tryHandleNaturalPasswordChange(
  transport: MessagingTransport,
  message: TransportIncomingMessage,
  jid: string,
  text: string,
): Promise<boolean> {
  if (!authManager.isLoggedIn(jid)) return false;
  const extracted = extractInlinePasswordChange(text);
  if (extracted === null) return false;
  const username = authManager.getUsername(jid);
  if (!username) return false;

  if (!extracted) {
    authManager.setPendingAction(jid, { type: "change-password", step: "awaiting-password", username });
    await sendTextHumanized(
      transport,
      jid,
      "🔐 Envía tu nueva contraseña en el siguiente mensaje. Luna intentará borrar ese mensaje después de procesarlo.",
    );
    return true;
  }

  await authManager.changePassword(username, extracted);
  await deleteSensitiveIncomingMessage(transport, message);
  await sendTextHumanized(transport, jid, "✅ Tu contraseña fue actualizada correctamente.");
  return true;
}

// Frases locales que deben funcionar incluso antes de que exista acceso al LLM.
// Las credenciales siguen procesándose fuera del modelo.
function parseNaturalLocalCommand(text: string, jid: string): ParsedCommand | null {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[¿?¡!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Las cancelaciones ambiguas ("cancélalo", "deténlo") se dejan al
  // orquestador cuando ya hay sesión: así puede elegir una tarea/agente concreto.
  // Solo las peticiones inequívocamente globales se resuelven aquí.
  const cancelAllPhrases = new Set([
    "cancelar todo", "cancela todo", "deten todo", "detener todo",
    "aborta todo", "abortar todo", "para todo",
  ]);
  if (cancelAllPhrases.has(normalized)) {
    return { name: "cancelar", args: [], body: "" };
  }

  if (!authManager.userExists()) {
    const setupPhrases = [
      "setup", "crear administrador", "crear cuenta de administrador",
      "configurar administrador", "crear el administrador", "configurar cuenta administrador",
    ];
    if (setupPhrases.some((phrase) => normalized === phrase || normalized.includes(phrase))) {
      return { name: "setup", args: [], body: "" };
    }
  } else if (!authManager.isLoggedIn(jid)) {
    const loginPhrases = [
      "login", "iniciar sesion", "inicia sesion", "quiero iniciar sesion",
      "entrar", "quiero entrar", "acceder", "quiero acceder",
    ];
    if (loginPhrases.some((phrase) => normalized === phrase || normalized.includes(phrase))) {
      return { name: "login", args: [], body: "" };
    }
  }

  return null;
}

// ─── Procesamiento de mensajes ───────────────────────────────────

export async function handleMessage(
  transport: MessagingTransport,
  message: TransportIncomingMessage,
): Promise<void> {
  const remoteJid = message.conversationId;

  // Los adaptadores deben filtrar grupos cuanto antes; esta segunda barrera
  // protege auth/contexto si una implementación futura entrega uno por error.
  if (!remoteJid || message.fromSelf || message.isGroup) {
    return;
  }

  void transport.markRead(message).catch(() => {});

  const mediaKind = getMediaKind(message);
  let text = message.text ?? "";

  // Algunos adaptadores emiten eventos sin contenido conversacional
  // (protocolos, reacciones, recibos y otros eventos internos). No deben
  // convertirse en mensajes vacíos para el LLM porque provocarían respuestas
  // espontáneas sin una entrada real del usuario.
  if (!mediaKind && !text.trim()) {
    return;
  }

  // ── Parsear comando o intención local segura ─────────────────────
  // Login/setup/cancelación deben poder expresarse naturalmente sin enviar
  // credenciales ni estados de autenticación al proveedor LLM.
  const command = parseCommand(text) ?? parseNaturalLocalCommand(text, remoteJid);

  // ── Acción pendiente de auth ─────────────────────────────────────
  const pendingAction = authManager.getPendingAction(remoteJid);
  if (pendingAction) {
    if (command && command.name === "cancelar") {
      authManager.clearPendingAction(remoteJid);
      contextManager?.clearAwaitingModelSelection(remoteJid);
      await sendTextHumanized(transport, remoteJid, "❌ Operación cancelada.");
      return;
    }
    if (command) {
      // Envió un comando durante flujo — cancelar pending y seguir
      authManager.clearPendingAction(remoteJid);
    } else {
      await handlePendingAuthAction(transport, message, remoteJid, text);
      return;
    }
  }

  // ── Puerta de autenticación ─────────────────────────────────────
  if (!authManager.userExists()) {
    if (!(command && ["setup", "cancelar"].includes(command.name))) {
      await sendTextHumanized(
        transport,
        remoteJid,
        "🔒 No hay cuentas de administrador. Envía !setup para crear la primera.",
      );
      return;
    }
  } else if (!authManager.isLoggedIn(remoteJid)) {
    if (!(command && ["login", "cancelar"].includes(command.name))) {
      await sendTextHumanized(
        transport,
        remoteJid,
        "🔒 Debes iniciar sesión primero. Envía !login",
      );
      return;
    }
  } else {
    // Logueado — verificar si fue baneado durante la sesión
    const sessionUsername = authManager.getUsername(remoteJid);
    if (sessionUsername) {
      const userRecord = authManager.findUser(sessionUsername);
      if (userRecord?.banned) {
        authManager.logout(remoteJid);
        await sendTextHumanized(
          transport,
          remoteJid,
          "🚫 Tu cuenta ha sido baneada. Contacta al administrador.",
        );
        return;
      }
    }
  }

  if (authManager.isLoggedIn(remoteJid)) {
    retryPendingBackgroundReviews(transport, remoteJid);
    if (isTaskProgressQuestion(text)) {
      await sendTextHumanized(transport, remoteJid, formatTaskProgressForUser(remoteJid));
      return;
    }
  }

  // ── Credenciales y contraseña incluidas directamente en lenguaje natural ──
  // Se procesan antes del LLM y antes de cualquier menú pendiente para evitar
  // pedir de nuevo secretos que el usuario ya proporcionó en el mismo mensaje.
  // ── Credenciales seguras para navegación web ───────────────────
  // Una contraseña de un sitio web nunca se envía al LLM. Si viene en el
  // mismo mensaje se reemplaza por una referencia opaca; si falta, el sistema
  // la solicita directamente y reanuda la instrucción original al recibirla.
  const allPendingBrowserInputs = browserCredentialStore.getPendingInputs(remoteJid);
  const directAgentMatch = /^\s*(A-[A-Z0-9]{6})\s*(?::|-)?\s+([\s\S]+)$/iu.exec(text);
  const numericMatch = /^\s*(\d+)\s*(?::|-)?\s+([\s\S]+)$/u.exec(text);
  const cancelNamedMatch = /(?:cancela|cancelar|deten|detener|aborta|abortar).{0,30}(A-[A-Z0-9]{6})/iu.exec(text);
  const singlePending = allPendingBrowserInputs.length === 1 ? allPendingBrowserInputs[0] : undefined;
  const looksLikePendingValue = allPendingBrowserInputs.some((pending) => isLikelyUnprefixedBrowserInput(text, pending));
  const shouldHandlePending = Boolean(
    directAgentMatch
    || numericMatch
    || cancelNamedMatch
    || (singlePending && isLikelyUnprefixedBrowserInput(text, singlePending))
    || (allPendingBrowserInputs.length > 1 && looksLikePendingValue),
  );
  const pendingBrowserInputs = shouldHandlePending ? allPendingBrowserInputs : [];

  if (pendingBrowserInputs.length > 0) {
    if (command && command.name === "cancelar") {
      await sendTextHumanized(transport, remoteJid, cancelCurrentOperation(remoteJid));
      return;
    }
    if (cancelNamedMatch) {
      const selector = cancelNamedMatch[1]!;
      const target = browserCredentialStore.getPendingInput(remoteJid, selector);
      browserCredentialStore.cancelPendingInput(remoteJid, new Error("Solicitud cancelada por el usuario."), selector);
      taskRuntime.cancelAgent(remoteJid, selector);
      await sendTextHumanized(transport, remoteJid, target
        ? `✅ Agente ${target.agentId ?? selector} (${target.agentName ?? "navegador"}) cancelado.`
        : `No encontré una espera activa para ${selector}.`);
      return;
    }

    const selectedPending = directAgentMatch
      ? browserCredentialStore.getPendingInput(remoteJid, directAgentMatch[1])
      : numericMatch
        ? pendingBrowserInputs[Number(numericMatch[1]) - 1]
        : pendingBrowserInputs.length === 1
          ? pendingBrowserInputs[0]
          : undefined;
    const pendingValue = directAgentMatch?.[2] ?? numericMatch?.[2] ?? text;

    if (!selectedPending) {
      const lines = [
        "🧩 Hay varias tareas esperando datos.",
        "",
        ...pendingBrowserInputs.map((pending, index) =>
          `${index + 1}. ${pending.agentId ?? pending.requestId} — ${pending.agentName ?? "Navegador"} — espera ${pending.fieldName}`),
        "",
        "Responde con el ID del agente y el dato.",
        "Ejemplo: A-DB6807 fastuser",
        "También puedes usar: 2 fastuser",
      ];
      await sendTextHumanized(transport, remoteJid, lines.join("\n"));
      return;
    }

    const selector = selectedPending.requestId ?? selectedPending.agentId;
    const normalizedPendingText = normalizeNaturalText(pendingValue);
    if (["cancelalo", "cancela", "detenlo", "deten", "dejalo", "olvidalo", "aborta"].includes(normalizedPendingText)) {
      browserCredentialStore.cancelPendingInput(remoteJid, new Error("Solicitud cancelada por el usuario."), selector);
      if (selectedPending.agentId) taskRuntime.cancelAgent(remoteJid, selectedPending.agentId);
      await sendTextHumanized(
        transport,
        remoteJid,
        selectedPending.agentId
          ? `✅ Agente ${selectedPending.agentId} (${selectedPending.agentName ?? "navegador"}) cancelado.`
          : "✅ Solicitud pendiente del navegador cancelada.",
      );
      return;
    }

    if (["continua", "continuar", "sigue", "seguir"].includes(normalizedPendingText)) {
      const secret = selectedPending.kind === "password" || selectedPending.kind === "otp";
      const targetLines = [
        secret ? "🔐 MENSAJE DEL SISTEMA" : "🧩 MENSAJE DEL SISTEMA",
        "",
        `El agente ${selectedPending.agentId ?? "del navegador"} sigue esperando ${selectedPending.fieldName}.`,
      ];
      if (selectedPending.url) targetLines.push(`Sitio: ${selectedPending.url}`);
      if (selectedPending.username) targetLines.push(`Cuenta: ${selectedPending.username}`);
      targetLines.push("", `Responde con: ${selectedPending.agentId ?? "1"} <dato>`);
      await sendTextHumanized(transport, remoteJid, targetLines.join("\n"));
      return;
    }

    const identityCorrection = selectedPending.kind === "password"
      && /(?:no\s+es|incorrect|equivoc|cambi|corrig|pide|solicita).{0,40}(?:usuario|cuenta|correo|email)|(?:usuario|cuenta|correo|email).{0,40}(?:incorrect|equivoc|otra|nuevo)/iu.test(pendingValue);
    if (identityCorrection && selectedPending.agentId) {
      const resumed = browserCredentialStore.resolvePendingInput(remoteJid, {
        kind: "correction",
        action: "retry_identity",
        message: pendingValue.trim(),
      }, selector);
      if (resumed) {
        await sendText(transport, remoteJid, [
          "🧩 MENSAJE DEL SISTEMA",
          "",
          `Entendido. El agente ${selectedPending.agentId} volverá a pedir primero el usuario/correo y después la contraseña, sin cerrar la página actual.`,
        ].join("\n"), { waitForDelivery: false });
      }
      return;
    }

    // Espera viva de un agente: se resuelve la Promise exacta mediante requestId.
    if (selectedPending.agentId && selectedPending.requestId) {
      if (selectedPending.kind === "password") {
        const password = extractPendingBrowserSecret(pendingValue);
        if (!password || !selectedPending.url || !selectedPending.username) {
          await sendTextHumanized(transport, remoteJid, [
            "🔐 MENSAJE DEL SISTEMA",
            "",
            "No pude asociar la contraseña con una cuenta concreta.",
            `El agente ${selectedPending.agentId} sigue pausado. Escribe \"corregir usuario\" para volver a pedir la cuenta.`,
          ].join("\n"));
          return;
        }
        const credential = browserCredentialStore.create({
          jid: remoteJid,
          url: selectedPending.url,
          username: selectedPending.username,
          password,
        });
        await deleteSensitiveIncomingMessage(transport, message);
        const resumed = browserCredentialStore.resolvePendingInput(remoteJid, {
          kind: "password",
          credentialRef: credential.ref,
          url: credential.url,
          username: credential.username,
        }, selector);
        if (!resumed) {
          browserCredentialStore.delete(credential.ref);
          await sendTextHumanized(transport, remoteJid, "⚠️ Esa espera ya no estaba activa.");
          return;
        }
        await sendText(transport, remoteJid, `🔐 MENSAJE DEL SISTEMA\n\nContraseña recibida para ${selectedPending.agentId}. La misma sesión continúa.`, { waitForDelivery: false });
        return;
      }

      if (selectedPending.kind === "otp") {
        const value = extractPendingBrowserSecret(pendingValue);
        if (!value) {
          await sendTextHumanized(transport, remoteJid, `🔐 MENSAJE DEL SISTEMA\n\nEnvía el código para ${selectedPending.agentId}.`);
          return;
        }
        const secret = browserCredentialStore.createSecret({ jid: remoteJid, kind: "otp", value });
        await deleteSensitiveIncomingMessage(transport, message);
        const resumed = browserCredentialStore.resolvePendingInput(remoteJid, { kind: "otp", secretRef: secret.ref }, selector);
        if (!resumed) {
          browserCredentialStore.delete(secret.ref);
          await sendTextHumanized(transport, remoteJid, "⚠️ Esa espera ya no estaba activa.");
          return;
        }
        await sendText(transport, remoteJid, `🔐 MENSAJE DEL SISTEMA\n\nCódigo recibido para ${selectedPending.agentId}. La tarea continúa.`, { waitForDelivery: false });
        return;
      }

      const value = selectedPending.kind === "username"
        ? extractPendingBrowserUsername(pendingValue)
        : pendingValue.trim();
      if (!value) {
        await sendTextHumanized(transport, remoteJid, `🧩 Envía ${selectedPending.fieldName} para ${selectedPending.agentId}.`);
        return;
      }
      const resumed = browserCredentialStore.resolvePendingInput(remoteJid, {
        kind: selectedPending.kind,
        value,
      }, selector);
      if (!resumed) {
        await sendTextHumanized(transport, remoteJid, "⚠️ Esa espera ya no estaba activa.");
        return;
      }
      await sendText(transport, remoteJid, `🧩 MENSAJE DEL SISTEMA\n\nDato recibido para ${selectedPending.agentId}. La misma página continúa abierta.`, { waitForDelivery: false });
      return;
    }

    // Compatibilidad con browser_request_credential del orquestador principal.
    if (selectedPending.kind === "password") {
      const password = extractPendingBrowserSecret(pendingValue);
      if (!password || !selectedPending.url || !selectedPending.username) {
        await sendTextHumanized(transport, remoteJid, "🔐 MENSAJE DEL SISTEMA\n\nNo pude asociar la contraseña con una cuenta concreta.");
        return;
      }
      const credential = browserCredentialStore.create({
        jid: remoteJid,
        url: selectedPending.url,
        username: selectedPending.username,
        password,
      });
      browserCredentialStore.clearPendingInput(remoteJid, selector);
      await deleteSensitiveIncomingMessage(transport, message);
      await handleAiChat(transport, remoteJid, sanitizeBrowserCredentialText(selectedPending.originalText, credential));
      return;
    }

    if (selectedPending.kind === "otp") {
      const value = extractPendingBrowserSecret(pendingValue);
      if (!value) return;
      const secret = browserCredentialStore.createSecret({ jid: remoteJid, kind: "otp", value });
      browserCredentialStore.clearPendingInput(remoteJid, selector);
      await deleteSensitiveIncomingMessage(transport, message);
      await handleAiChat(
        transport,
        remoteJid,
        `${selectedPending.originalText}\n\n[SISTEMA: El valor secreto fue retirado. Usa secret_ref=${secret.ref} únicamente con browser_fill_secret.]`,
      );
      return;
    }

    const value = selectedPending.kind === "username"
      ? extractPendingBrowserUsername(pendingValue)
      : pendingValue.trim();
    if (!value) return;
    browserCredentialStore.clearPendingInput(remoteJid, selector);
    await handleAiChat(
      transport,
      remoteJid,
      `${selectedPending.originalText}\n\n[SISTEMA: El usuario proporcionó ${selectedPending.fieldName}: ${value}.]`,
    );
    return;
  }


  if (authManager.isLoggedIn(remoteJid)) {
    // Preprocesamiento EXCLUSIVAMENTE de seguridad. Detectar una URL, localhost,
    // un login o un usuario NO lanza browser_agent ni inicia una captura pendiente.
    // Solo si la contraseña YA viene escrita en el mensaje la retiramos antes de
    // enviarlo al LLM y adjuntamos una referencia opaca. Después, el orquestador
    // decide libremente si usa browser_agent, researcher_web, spawn_agents o nada.
    const inlineBrowserCredential = extractBrowserLoginIntent(text);
    if (
      inlineBrowserCredential.loginRequested
      && inlineBrowserCredential.url
      && inlineBrowserCredential.username
      && inlineBrowserCredential.password
    ) {
      const credential = browserCredentialStore.create({
        jid: remoteJid,
        url: inlineBrowserCredential.url,
        username: inlineBrowserCredential.username,
        password: inlineBrowserCredential.password,
      });
      text = sanitizeBrowserCredentialText(text, credential);
      await deleteSensitiveIncomingMessage(transport, message);
    }
  }

  if (await tryHandleInlineSearchCredential(transport, message, remoteJid, text)) {
    return;
  }
  if (!command && await tryHandleNaturalPasswordChange(transport, message, remoteJid, text)) {
    return;
  }

  // ── Configuración interactiva del proveedor ───────────────────
  if (providerSetupManager.has(remoteJid)) {
    if (!isAdminSession(remoteJid)) {
      providerSetupManager.cancel(remoteJid);
      await sendTextHumanized(
        transport,
        remoteJid,
        "⚠️ La configuración se canceló porque la sesión ya no es administradora.",
      );
      return;
    }

    if (command && command.name === "cancelar") {
      providerSetupManager.cancel(remoteJid);
      await sendTextHumanized(transport, remoteJid, "❌ Configuración del proveedor cancelada.");
      return;
    }

    if (command) {
      providerSetupManager.cancel(remoteJid);
    } else {
      await handlePendingProviderSetup(transport, message, remoteJid, text);
      return;
    }
  }

  // ── Configuración interactiva del agente ───────────────────────
  if (agentConfigFlowManager.has(remoteJid)) {
    if (!isAdminSession(remoteJid)) {
      agentConfigFlowManager.cancel(remoteJid);
      await sendTextHumanized(transport, remoteJid, "⚠️ La configuración se canceló porque la sesión ya no es administradora.");
      return;
    }
    if (command && command.name === "cancelar") {
      agentConfigFlowManager.cancel(remoteJid);
      await sendTextHumanized(transport, remoteJid, "❌ Configuración del agente cancelada.");
      return;
    }
    if (command) {
      agentConfigFlowManager.cancel(remoteJid);
    } else {
      await handlePendingAgentConfig(transport, remoteJid, text);
      return;
    }
  }

  // ── Configuración interactiva de búsqueda ─────────────────────
  if (searchSetupManager.has(remoteJid)) {
    if (!isAdminSession(remoteJid)) {
      searchSetupManager.cancel(remoteJid);
      await sendTextHumanized(transport, remoteJid, "⚠️ La configuración se canceló porque la sesión ya no es administradora.");
      return;
    }
    if (command && command.name === "cancelar") {
      searchSetupManager.cancel(remoteJid);
      await sendTextHumanized(transport, remoteJid, "❌ Configuración de búsqueda cancelada.");
      return;
    }
    if (command) {
      searchSetupManager.cancel(remoteJid);
    } else {
      await handlePendingSearchSetup(transport, message, remoteJid, text);
      return;
    }
  }

  // ── Configuración interactiva de Whisper ──────────────────────
  if (whisperSetupManager.has(remoteJid)) {
    if (!isAdminSession(remoteJid)) {
      whisperSetupManager.cancel(remoteJid);
      await sendTextHumanized(transport, remoteJid, "⚠️ La configuración se canceló porque la sesión ya no es administradora.");
      return;
    }
    if (command && command.name === "cancelar") {
      whisperSetupManager.cancel(remoteJid);
      await sendTextHumanized(transport, remoteJid, "❌ Configuración de Whisper cancelada.");
      return;
    }
    if (command) {
      whisperSetupManager.cancel(remoteJid);
    } else {
      await handlePendingWhisperSetup(transport, remoteJid, text);
      return;
    }
  }

  // ── Verificar si espera selección de modelo ────────────────────
  if (contextManager?.isAwaitingModelSelection(remoteJid)) {
    if (isPositiveInteger(text.trim())) {
      const index = parseInt(text.trim(), 10) - 1;
      if (availableModels.length === 0) {
        contextManager.clearAwaitingModelSelection(remoteJid);
        await sendTextHumanized(
          transport,
          remoteJid,
          "❌ No hay modelos disponibles. Usa !modelos para recargar.",
        );
        return;
      }
      const model = availableModels[index];
      if (model) {
        const selected = applyGlobalModelSelection(model);
        contextManager.clearAwaitingModelSelection(remoteJid);
        await sendTextHumanized(
          transport,
          remoteJid,
          `✅ Modelo global seleccionado: ${selected}. Se aplicará a todos los chats.`,
        );
      } else {
        await sendTextHumanized(
          transport,
          remoteJid,
          `❌ Número inválido. Elige entre 1 y ${availableModels.length}.`,
        );
      }
      return;
    }

    contextManager.clearAwaitingModelSelection(remoteJid);
  }

  // ── Comandos con prefijo ───────────────────────────────────────
  if (command) {
    if (command.name === "cambiar-password" && command.body.trim()) {
      await deleteSensitiveIncomingMessage(transport, message);
    }
    const result = await dispatchCommand(command, remoteJid, transport);

    if (result) {
      await sendTextHumanized(transport, remoteJid, result.text);
    } else {
      const sessionUsername = authManager.getUsername(remoteJid);
      const isAdmin = sessionUsername
        ? authManager.isAdmin(sessionUsername)
        : false;
      const cmds = getCommands(isAdmin);
      const lista = cmds
        .map((c) => formatCommandName(c.name))
        .join(", ");
      await sendTextHumanized(
        transport,
        remoteJid,
        [
          `❓ Comando desconocido: !${command.name}`,
          "",
          `Comandos: ${lista}`,
          "",
          "Escribe !ayuda para más información.",
        ].join("\n"),
      );
    }
    return;
  }

  // ── Procesamiento local de audio e imágenes ────────────────────
  if (mediaKind) {
    await handleMediaMessage(transport, message, remoteJid, mediaKind);
    return;
  }

  // ── Ignorar mensajes si el JID está en compactación ─────────────
  if (compactingJids.has(remoteJid)) {
    // El usuario ya recibió una notificación de "espera", ignoramos
    // mensajes adicionales hasta que termine la compactación
    return;
  }

  // ── Chat AI (mensajes sin prefijo) ─────────────────────────────
  if (!llmConfig || !contextManager) {
    await sendTextHumanized(
      transport,
      remoteJid,
      "⚠️ El chat LLM todavía está iniciando. Intenta nuevamente en unos segundos.",
    );
    return;
  }

  await handleAiChat(transport, remoteJid, text);
}

/**
 * Procesa un mensaje como chat AI: construye contexto, llama a la API
 * con soporte de function calling (tools), responde.
 */
async function handleAiChat(
  transport: MessagingTransport,
  remoteJid: string,
  userText: string,
): Promise<void> {
  if (!llmConfig || !contextManager) {
    return;
  }

  const model = contextManager.getModel(remoteJid);

  if (!model) {
    await sendTextHumanized(
      transport,
      remoteJid,
      "⚠️ No hay un modelo seleccionado. Usa !modelos para elegir uno.",
    );
    return;
  }

  // Ejecutar todo el procesamiento con lock exclusivo por JID
  // para evitar que dos mensajes simultáneos corrompan el contexto
  const cm = contextManager;
  const cfg = llmConfig;
  const agentConfigSnapshot = { ...agentConfig };
  // Todas las herramientas permitidas por rol permanecen disponibles. La presencia
  // de una URL o credential_ref no enruta ni oculta herramientas automáticamente;
  // el agente principal decide qué capacidad usar. Las acciones sensibles mantienen
  // sus validaciones autoritativas en el ejecutor.
  const activeTools = getAvailableTools(remoteJid);
  await cm.withLock(remoteJid, async () => {

  const userMessage = { role: "user" as const, content: userText };
  cm.addMessage(remoteJid, userMessage);

  // Verificar si necesita compactación antes de llamar a la API
  await ensureContextCompaction(transport, remoteJid);

  const messages = cm.getMessages(remoteJid);

  // Inyectar contexto dinámico (hora + memoria) en el último user message,
  // usando shallow clone para no contaminar el contexto persistido
  const dynamicCtx = `${cm.buildDynamicContext(remoteJid)}

${taskRuntime.buildContextSummary(remoteJid)}`;
  const apiMessages = messages.map((m) => ({ ...m }));
  const lastMsg = apiMessages[apiMessages.length - 1];
  if (lastMsg && lastMsg.role === "user") {
    lastMsg.content = `${dynamicCtx}\n\n---\n\n${lastMsg.content}`;
  }

  // Mantener una actividad genérica durante toda la operación real; cada transporte decide cómo representarla.
  const activitySession = await startActivity(transport, remoteJid);
  const runController = new AbortController();
  activeAiRuns.set(remoteJid, runController);

  try {
    // Ejecutar chat con function calling. Las acciones mutables se registran
    // como eventos confirmados del sistema, nunca como afirmaciones del asistente.
    const confirmedTools = new Set<string>();
    const toolResults: Array<{ name: string; result: string }> = [];
    const shownNotifs = new Set<string>();
    const spawnDeduper = createSpawnAgentRequestDeduper();
    let clearConversationAfterResponse = false;

    const recordToolResult = async (name: string, result: string): Promise<void> => {
      toolResults.push({ name, result });
      if (
        (name === "list_reminders" || name === "list_alarms") &&
        !result.startsWith("Error:")
      ) {
        confirmedTools.add(name);
      }
      if (!isConfirmedToolSuccess(name, result)) return;

      confirmedTools.add(name);
      cm.addMessage(remoteJid, {
        role: "user",
        content: buildConfirmedToolEvent(name, result),
      });

      if (isConfirmedScheduledCreation(name, result)) {
        await sendText(transport, remoteJid, buildVisibleSystemConfirmation(result), { waitForDelivery: false });
        await activitySession.refresh();
      }
    };

    const toolExecutor = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<string> => {
      if (runController.signal.aborted) {
        throw runController.signal.reason ?? new Error("user-cancelled-current-operation");
      }
      if (TOOL_NOTIFICATION_TEXTS.has(name) && !shownNotifs.has(name)) {
        shownNotifs.add(name);
        const notification = TOOL_NOTIFICATION_TEXTS.get(name) ?? "";
        await sendText(transport, remoteJid, notification , { waitForDelivery: false });
        await activitySession.refresh();
      }

      if (
        (name === "create_reminder" || name === "create_alarm") &&
        userExplicitlyBlocksScheduledCreation(userText, name)
      ) {
        const blocked =
          "Error: el mensaje actual contiene una negación explícita. No se creó ninguna alarma ni recordatorio.";
        toolResults.push({ name, result: blocked });
        return blocked;
      }

      let result: string;

      if (name === "memory_write" || name === "memory_read") {
        result = await executeMemoryTool(name, args, memoryManager, remoteJid);
        await recordToolResult(name, result);
        return result;
      }

      if (["create_reminder", "delete_reminder", "list_reminders"].includes(name)) {
        result = await executeReminderTool(name, args, reminderManager, remoteJid);
        await recordToolResult(name, result);
        return result;
      }

      if (["create_alarm", "delete_alarm", "list_alarms", "toggle_alarm"].includes(name)) {
        result = await executeAlarmTool(name, args, alarmManager, remoteJid);
        await recordToolResult(name, result);
        return result;
      }

      if (USER_CONTROL_TOOLS.some((tool) => tool.function.name === name)) {
        if (name === "conversation_clear" && !userExplicitlyRequestsConversationClear(userText)) {
          result = "Error: conversation_clear requiere que el usuario pida explícitamente limpiar, borrar o reiniciar su conversación.";
          toolResults.push({ name, result });
          return result;
        }
        if (name === "account_password_change_start" && !userExplicitlyRequestsOwnPasswordChange(userText)) {
          result = "Error: account_password_change_start solo puede usarse cuando el usuario pide explícitamente cambiar la contraseña de su propia cuenta de Luna. Las credenciales de sitios web pertenecen al agente de navegador.";
          toolResults.push({ name, result });
          return result;
        }
        if (name === "conversation_clear") clearConversationAfterResponse = true;
        result = await executeUserControlTool(name, args, remoteJid);
        await recordToolResult(name, result);
        return result;
      }

      if (ADMIN_CONTROL_TOOLS.some((tool) => tool.function.name === name)) {
        result = await executeAdminControlTool(name, args, remoteJid);
        await recordToolResult(name, result);
        return result;
      }

      if (WORKSPACE_TOOLS.some((tool) => tool.function.name === name)) {
        if (name === "workspace_clear") {
          const hasActiveTask = taskRuntime.list(remoteJid).some(
            (task) => task.status === "queued" || task.status === "running" || task.status === "synthesizing",
          );
          if (hasActiveTask) {
            result = "Error: no se puede limpiar el workdir mientras hay una tarea de subagentes activa. Cancélala o espera a que termine.";
            await recordToolResult(name, result);
            return result;
          }
        }
        result = await executeWorkspaceTool(name, args, workspaceManager, remoteJid);
        await recordToolResult(name, result);
        return result;
      }

      if (ARTIFACT_TOOLS.some((tool) => tool.function.name === name)) {
        result = await executeArtifactTool(name, args, workspaceManager, remoteJid);
        await recordToolResult(name, result);
        return result;
      }

      if (name === "spawn_agents") {
        result = await executeSpawnAgentsTool(args, {
          jid: remoteJid,
          model,
          llmConfig: cfg,
          agentConfig: agentConfigSnapshot,
          workspace: workspaceManager,
          tasks: taskRuntime,
          browserCredentials: browserCredentialStore,
          resumePrompt: userText,
          onSystemMessage: async (text) => {
            await sendText(transport, remoteJid, text, { waitForDelivery: false });
            await activitySession.refresh();
          },
          onSystemArtifact: async (path, caption) => {
            await sendWorkspacePath(transport, remoteJid, workspaceManager, path, caption);
          },
          onBackgroundCompleted: async (taskId) => {
            await reviewBackgroundTask(transport, remoteJid, taskId);
          },
          filterRequests: spawnDeduper.filter,
          onProgress: async (event) => {
            const progressMessages = formatSpawnAgentsProgress(event);
            for (const progressText of progressMessages) {
              await sendText(transport, remoteJid, progressText , { minDelayMs: 800, maxDelayMs: 1_800, waitForDelivery: false });
            }
            if (progressMessages.length > 0) await activitySession.refresh();
          },
        });
        toolResults.push({ name, result });
        return result;
      }

      if (name === "researcher_web") {
        result = await executeResearcherWebTool(args, {
          jid: remoteJid,
          model,
          llmConfig: cfg,
          agentConfig: agentConfigSnapshot,
          workspace: workspaceManager,
          tasks: taskRuntime,
          browserCredentials: browserCredentialStore,
          resumePrompt: userText,
          onSystemMessage: async (text) => {
            await sendText(transport, remoteJid, text, { waitForDelivery: false });
            await activitySession.refresh();
          },
          onSystemArtifact: async (path, caption) => {
            await sendWorkspacePath(transport, remoteJid, workspaceManager, path, caption);
          },
          onBackgroundCompleted: async (taskId) => {
            await reviewBackgroundTask(transport, remoteJid, taskId);
          },
          filterRequests: spawnDeduper.filter,
          onProgress: async (event) => {
            const progressMessages = formatSpawnAgentsProgress(event);
            for (const progressText of progressMessages) {
              await sendText(transport, remoteJid, progressText , { minDelayMs: 800, maxDelayMs: 1_800, waitForDelivery: false });
            }
            if (progressMessages.length > 0) await activitySession.refresh();
          },
        });
        toolResults.push({ name, result });
        return result;
      }

      if (["browser_credentials_list", "browser_credentials_save", "browser_credentials_delete"].includes(name)) {
        result = executeBrowserCredentialControlTool(name, args, {
          jid: remoteJid,
          browserCredentials: browserCredentialStore,
        });
        toolResults.push({ name, result });
        return result;
      }

      if (name === "browser_request_credential") {
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const username = typeof args.username === "string" ? args.username.trim() : "";
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!url || !username || !prompt) {
          result = "Error: url, username y prompt son obligatorios para solicitar la credencial segura.";
          toolResults.push({ name, result });
          return result;
        }
        browserCredentialStore.setPendingInput({ jid: remoteJid, kind: "password", fieldName: "contraseña", originalText: userText || prompt, url, username });
        await sendText(transport, remoteJid, [
          "🔐 MENSAJE DEL SISTEMA",
          "",
          `Se necesita la contraseña para ${url} (usuario: ${username}).`,
          "Por seguridad, el agente no debe saber tu contraseña ni recibirla en su contexto.",
          "Envía la contraseña en tu siguiente mensaje. El sistema la capturará fuera del modelo, intentará borrar ese mensaje y después reanudará la tarea con una referencia segura.",
        ].join("\n"), { waitForDelivery: false });
        result = "El sistema quedó esperando la contraseña fuera del LLM. No vuelvas a pedirla ni la menciones; espera el siguiente mensaje del usuario.";
        toolResults.push({ name, result });
        return result;
      }

      if (name === "browser_agent") {
        result = await executeBrowserWebTool(args, {
          jid: remoteJid,
          model,
          llmConfig: cfg,
          agentConfig: agentConfigSnapshot,
          workspace: workspaceManager,
          tasks: taskRuntime,
          browserCredentials: browserCredentialStore,
          resumePrompt: userText,
          onSystemMessage: async (text) => {
            await sendText(transport, remoteJid, text, { waitForDelivery: false });
            await activitySession.refresh();
          },
          onSystemArtifact: async (path, caption) => {
            await sendWorkspacePath(transport, remoteJid, workspaceManager, path, caption);
          },
          onBackgroundCompleted: async (taskId) => {
            await reviewBackgroundTask(transport, remoteJid, taskId);
          },
          filterRequests: spawnDeduper.filter,
          onProgress: async (event) => {
            const progressMessages = formatSpawnAgentsProgress(event);
            for (const progressText of progressMessages) {
              await sendText(transport, remoteJid, progressText , { minDelayMs: 800, maxDelayMs: 1_800, waitForDelivery: false });
            }
            if (progressMessages.length > 0) await activitySession.refresh();
          },
        });
        toolResults.push({ name, result });
        return result;
      }

      if (["task_list", "task_status", "task_inspect", "task_review", "task_cancel", "task_cancel_all", "agent_list", "agent_status", "agent_review", "agent_cancel"].includes(name)) {
        result = executeAgentTaskTool(name, args, { jid: remoteJid, tasks: taskRuntime, workspace: workspaceManager });
        toolResults.push({ name, result });
        return result;
      }

      if (MESSAGING_TOOLS.some((tool) => tool.function.name === name)) {
        result = await executeMessagingTool(args, {
          transport,
          conversationId: remoteJid,
          workspace: workspaceManager,
        });
        await recordToolResult(name, result);
        return result;
      }

      if (ADMIN_TOOLS.some((tool) => tool.function.name === name)) {
        if (!isAdminSession(remoteJid)) {
          result = "Error: esta herramienta requiere una sesión administradora activa.";
        } else if (name.startsWith("admin_")) {
          result = await executeUserAdminTool(
            name,
            args,
            authManager,
            remoteJid,
          );
        } else {
          let lastProgress = -25;
          result = await executeWhisperAdminTool(name, args, async (progress) => {
            if (progress.percent < 100 && progress.percent < lastProgress + 25) return;
            lastProgress = progress.percent;
            await sendText(transport, remoteJid, `⬇️ Descargando ${progress.model.id}: ${progress.percent}%`, { waitForDelivery: false });
            await activitySession.refresh();
          });
        }
        await recordToolResult(name, result);
        return result;
      }

      result = `Error: funcion desconocida "${name}"`;
      toolResults.push({ name, result });
      return result;
    };

    const result = await chatCompletionWithTools(
      apiMessages,
      model,
      cfg,
      activeTools,
      toolExecutor,
      5,
      undefined,
      {
        maxRounds: 64,
        maxTokens: 4096,
        truncationRecoveryAttempts: 1,
        signal: runController.signal,
        onToolRoundComplete: async () => {
          // Igual que Codewolf: la deduplicación semántica solo aplica a las
          // solicitudes repetidas dentro de una misma respuesta del modelo.
          spawnDeduper.reset();
        },
      },
    );

    if (runController.signal.aborted) {
      throw runController.signal.reason ?? new Error("user-cancelled-current-operation");
    }

    const latestUsefulToolResult = [...toolResults]
      .reverse()
      .find((entry) => !entry.result.startsWith("Error:"))?.result;
    const rawFinalContent = result.content.trim() || latestUsefulToolResult ||
      "No pude generar una respuesta útil en esta ronda.";
    const guardedContent = guardUnconfirmedScheduledCreationClaim(
      rawFinalContent,
      confirmedTools,
    );
    const finalContent = stripUnrelatedPendingNameQuestion(
      guardedContent,
      userText,
      result.toolsCalled,
    );

    const assistantMessage: import("./ai.ts").ChatMessage = {
      role: "assistant",
      content: finalContent,
    };
    cm.addMessage(remoteJid, assistantMessage);

    // La memoria ya está actualizada en disco vía el tool call.
    // El contexto dinámico con la memoria fresca se inyectará en el
    // próximo user message via buildDynamicContext().
    // En esta misma ronda el modelo ya ve el resultado del tool call.

    // Todo mensaje saliente pasa por la cola resiliente y simula escritura.
    // Si el transporte se desconectó durante la tarea, queda pendiente y se envía
    // automáticamente al reconectar sin abortar el flujo del agente.
    await sendTextHumanized(transport, remoteJid, finalContent, 1_500, 3_000);
    if (clearConversationAfterResponse) {
      // La confirmación se entrega por el chat activo, pero el historial queda realmente
      // limpio igual que con !clear; memoria, modelo y workdir se conservan.
      cm.clearConversation(remoteJid);
    }
  } catch (err: unknown) {
    if (runController.signal.aborted) {
      // La confirmación de !cancelar ya fue enviada por el manejador del comando.
      // Cerramos la solicitud original dentro del historial para que un mensaje
      // posterior no haga que el modelo retome la misión cancelada.
      cm.addMessage(remoteJid, {
        role: "assistant",
        content: "[Operación cancelada explícitamente por el usuario. No reanudar, reintentar ni lanzar tareas de seguimiento para esta solicitud salvo que el usuario la pida nuevamente.]",
      });
      return;
    }

    const errorMsg =
      err instanceof Error ? err.message : "Error desconocido";
    if (err instanceof LlmRetriesExhaustedError) {
      console.error(`[ai] Proveedor LLM no disponible después de ${err.attempts} intento(s): ${err.lastError.message}`);
    } else {
      console.error("[ai] Error en chat:", err);
    }

    // Detectar error de desbordamiento de contexto y compactar de emergencia
    const isOverflow = /context_length_exceeded|maximum context length|prompt is too long|too many tokens|context.*exceed|request.*too large/i.test(errorMsg);
    if (isOverflow) {
      console.warn("[compact] Desbordamiento de contexto detectado, compactación de emergencia...");
      try {
        const msgs = cm.getMessages(remoteJid);
        const emergencySplit = selectMessagesForCompaction({
          messages: msgs,
          preserveRecentTurns: 6,
          targetTokens: 0, // fuerza el máximo de compactación
        });

        if (emergencySplit.messagesToCompact.length > 0) {
          // Compactación simple (sin LLM) para emergencia
          const systemMsg = msgs[0];
          const kept = emergencySplit.messagesToKeep;
          if (systemMsg && systemMsg.role === "system") {
            const summaryText = `[Compactación de emergencia: ${emergencySplit.messagesToCompact.length} mensajes antiguos resumidos automáticamente]`;
            const emergencyMessages = [
              systemMsg,
              { role: "user" as const, content: summaryText },
              ...kept.slice(1), // sin el system duplicado
            ];
            cm.applyCompaction(
              remoteJid,
              emergencyMessages,
              {
                durableFacts: [],
                preferences: [],
                currentTopics: ["Conversación compactada por emergencia"],
                verifiedToolActions: [],
                unverifiedClaims: [],
                pendingTasks: [],
                decisions: [],
                importantConstraints: [],
                recentState: "Conversación interrumpida por desbordamiento de contexto. Se compactó de emergencia.",
                unresolvedQuestions: [],
              },
              estimateTokensAccurate(msgs),
              estimateTokensAccurate(emergencyMessages),
              emergencySplit.messagesToCompact.length,
            );
            console.log("[compact] Compactación de emergencia aplicada");
          }
        }
      } catch (emergencyErr) {
        console.error("[compact] Error en compactación de emergencia:", emergencyErr);
      }
    }

    await sendTextHumanized(
      transport,
      remoteJid,
      isOverflow
        ? "⚠️ La conversación alcanzó su límite y fue compactada. Envía tu mensaje nuevamente."
        : err instanceof LlmRetriesExhaustedError
          ? `⚠️ El proveedor LLM no respondió correctamente después de ${err.attempts} intentos. Aborté esta ejecución para evitar un bucle; puedes reintentar la solicitud.`
          : "❌ No pude procesar tu mensaje en este momento. Intenta de nuevo.",
    );
  } finally {
    if (activeAiRuns.get(remoteJid) === runController) activeAiRuns.delete(remoteJid);
    await activitySession.stop();
  }

  }); // fin de withLock
}

// ─── Media ───────────────────────────────────────────────────────

async function handleMediaMessage(
  transport: MessagingTransport,
  message: TransportIncomingMessage,
  remoteJid: string,
  mediaKind: "image" | "audio",
): Promise<void> {
  if (!llmConfig || !contextManager) {
    await sendTextHumanized(
      transport,
      remoteJid,
      "⚠️ El chat LLM todavía está iniciando. Intenta nuevamente en unos segundos.",
    );
    return;
  }

  const activitySession = await startActivity(transport, remoteJid);

  try {
    if (mediaKind === "audio") {
      await sendText(transport, remoteJid, "🎙️ Transcribiendo audio..." , { waitForDelivery: false });
      const media = await downloadAudioForTranscription(
        message,
        loadWhisperConfig().maxAudioSeconds,
      );
      const result = await mediaProcessor.process(
        "transcribe-audio",
        media.bytes,
        media.mimeType,
      );
      if (!result.text.trim()) {
        await sendText(transport, remoteJid, "⚠️ No pude identificar voz o texto en el audio." , { waitForDelivery: false });
        return;
      }

      await activitySession.stop();
      await handleAiChat(transport, remoteJid, buildAudioContextText(result.text));
      return;
    }

    await sendText(transport, remoteJid, "🖼️ Extrayendo texto de la imagen..." , { waitForDelivery: false });
    const media = await downloadImageForOcr(message);
    const result = await mediaProcessor.process(
      "ocr-image",
      media.bytes,
      media.mimeType,
    );
    const caption = getMediaCaption(message);
    if (!result.text.trim()) {
      await sendText(transport, remoteJid, "⚠️ No encontré texto legible en la imagen. No enviaré una respuesta al asistente sin el resultado del OCR.", { waitForDelivery: false });
      return;
    }

    await activitySession.stop();
    await handleAiChat(
      transport,
      remoteJid,
      buildImageContextText(result.text, caption),
    );
  } catch (error) {
    console.error(`[media] Error procesando ${mediaKind}:`, error);
    await sendText(transport, remoteJid, `❌ ${error instanceof Error ? error.message : "No se pudo procesar el archivo."}`, { waitForDelivery: false });
  } finally {
    await activitySession.stop();
  }
}
