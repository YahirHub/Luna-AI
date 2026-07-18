import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
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
  fetchModels,
  chatCompletion,
  chatCompletionWithTools,
  LlmRetriesExhaustedError,
} from "./ai.ts";
import {
  ProviderSetupManager,
  deleteLlmConfig,
  saveLlmConfig,
} from "./llm-config.ts";
import type {
  LlmConfig,
  ProviderSetupStep,
} from "./llm-config.ts";
import { ContextManager } from "./context.ts";
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
import { sendWithTyping, startContinuousTyping, sendWhatsAppMessage, setMessagingSocket } from "./messaging.ts";
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
  WHATSAPP_TOOLS,
  executeWhatsAppTool,
} from "./tools/whatsapp-tools.ts";
import {
  executeAgentTaskTool,
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

// ─── Estado global ───────────────────────────────────────────────

type LlmProviderMode = "opencode-free" | "custom";

let llmConfig: LlmConfig | null = null;
let llmProviderMode: LlmProviderMode = "opencode-free";
let llmConfigPath = "";
let contextManager: ContextManager | null = null;
let schedulersStarted = false;

/** Modelos disponibles actualmente; siempre incluye el predeterminado. */
let availableModels: string[] = [];

/** Flujo temporal para configurar el proveedor desde WhatsApp. */
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

// Variable para guardar el socket actual (para alarmas)
let currentSock: WASocket | null = null;

/** JIDs actualmente en proceso de compactación (para ignorar mensajes entrantes). */
const compactingJids = new Set<string>();

/** Tools base y herramientas opcionales según /config. */
const BASE_TOOLS = [
  ...MEMORY_TOOLS,
  ...REMINDER_TOOLS,
  ...ALARM_TOOLS,
  ...WORKSPACE_TOOLS,
  ...ARTIFACT_TOOLS,
  ...WHATSAPP_TOOLS,
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
  ["create_pdf_from_markdown", "📄 Generando PDF..."],
  ["archive_folder", "🗜️ Comprimiendo carpeta..."],
  ["gitzip", "🗜️ Empaquetando código fuente con reglas .gitignore..."],
  ["whatsapp_send", "📤 Preparando envío por WhatsApp..."],
  ["workspace_clear", "🧹 Limpiando tu workdir..."],
  ["model_list", "📋 Actualizando modelos disponibles..."],
  ["model_set", "🧠 Cambiando modelo de la conversación..."],
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
async function ensureContextCompaction(sock: WASocket, jid: string): Promise<void> {
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
    void sendWhatsAppMessage(sock, jid, { text: "🧹 Espera un momento, estoy limpiando mi memoria..." }, { waitForDelivery: false });

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

  const activeConfig = config ?? createOpenCodeFreeConfig();
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
 * Actualiza la referencia al socket activo.
 * Se llama desde connection.ts cuando el socket se conecta/reconecta.
 */
export function setSocket(sock: WASocket | null): void {
  reminderManager.setSock(sock);
  currentSock = sock;
  setMessagingSocket(sock);
}

/** Callback cuando una alarma recurrente debe dispararse. */
async function onAlarmDue(
  alarm: import("./alarm.ts").RecurringAlarm,
): Promise<void> {
  if (!currentSock) {
    throw new Error("Socket no disponible para entregar la alarma.");
  }

  const dayName = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
  }).format(new Date());

  const deliveredText = await deliverScheduledMessage({
    sock: currentSock,
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
  // no debe provocar que WhatsApp reciba la misma alarma nuevamente.
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
  sock: WASocket | null,
): Promise<void> {
  if (!sock) {
    throw new Error("Socket no disponible para entregar el recordatorio.");
  }

  const deliveredText = await deliverScheduledMessage({
    sock,
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

function compactProgressText(value: string, maxLength = 120): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= maxLength
    ? clean
    : `${clean.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function formatSpawnAgentsProgress(event: SpawnAgentsProgress): string | null {
  switch (event.type) {
    case "task_started":
      return `🤖 Inicié ${event.total} subagente${event.total === 1 ? "" : "s"}.\nTarea: ${event.taskId}`;
    case "agent_started":
      return `🔎 Subagente ${event.index + 1}/${event.total} (${event.agentType}):\n${compactProgressText(event.prompt, 220)}`;
    case "agent_completed": {
      const icon = event.status === "completed" ? "✅" : event.status === "cancelled" ? "⛔" : "❌";
      const label = event.status === "completed" ? "terminado" : event.status === "cancelled" ? "cancelado" : "falló";
      return `${icon} Subagente ${event.index + 1}/${event.total} (${event.agentType}): ${label}.`;
    }
    case "task_completed":
      if (event.status === "failed") return `❌ Tarea de subagentes ${event.taskId} fallida.`;
      return `✅ Tarea de subagentes ${event.taskId} ${event.status === "partial" ? "completada parcialmente" : "completada"}.`;
  }
}

function providerSetupPrompt(step: ProviderSetupStep): string {
  switch (step) {
    case "chatCompletionsUrl":
      return [
        "1/4 — URL DE CHAT COMPLETIONS",
        "",
        "Envía el endpoint completo usado para generar respuestas.",
        "Ejemplo: https://api.example.com/v1/chat/completions",
      ].join("\n");
    case "modelsUrl":
      return [
        "2/4 — URL DEL CATÁLOGO DE MODELOS",
        "",
        "Envía el endpoint completo que devuelve { data: [{ id }] }.",
        "Si falla, Luna usará el modelo predeterminado.",
      ].join("\n");
    case "defaultModel":
      return [
        "3/4 — MODELO PREDETERMINADO",
        "",
        "Envía el identificador exacto que usarán los chats nuevos.",
        "También será el fallback si el catálogo no responde.",
      ].join("\n");
    case "apiKey":
      return [
        "4/4 — API KEY",
        "",
        "Envía la clave del proveedor.",
        "Si no requiere clave, responde: sin-clave",
        "",
        "Por seguridad intentaré eliminar este mensaje después de leerlo.",
      ].join("\n");
  }
}

async function deleteSensitiveIncomingMessage(
  sock: WASocket,
  message: WAMessage,
): Promise<void> {
  try {
    await sock.sendMessage(message.key.remoteJid!, { delete: message.key });
  } catch {
    // WhatsApp puede impedir borrar mensajes ajenos según el tipo de chat.
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
  if (taskRuntime.cancel(jid)) return "✅ Tarea activa de subagentes cancelada.";
  if (providerSetupManager.has(jid)) {
    providerSetupManager.cancel(jid);
    return "✅ Configuración del proveedor cancelada.";
  }
  if (searchSetupManager.has(jid)) {
    searchSetupManager.cancel(jid);
    return "✅ Configuración de búsqueda cancelada.";
  }
  if (agentConfigFlowManager.has(jid)) {
    agentConfigFlowManager.cancel(jid);
    return "✅ Configuración del agente cancelada.";
  }
  if (whisperSetupManager.has(jid)) {
    whisperSetupManager.cancel(jid);
    return "✅ Configuración de Whisper cancelada.";
  }
  if (contextManager?.isAwaitingModelSelection(jid)) {
    contextManager.clearAwaitingModelSelection(jid);
    return "✅ Selección de modelo cancelada.";
  }
  return "No hay una operación interactiva o tarea activa que cancelar.";
}

async function formatModelsForUser(jid: string): Promise<string> {
  if (!llmConfig || !contextManager) return "Error: el proveedor LLM todavía está iniciando.";
  const usedFallback = await refreshAvailableModels();
  const current = contextManager.getModel(jid) || "ninguno";
  const rows = availableModels.map((model, index) => `${index + 1}. ${model}`);
  return [
    "📋 MODELOS DISPONIBLES",
    "",
    ...rows,
    "",
    `Modelo actual: ${current}`,
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
      return `🆔 Tu JID: ${jid}`;
    case "control_cancel":
      return cancelCurrentOperation(jid);
    case "conversation_clear":
      contextManager?.clearConversation(jid);
      return "✅ Conversación reiniciada. La memoria persistente y el workdir se conservaron.";
    case "model_status":
      return `Modelo actual: ${contextManager?.getModel(jid) ?? "ninguno"}`;
    case "model_list":
      return await formatModelsForUser(jid);
    case "model_set": {
      if (!contextManager) return "Error: el gestor de contexto no está disponible.";
      const requested = typeof args.model_id === "string" ? args.model_id.trim() : "";
      if (!requested) return "Error: model_id es obligatorio.";
      await refreshAvailableModels();
      const exact = availableModels.find((model) => model.toLowerCase() === requested.toLowerCase());
      if (!exact) {
        const partial = availableModels.filter((model) => model.toLowerCase().includes(requested.toLowerCase()));
        if (partial.length === 1) {
          contextManager.setModel(jid, partial[0]!);
          return `✅ Modelo seleccionado: ${partial[0]}`;
        }
        return `Error: el modelo '${requested}' no está disponible. Usa model_list para consultar los modelos actuales.`;
      }
      contextManager.setModel(jid, exact);
      return `✅ Modelo seleccionado: ${exact}`;
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
        `Chat completions: ${llmConfig?.chatCompletionsUrl ?? "no disponible"}`,
        `Modelos: ${llmConfig?.modelsUrl ?? "no disponible"}`,
        `Modelo predeterminado: ${llmConfig?.defaultModel ?? "no disponible"}`,
        `API key configurada: ${llmConfig?.apiKey ? "sí" : "no"}`,
      ].join("\n");

    case "llm_provider_use_opencode_free":
      if (args.confirmed !== true) return "Error: restaurar OpenCode Free requiere una petición explícita y confirmed=true.";
      deleteLlmConfig(llmConfigPath);
      providerSetupManager.cancel(jid);
      initLlm(null, llmConfigPath);
      return `✅ ${OPENCODE_FREE_PROVIDER_NAME} activado como proveedor global.`;

    case "llm_provider_start_setup":
      providerSetupManager.start(jid, llmProviderMode === "custom" ? llmConfig : null);
      return [
        "✅ Flujo seguro de configuración LLM iniciado.",
        providerSetupPrompt("chatCompletionsUrl"),
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
  "Muestra tu identificador (JID)",
  (_cmd, senderJid) => ({
    text: `🆔 Tu JID: ${senderJid}`,
  }),
);

registerCommand(
  "cancelar",
  "Cancela la operación actual (selección de modelo, etc.)",
  (_cmd, senderJid) => {
    if (taskRuntime.cancel(senderJid)) {
      return { text: "❌ Tarea activa de subagentes cancelada." };
    }
    if (providerSetupManager.has(senderJid)) {
      providerSetupManager.cancel(senderJid);
      return { text: "❌ Configuración del proveedor cancelada." };
    }
    if (searchSetupManager.has(senderJid)) {
      searchSetupManager.cancel(senderJid);
      return { text: "❌ Configuración de búsqueda cancelada." };
    }
    if (agentConfigFlowManager.has(senderJid)) {
      agentConfigFlowManager.cancel(senderJid);
      return { text: "❌ Configuración del agente cancelada." };
    }
    if (whisperSetupManager.has(senderJid)) {
      whisperSetupManager.cancel(senderJid);
      return { text: "❌ Configuración de Whisper cancelada." };
    }
    if (contextManager?.isAwaitingModelSelection(senderJid)) {
      contextManager.clearAwaitingModelSelection(senderJid);
      return { text: "❌ Selección de modelo cancelada." };
    }
    return { text: "❌ Operación cancelada." };
  },
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
    const currentModel = contextManager?.getModel(senderJid) || "ninguno";
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
            `Se muestra el modelo predeterminado: ${llmConfig.defaultModel}`,
          ]
      : [];

    return {
      text: [
        "📋 MODELOS DISPONIBLES",
        "",
        list,
        "",
        `📌 Actual: ${currentModel}`,
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
      deleteLlmConfig(llmConfigPath);
      providerSetupManager.cancel(senderJid);
      initLlm(null, llmConfigPath);
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
          ? "La configuración personalizada actual se reemplazará al completar los 4 pasos."
          : `${OPENCODE_FREE_PROVIDER_NAME} seguirá activo hasta completar los 4 pasos.`,
        "Este comando es opcional: Luna funciona con modelos gratuitos sin configurarlo.",
        "Puedes cancelar en cualquier momento con /cancelar.",
        "",
        providerSetupPrompt("chatCompletionsUrl"),
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
      return { text: "❌ Error: no se pudo identificar tu JID." };
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
      return { text: "❌ Error: no se pudo identificar tu JID." };
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
      return { text: "❌ Error: no se pudo identificar tu JID." };
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
      return { text: "❌ Error: no se pudo identificar tu JID." };
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
      return { text: "❌ Error: no se pudo identificar tu JID." };
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
      return { text: "❌ Error: no se pudo identificar tu JID." };
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
  sock: WASocket,
  message: WAMessage,
  jid: string,
  text: string,
): Promise<void> {
  const action = authManager.getPendingAction(jid);
  if (!action) return;

  if (action.step === "awaiting-password") {
    await deleteSensitiveIncomingMessage(sock, message);
  }

  try {
    switch (action.type) {
      case "setup":
        await handleSetupStep(sock, jid, text, action);
        break;
      case "login":
        await handleLoginStep(sock, jid, text, action);
        break;
      case "adduser":
        await handleAdduserStep(sock, jid, text, action);
        break;
    }
  } catch (err) {
    console.error(`[auth] Error en flujo ${action.type}:`, err);
    await sendWithTyping(
      sock,
      jid,
      "❌ No se pudo guardar el cambio. Revisa permisos y espacio en disco e inténtalo de nuevo.",
    );
  }
}

async function handleSetupStep(
  sock: WASocket,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  if (action.step === "awaiting-username") {
    const username = text.trim().toLowerCase();
    if (!username || username.length < 2 || !/^[a-z0-9_]+$/.test(username)) {
      await sendWithTyping(
        sock,
        jid,
        "❌ Nombre de usuario inválido. Usa solo letras, números y guion bajo (mín 2 caracteres).\n\nIntenta de nuevo:",
      );
      return;
    }
    if (authManager.findUser(username)) {
      await sendWithTyping(
        sock,
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
    await sendWithTyping(sock, jid, `Ingresa la contraseña para ${username}:`);
    return;
  }

  // step === "awaiting-password"
  const password = text.trim();
  if (!password || password.length < 4) {
    await sendWithTyping(
      sock,
      jid,
      "❌ La contraseña debe tener al menos 4 caracteres.\n\nIntenta de nuevo:",
    );
    return;
  }
  const setupUsername = action.username;
  if (!setupUsername) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(sock, jid, "❌ Error interno. Intenta de nuevo con !setup.");
    return;
  }
  await authManager.createAdmin(setupUsername, password);
  await authManager.login(jid, setupUsername, password);
  authManager.clearPendingAction(jid);
  await sendWithTyping(
    sock,
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
  sock: WASocket,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  if (action.step === "awaiting-username") {
    const username = text.trim().toLowerCase();
    const user = authManager.findUser(username);
    if (!user) {
      await sendWithTyping(
        sock,
        jid,
        "❌ Usuario no encontrado. Intenta de nuevo:",
      );
      return;
    }
    if (user.banned) {
      authManager.clearPendingAction(jid);
      await sendWithTyping(
        sock,
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
    await sendWithTyping(sock, jid, "Ingresa tu contraseña:");
    return;
  }

  // step === "awaiting-password"
  const password = text.trim();
  const loginUsername = action.username;
  if (!loginUsername) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(sock, jid, "❌ Error interno. Intenta de nuevo con !login.");
    return;
  }
  // Verificar si fue baneado entre el paso de usuario y contraseña
  const userCheck = authManager.findUser(loginUsername);
  if (userCheck?.banned) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(
      sock,
      jid,
      "🚫 Tu cuenta ha sido baneada durante el inicio de sesión. Contacta al administrador.",
    );
    return;
  }
  const success = await authManager.login(jid, loginUsername, password);
  if (success) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(
      sock,
      jid,
      `✅ Inicio de sesión exitoso. Bienvenido, ${loginUsername}.`,
    );
  } else {
    await sendWithTyping(
      sock,
      jid,
      "❌ Contraseña incorrecta. Intenta de nuevo:",
    );
  }
}

async function handleAdduserStep(
  sock: WASocket,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  if (action.step === "awaiting-username") {
    const username = text.trim().toLowerCase();
    if (!username || username.length < 2 || !/^[a-z0-9_]+$/.test(username)) {
      await sendWithTyping(
        sock,
        jid,
        "❌ Nombre de usuario inválido. Usa solo letras, números y guion bajo (mín 2 caracteres).\n\nIntenta de nuevo:",
      );
      return;
    }
    if (authManager.findUser(username)) {
      await sendWithTyping(
        sock,
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
    await sendWithTyping(sock, jid, `Ingresa la contraseña para ${username}:`);
    return;
  }

  // step === "awaiting-password"
  const password = text.trim();
  if (!password || password.length < 4) {
    await sendWithTyping(
      sock,
      jid,
      "❌ La contraseña debe tener al menos 4 caracteres.\n\nIntenta de nuevo:",
    );
    return;
  }
  const addUsername = action.username;
  if (!addUsername) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(sock, jid, "❌ Error interno. Intenta de nuevo con !adduser.");
    return;
  }
  await authManager.addUser(addUsername, password, "user");
  authManager.clearPendingAction(jid);
  await sendWithTyping(
    sock,
    jid,
    `✅ Usuario ${addUsername} creado exitosamente.`,
  );
}

async function handlePendingProviderSetup(
  sock: WASocket,
  message: WAMessage,
  jid: string,
  text: string,
): Promise<void> {
  const currentStep = providerSetupManager.getStep(jid);
  if (!currentStep) return;

  try {
    const result = providerSetupManager.submit(jid, text);
    if (!result.completed) {
      await sendWithTyping(sock, jid, providerSetupPrompt(result.nextStep));
      return;
    }

    if (result.secretInput) {
      await deleteSensitiveIncomingMessage(sock, message);
    }

    const savedConfig = saveLlmConfig(result.config, llmConfigPath);
    initLlm(savedConfig, llmConfigPath);
    providerSetupManager.cancel(jid);

    await sendWithTyping(
      sock,
      jid,
      [
        "✅ PROVEEDOR CONFIGURADO",
        "",
        `Modelo predeterminado: ${savedConfig.defaultModel}`,
        "El catálogo se actualizará sin bloquear el bot.",
        "Si el endpoint falla, Luna mantendrá el modelo predeterminado como fallback.",
        "La configuración personalizada tiene prioridad sobre OpenCode Free.",
        "",
        "Los chats nuevos usarán este modelo. Los chats existentes conservan su selección.",
        "Puedes cambiar de modelo con !modelos.",
      ].join("\n"),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const step = providerSetupManager.getStep(jid) ?? currentStep;
    console.warn(`[provider-setup] Entrada inválida en ${step}: ${reason}`);
    await sendWithTyping(
      sock,
      jid,
      [
        `❌ ${reason}`,
        "",
        providerSetupPrompt(step),
      ].join("\n"),
    );
  }
}

async function handlePendingAgentConfig(
  sock: WASocket,
  jid: string,
  text: string,
): Promise<void> {
  try {
    const result = agentConfigFlowManager.submit(jid, text, agentConfig);
    agentConfig = result.config;
    await sendWithTyping(sock, jid, result.text);
  } catch (error) {
    await sendWithTyping(
      sock,
      jid,
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handlePendingSearchSetup(
  sock: WASocket,
  message: WAMessage,
  jid: string,
  text: string,
): Promise<void> {
  try {
    const result = await searchSetupManager.submit(jid, text);
    if (result.secretInput) {
      await deleteSensitiveIncomingMessage(sock, message);
    }
    await sendWithTyping(sock, jid, result.text);
  } catch (error) {
    await sendWithTyping(
      sock,
      jid,
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handlePendingWhisperSetup(
  sock: WASocket,
  jid: string,
  text: string,
): Promise<void> {
  let lastProgress = -25;
  const typing = await startContinuousTyping(sock, jid);
  try {
    const result = await whisperSetupManager.submit(jid, text, async (progress) => {
      if (progress.percent < 100 && progress.percent < lastProgress + 25) return;
      lastProgress = progress.percent;
      await sendWhatsAppMessage(sock, jid, {
        text: `⬇️ Descargando ${progress.model.id}: ${progress.percent}%`,
      }, { waitForDelivery: false });
    });
    await sendWithTyping(sock, jid, result.text);
  } catch (error) {
    await sendWithTyping(
      sock,
      jid,
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await typing.stop();
  }
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

  const cancelPhrases = new Set([
    "cancelar", "cancela", "cancelalo", "cancelar esto", "salir", "sal",
    "olvidalo", "dejalo", "abortar", "aborta", "detener", "detenlo",
  ]);
  if (cancelPhrases.has(normalized)) {
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
  sock: WASocket,
  message: WAMessage,
): Promise<void> {
  const key = message.key;
  const remoteJid = key.remoteJid;
  const fromMe = key.fromMe;

  if (!remoteJid || fromMe) {
    return;
  }

  // Marcar como leído (2 palomitas azules) inmediatamente
  void sock.readMessages([key]).catch(() => {});

  const mediaKind = getMediaKind(message);
  const text =
    message.message?.conversation ??
    message.message?.extendedTextMessage?.text ??
    message.message?.imageMessage?.caption ??
    "";

  // Baileys también emite notificaciones sin contenido conversacional
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
      await sendWithTyping(sock, remoteJid, "❌ Operación cancelada.");
      return;
    }
    if (command) {
      // Envió un comando durante flujo — cancelar pending y seguir
      authManager.clearPendingAction(remoteJid);
    } else {
      await handlePendingAuthAction(sock, message, remoteJid, text);
      return;
    }
  }

  // ── Puerta de autenticación ─────────────────────────────────────
  if (!authManager.userExists()) {
    if (!(command && ["setup", "cancelar"].includes(command.name))) {
      await sendWithTyping(
        sock,
        remoteJid,
        "🔒 No hay cuentas de administrador. Envía !setup para crear la primera.",
      );
      return;
    }
  } else if (!authManager.isLoggedIn(remoteJid)) {
    if (!(command && ["login", "cancelar"].includes(command.name))) {
      await sendWithTyping(
        sock,
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
        await sendWithTyping(
          sock,
          remoteJid,
          "🚫 Tu cuenta ha sido baneada. Contacta al administrador.",
        );
        return;
      }
    }
  }

  // ── Configuración interactiva del proveedor ───────────────────
  if (providerSetupManager.has(remoteJid)) {
    if (!isAdminSession(remoteJid)) {
      providerSetupManager.cancel(remoteJid);
      await sendWithTyping(
        sock,
        remoteJid,
        "⚠️ La configuración se canceló porque la sesión ya no es administradora.",
      );
      return;
    }

    if (command && command.name === "cancelar") {
      providerSetupManager.cancel(remoteJid);
      await sendWithTyping(sock, remoteJid, "❌ Configuración del proveedor cancelada.");
      return;
    }

    if (command) {
      providerSetupManager.cancel(remoteJid);
    } else {
      await handlePendingProviderSetup(sock, message, remoteJid, text);
      return;
    }
  }

  // ── Configuración interactiva del agente ───────────────────────
  if (agentConfigFlowManager.has(remoteJid)) {
    if (!isAdminSession(remoteJid)) {
      agentConfigFlowManager.cancel(remoteJid);
      await sendWithTyping(sock, remoteJid, "⚠️ La configuración se canceló porque la sesión ya no es administradora.");
      return;
    }
    if (command && command.name === "cancelar") {
      agentConfigFlowManager.cancel(remoteJid);
      await sendWithTyping(sock, remoteJid, "❌ Configuración del agente cancelada.");
      return;
    }
    if (command) {
      agentConfigFlowManager.cancel(remoteJid);
    } else {
      await handlePendingAgentConfig(sock, remoteJid, text);
      return;
    }
  }

  // ── Configuración interactiva de búsqueda ─────────────────────
  if (searchSetupManager.has(remoteJid)) {
    if (!isAdminSession(remoteJid)) {
      searchSetupManager.cancel(remoteJid);
      await sendWithTyping(sock, remoteJid, "⚠️ La configuración se canceló porque la sesión ya no es administradora.");
      return;
    }
    if (command && command.name === "cancelar") {
      searchSetupManager.cancel(remoteJid);
      await sendWithTyping(sock, remoteJid, "❌ Configuración de búsqueda cancelada.");
      return;
    }
    if (command) {
      searchSetupManager.cancel(remoteJid);
    } else {
      await handlePendingSearchSetup(sock, message, remoteJid, text);
      return;
    }
  }

  // ── Configuración interactiva de Whisper ──────────────────────
  if (whisperSetupManager.has(remoteJid)) {
    if (!isAdminSession(remoteJid)) {
      whisperSetupManager.cancel(remoteJid);
      await sendWithTyping(sock, remoteJid, "⚠️ La configuración se canceló porque la sesión ya no es administradora.");
      return;
    }
    if (command && command.name === "cancelar") {
      whisperSetupManager.cancel(remoteJid);
      await sendWithTyping(sock, remoteJid, "❌ Configuración de Whisper cancelada.");
      return;
    }
    if (command) {
      whisperSetupManager.cancel(remoteJid);
    } else {
      await handlePendingWhisperSetup(sock, remoteJid, text);
      return;
    }
  }

  // ── Verificar si espera selección de modelo ────────────────────
  if (contextManager?.isAwaitingModelSelection(remoteJid)) {
    if (isPositiveInteger(text.trim())) {
      const index = parseInt(text.trim(), 10) - 1;
      if (availableModels.length === 0) {
        contextManager.clearAwaitingModelSelection(remoteJid);
        await sendWithTyping(
          sock,
          remoteJid,
          "❌ No hay modelos disponibles. Usa !modelos para recargar.",
        );
        return;
      }
      const model = availableModels[index];
      if (model) {
        contextManager.setModel(remoteJid, model);
        contextManager.clearAwaitingModelSelection(remoteJid);
        await sendWithTyping(sock, remoteJid, `✅ Modelo seleccionado: ${model}`);
      } else {
        await sendWithTyping(
          sock,
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
    const result = await dispatchCommand(command, remoteJid, sock);

    if (result) {
      await sendWithTyping(sock, remoteJid, result.text);
    } else {
      const sessionUsername = authManager.getUsername(remoteJid);
      const isAdmin = sessionUsername
        ? authManager.isAdmin(sessionUsername)
        : false;
      const cmds = getCommands(isAdmin);
      const lista = cmds
        .map((c) => formatCommandName(c.name))
        .join(", ");
      await sendWithTyping(
        sock,
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
    await handleMediaMessage(sock, message, remoteJid, mediaKind);
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
    await sendWithTyping(
      sock,
      remoteJid,
      "⚠️ El chat LLM todavía está iniciando. Intenta nuevamente en unos segundos.",
    );
    return;
  }

  await handleAiChat(sock, remoteJid, text);
}

/**
 * Procesa un mensaje como chat AI: construye contexto, llama a la API
 * con soporte de function calling (tools), responde.
 */
async function handleAiChat(
  sock: WASocket,
  remoteJid: string,
  userText: string,
): Promise<void> {
  if (!llmConfig || !contextManager) {
    return;
  }

  const model = contextManager.getModel(remoteJid);

  if (!model) {
    await sendWithTyping(
      sock,
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
  const activeTools = getAvailableTools(remoteJid);
  await cm.withLock(remoteJid, async () => {

  const userMessage = { role: "user" as const, content: userText };
  cm.addMessage(remoteJid, userMessage);

  // Verificar si necesita compactación antes de llamar a la API
  await ensureContextCompaction(sock, remoteJid);

  const messages = cm.getMessages(remoteJid);

  // Inyectar contexto dinámico (hora + memoria) en el último user message,
  // usando shallow clone para no contaminar el contexto persistido
  const dynamicCtx = cm.buildDynamicContext(remoteJid);
  const apiMessages = messages.map((m) => ({ ...m }));
  const lastMsg = apiMessages[apiMessages.length - 1];
  if (lastMsg && lastMsg.role === "user") {
    lastMsg.content = `${dynamicCtx}\n\n---\n\n${lastMsg.content}`;
  }

  // Mantener el estado escribiendo durante toda la operación real.
  const typingSession = await startContinuousTyping(sock, remoteJid);

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
        await sendWhatsAppMessage(sock, remoteJid, {
          text: buildVisibleSystemConfirmation(result),
        }, { waitForDelivery: false });
        await typingSession.refresh();
      }
    };

    const toolExecutor = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<string> => {
      if (TOOL_NOTIFICATION_TEXTS.has(name) && !shownNotifs.has(name)) {
        shownNotifs.add(name);
        const notification = TOOL_NOTIFICATION_TEXTS.get(name) ?? "";
        await sendWhatsAppMessage(sock, remoteJid, { text: notification }, { waitForDelivery: false });
        await typingSession.refresh();
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
            (task) => task.status === "running" || task.status === "synthesizing",
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
          filterRequests: spawnDeduper.filter,
          onProgress: async (event) => {
            const progressText = formatSpawnAgentsProgress(event);
            if (!progressText) return;
            await sendWhatsAppMessage(sock, remoteJid, { text: progressText }, { minDelayMs: 800, maxDelayMs: 1_800, waitForDelivery: false });
            await typingSession.refresh();
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
          filterRequests: spawnDeduper.filter,
          onProgress: async (event) => {
            const progressText = formatSpawnAgentsProgress(event);
            if (!progressText) return;
            await sendWhatsAppMessage(sock, remoteJid, { text: progressText }, { minDelayMs: 800, maxDelayMs: 1_800, waitForDelivery: false });
            await typingSession.refresh();
          },
        });
        toolResults.push({ name, result });
        return result;
      }

      if (["task_list", "task_status", "task_cancel"].includes(name)) {
        result = executeAgentTaskTool(name, args, { jid: remoteJid, tasks: taskRuntime });
        toolResults.push({ name, result });
        return result;
      }

      if (WHATSAPP_TOOLS.some((tool) => tool.function.name === name)) {
        result = await executeWhatsAppTool(args, {
          sock,
          jid: remoteJid,
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
            await sendWhatsAppMessage(sock, remoteJid, {
              text: `⬇️ Descargando ${progress.model.id}: ${progress.percent}%`,
            }, { waitForDelivery: false });
            await typingSession.refresh();
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
        onToolRoundComplete: async () => {
          // Igual que Codewolf: la deduplicación semántica solo aplica a las
          // solicitudes repetidas dentro de una misma respuesta del modelo.
          spawnDeduper.reset();
        },
      },
    );

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
    // Si WhatsApp se desconectó durante la tarea, queda pendiente y se envía
    // automáticamente al reconectar sin abortar el flujo del agente.
    await sendWithTyping(sock, remoteJid, finalContent, 1_500, 3_000);
    if (clearConversationAfterResponse) {
      // La confirmación se entrega por WhatsApp, pero el historial queda realmente
      // limpio igual que con !clear; memoria, modelo y workdir se conservan.
      cm.clearConversation(remoteJid);
    }
  } catch (err: unknown) {
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

    await sendWithTyping(
      sock,
      remoteJid,
      isOverflow
        ? "⚠️ La conversación alcanzó su límite y fue compactada. Envía tu mensaje nuevamente."
        : err instanceof LlmRetriesExhaustedError
          ? `⚠️ El proveedor LLM no respondió correctamente después de ${err.attempts} intentos. Aborté esta ejecución para evitar un bucle; puedes reintentar la solicitud.`
          : "❌ No pude procesar tu mensaje en este momento. Intenta de nuevo.",
    );
  } finally {
    await typingSession.stop();
  }

  }); // fin de withLock
}

// ─── Media ───────────────────────────────────────────────────────

async function handleMediaMessage(
  sock: WASocket,
  message: WAMessage,
  remoteJid: string,
  mediaKind: "image" | "audio",
): Promise<void> {
  if (!llmConfig || !contextManager) {
    await sendWithTyping(
      sock,
      remoteJid,
      "⚠️ El chat LLM todavía está iniciando. Intenta nuevamente en unos segundos.",
    );
    return;
  }

  const typingSession = await startContinuousTyping(sock, remoteJid);

  try {
    if (mediaKind === "audio") {
      await sendWhatsAppMessage(sock, remoteJid, { text: "🎙️ Transcribiendo audio..." }, { waitForDelivery: false });
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
        await sendWhatsAppMessage(sock, remoteJid, { text: "⚠️ No pude identificar voz o texto en el audio." }, { waitForDelivery: false });
        return;
      }

      await typingSession.stop();
      await handleAiChat(sock, remoteJid, buildAudioContextText(result.text));
      return;
    }

    await sendWhatsAppMessage(sock, remoteJid, { text: "🖼️ Extrayendo texto de la imagen..." }, { waitForDelivery: false });
    const media = await downloadImageForOcr(message);
    const result = await mediaProcessor.process(
      "ocr-image",
      media.bytes,
      media.mimeType,
    );
    const caption = getMediaCaption(message);
    if (!result.text.trim()) {
      await sendWhatsAppMessage(sock, remoteJid, {
        text: "⚠️ No encontré texto legible en la imagen. No enviaré una respuesta al asistente sin el resultado del OCR.",
      }, { waitForDelivery: false });
      return;
    }

    await typingSession.stop();
    await handleAiChat(
      sock,
      remoteJid,
      buildImageContextText(result.text, caption),
    );
  } catch (error) {
    console.error(`[media] Error procesando ${mediaKind}:`, error);
    await sendWhatsAppMessage(sock, remoteJid, {
      text: `❌ ${error instanceof Error ? error.message : "No se pudo procesar el archivo."}`,
    }, { waitForDelivery: false });
  } finally {
    await typingSession.stop();
  }
}
