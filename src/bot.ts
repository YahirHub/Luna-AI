import type { MessagingTransport, TransportIncomingMessage } from "./transports/types.ts";
import { debugError, debugInfo, debugWarn } from "./debug.ts";
import { isWhatsAppGroupJid } from "./whatsapp-message-guard.ts";
import {
  registerCommand,
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
  requestForcedToolArguments,
  LlmRetriesExhaustedError,
  setLlmUsageObserver,
} from "./ai.ts";
import {
  ProviderSetupManager,
  deleteLlmConfig,
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
  PersistentMemoryVault,
  MEMORY_VAULT_TOOLS,
  executeMemoryVaultTool,
} from "./memory-vault.ts";
import {
  buildConfirmedMemoryResponse,
  buildMemoryTransactionInstruction,
  buildUnconfirmedMemoryResponse,
  detectMemoryPersistenceIntent,
  hasConfirmedMemoryMutation,
} from "./memory-intent.ts";
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
import { sendWithTyping, startContinuousTyping, sendWhatsAppMessage } from "./messaging.ts";
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
import { isApiSearchCapabilityAvailable } from "./search/search-routing.ts";
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
  shouldUseBrowserAgentForPrompt,
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
} from "./browser/browser-credentials.ts";
import { UsageStore, type ContextUsageBreakdownSnapshot } from "./usage/usage-store.ts";
import { buildContextUsageSnapshot } from "./usage/context-usage.ts";
import { renderUsageCard } from "./usage/usage-card.ts";
import { moduleRegistry } from "./modules/catalog.ts";
import type { ModuleSession } from "./modules/types.ts";

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
/** Bóveda temática persistente compatible con Markdown/Obsidian. */
const memoryVault = new PersistentMemoryVault();

/** Gestor de recordatorios. */
const reminderManager = new ReminderManager();

/** Gestor de alarmas recurrentes. */
const alarmManager = new AlarmManager();

/** Workdir privado y herramientas extendidas por usuario. */
const workspaceManager = new WorkspaceManager();
const taskRuntime = new TaskRuntime(workspaceManager);

// Variable para guardar el socket actual (para alarmas)
let currentTransport: MessagingTransport | null = null;

/** Métricas persistentes por usuario. */
const usageStore = new UsageStore();
setLlmUsageObserver((event) => usageStore.recordLlmRequest(event));

interface CompactionJobState {
  mode: "automatic" | "manual";
  startedAt: string;
  tokensBefore: number;
  triggerTokens: number;
  promise: Promise<void>;
  controller: AbortController;
}

/** Una compactación por usuario; nunca bloquea el procesamiento normal del chat. */
const compactionJobs = new Map<string, CompactionJobState>();

/** Ejecución principal activa por usuario. !cancelar aborta también al orquestador,
 * no solo al subagente, para impedir que el modelo lance tareas de seguimiento
 * después de que el usuario ya canceló la solicitud. */
const activeAiRuns = new Map<string, AbortController>();

/** Serializa revisiones automáticas por chat para no mezclar resultados simultáneos. */
const backgroundReviewChains = new Map<string, Promise<void>>();

/** Tools base y herramientas opcionales según /config. */
const BASE_TOOLS = [
  ...MEMORY_TOOLS,
  ...MEMORY_VAULT_TOOLS,
  ...REMINDER_TOOLS,
  ...ALARM_TOOLS,
  ...WORKSPACE_TOOLS,
  ...ARTIFACT_TOOLS,
  ...MESSAGING_TOOLS,
  ...USER_CONTROL_TOOLS,
];

function getModuleSession(jid?: string): ModuleSession {
  if (!jid || !authManager.isLoggedIn(jid)) return { authenticated: false, isAdmin: false };
  return { authenticated: true, isAdmin: isAdminSession(jid) };
}

function getAvailableTools(jid?: string): import("./ai.ts").ToolDefinition[] {
  const session = getModuleSession(jid);
  if (!session.authenticated) return [];
  const pool = [
    ...BASE_TOOLS,
    ...getMainAgentTools(agentConfig, isApiSearchCapabilityAvailable()),
    ...ADMIN_TOOLS,
    ...ADMIN_CONTROL_TOOLS,
  ];
  const filtered = moduleRegistry.filterTools(pool, session);
  if (filtered.rejected.length > 0) {
    debugInfo("modules.tools", "filtered", { jid, isAdmin: session.isAdmin, rejected: filtered.rejected });
  }
  return filtered.tools;
}

moduleRegistry.bindContextProvider("provider", () => [
  `Proveedor activo: ${llmProviderMode}`,
  `Modelo global: ${llmConfig?.defaultModel ?? "no disponible"}`,
].join("\n"));

moduleRegistry.bindContextProvider("search", () => {
  const settings = loadWebSearchSettings();
  const auth = loadWebSearchAuth();
  const states = SEARCH_PROVIDER_IDS.map((provider) => {
    const state = resolveSearchProviderState(provider, settings, auth);
    return `${SEARCH_PROVIDER_LABELS[provider]}=${state.enabled ? "activo" : state.configured ? "desactivado" : "sin credencial"}`;
  });
  return [`Predeterminado: ${settings.defaultProvider ? SEARCH_PROVIDER_LABELS[settings.defaultProvider] : "ninguno"}`, `Motores: ${states.join(", ")}`].join("\n");
});

moduleRegistry.bindContextProvider("whisper", () => {
  const config = loadWhisperConfig();
  return `Modelo: ${config.modelId}\nIdioma: ${config.language}\nThreads: ${config.threads === 0 ? "automático" : config.threads}`;
});

moduleRegistry.bindContextProvider("agents", (_message, _session) => {
  const config = loadAgentConfig();
  return [
    `api-search: ${config.webSearchEnabled && config.researchSubagentEnabled && isApiSearchCapabilityAvailable() ? "disponible" : "no disponible"}`,
    `Profundidad predeterminada: ${config.defaultSearchDepth}`,
    `Timeout researcher: ${Math.round(config.researcherTimeoutMs / 60_000)} min`,
  ].join("\n");
});

moduleRegistry.bindContextProvider("context", (_message, _session) => {
  return "La compactación manual y automática se ejecuta en segundo plano; /uso distingue contexto actual de consumo histórico.";
});

const TOOL_NOTIFICATION_TEXTS = new Map<string, string>([
  ["create_reminder", "⏰ Creando recordatorio..."],
  ["delete_reminder", "🗑️ Eliminando recordatorio..."],
  ["list_reminders", "📋 Consultando recordatorios..."],
  ["memory_write", "📝 Actualizando perfil persistente..."],
  ["memory_read", "🔍 Leyendo perfil persistente..."],
  ["memory_vault_list", "🗂️ Listando la bóveda personal..."],
  ["memory_vault_search", "🔎 Buscando en la bóveda personal..."],
  ["memory_vault_read", "📖 Leyendo una nota persistente..."],
  ["memory_vault_upsert", "📝 Guardando una nota persistente..."],
  ["memory_vault_edit", "✏️ Editando una nota persistente..."],
  ["memory_vault_rename", "🏷️ Renombrando una nota persistente..."],
  ["memory_vault_backlinks", "🔗 Consultando relaciones entre notas..."],
  ["memory_vault_delete", "🗑️ Moviendo una nota a la papelera..."],
  ["memory_vault_restore", "♻️ Consultando la papelera de memoria..."],
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
  ["message_send", "📤 Preparando envío por el transporte activo..."],
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

function getUsageSnapshotForDisplay(jid: string): ContextUsageBreakdownSnapshot | null {
  const cm = contextManager;
  if (!cm) return usageStore.get(jid).lastContext;
  const model = cm.getModel(jid);
  const persistedMessages: import("./ai.ts").ChatMessage[] = structuredClone(cm.getMessages(jid));
  const tools = getAvailableTools(jid);
  const profileMemory = getMemoryContent(jid);
  const compactedSummary = cm.getCompactionSummaryText(jid);
  const supervisorContext = taskRuntime.buildContextSummary(jid);
  const dynamicContext = `${cm.buildDynamicContext(jid)}\n\n${supervisorContext}`;
  const apiMessages = persistedMessages.map((message) => ({ ...message }));
  // /uso no se guarda en el historial. Simulamos un próximo mensaje mínimo para
  // medir cuánto contexto base tendría el siguiente request sin inventar una
  // recuperación de bóveda que depende semánticamente de la consulta real.
  apiMessages.push({ role: "user", content: `${dynamicContext}\n\n---\n\n[medición local de contexto]` });
  return buildContextUsageSnapshot({
    model,
    persistedMessages: [...persistedMessages, { role: "user", content: "[medición local de contexto]" }],
    apiMessages,
    tools,
    rawCurrentMessage: "[medición local de contexto]",
    profileMemory,
    vaultContext: "",
    compactedSummary,
    supervisorContext,
  });
}

function formatUsageText(jid: string): string {
  const data = usageStore.get(jid);
  const ctx = getUsageSnapshotForDisplay(jid);
  if (!ctx) return "⚠️ Todavía no hay contexto disponible para medir.";
  const last = data.lastRequest;
  const source = !last
    ? "sin muestras todavía"
    : last.source === "provider"
      ? "métricas reales del provider"
      : last.source === "mixed"
        ? "provider + estimación local"
        : "estimación local (el provider no devolvió usage)";
  const compaction = contextManager?.getCompactionMetadata(jid);
  const compactCount = Math.max(data.compaction.count, compaction?.count ?? 0);
  const messagesCompacted = Math.max(data.compaction.messagesCompacted, compaction?.messagesCompacted ?? 0);
  const lastBefore = data.compaction.estimatedTokensBefore || compaction?.estimatedTokensBefore || 0;
  const lastAfter = data.compaction.estimatedTokensAfter || compaction?.estimatedTokensAfter || 0;
  const reduction = lastBefore > 0 ? ((lastBefore - lastAfter) / lastBefore) * 100 : 0;
  return [
    "📊 USO DEL CONTEXTO",
    "",
    `Modelo: ${ctx.model}`,
    `Contexto estimado: ~${ctx.estimatedTotalTokens.toLocaleString("es-MX")} / ${ctx.effectiveInputBudget.toLocaleString("es-MX")} tokens (${ctx.percentOfInputBudget.toFixed(1)}%)`,
    `Ventana del modelo: ${ctx.maxContextTokens.toLocaleString("es-MX")} tokens`,
    `Auto-compactación: ${ctx.autoCompactTriggerTokens.toLocaleString("es-MX")} tokens (85% del presupuesto de entrada)`,
    "",
    "Desglose estimado del próximo request base:",
    `- Conversación: ${(ctx.conversationTokens + ctx.currentMessageTokens).toLocaleString("es-MX")}`,
    `- Herramientas: ${ctx.toolTokens.toLocaleString("es-MX")}`,
    `- System prompt: ${ctx.systemTokens.toLocaleString("es-MX")}`,
    `- Memoria de perfil: ${ctx.profileMemoryTokens.toLocaleString("es-MX")}`,
    `- Bóveda recuperada: ${ctx.vaultMemoryTokens.toLocaleString("es-MX")}`,
    `- Resumen compactado: ${ctx.compactedSummaryTokens.toLocaleString("es-MX")}`,
    `- Supervisor: ${ctx.supervisorTokens.toLocaleString("es-MX")}`,
    `- Otros dinámicos: ${ctx.otherDynamicTokens.toLocaleString("es-MX")}`,
    "",
    "Consumo API acumulado:",
    `- Entrada: ${data.lifetime.promptTokens.toLocaleString("es-MX")}`,
    `- Salida: ${data.lifetime.completionTokens.toLocaleString("es-MX")}`,
    `- Total: ${data.lifetime.totalTokens.toLocaleString("es-MX")}`,
    `- Requests: ${data.lifetime.requests.toLocaleString("es-MX")}`,
    `- Fuente del último request: ${source}`,
    `- Requests con métricas reales: ${data.lifetime.providerReportedRequests}`,
    `- Mixtos: ${data.lifetime.mixedRequests}`,
    `- Estimados: ${data.lifetime.estimatedRequests}`,
    "",
    `Compactaciones: ${compactCount}`,
    `Mensajes compactados: ${messagesCompacted}`,
    lastBefore > 0 ? `Última reducción: ~${lastBefore.toLocaleString("es-MX")} → ~${lastAfter.toLocaleString("es-MX")} (${Math.max(0, reduction).toFixed(1)}%)` : "Última reducción: todavía no registrada",
  ].join("\n");
}

interface CompactionPlan {
  snapshot: import("./ai.ts").ChatMessage[];
  currentTokens: number;
  effectiveBudget: number;
  triggerTokens: number;
  split: ReturnType<typeof selectMessagesForCompaction>;
  modelId: string;
}

function buildCompactionPlan(jid: string, mode: "automatic" | "manual"): CompactionPlan | null {
  if (!contextManager || !llmConfig) return null;
  const snapshot = structuredClone(contextManager.getMessages(jid));
  if (snapshot.length <= 2) return null;
  const modelId = contextManager.getModel(jid);
  const currentTokens = estimateTokensAccurate(snapshot);
  const toolsTokens = estimateRequestTokens([], getAvailableTools(jid));
  const effectiveBudget = modelCatalog.getEffectiveBudget(modelId, toolsTokens);
  const triggerTokens = Math.floor(effectiveBudget * 0.85);
  if (mode === "automatic" && currentTokens < triggerTokens) return null;
  const split = selectMessagesForCompaction({
    messages: snapshot,
    preserveRecentTurns: 10,
    targetTokens: Math.floor(effectiveBudget * 0.55),
  });
  if (split.messagesToCompact.length === 0) return null;
  return { snapshot, currentTokens, effectiveBudget, triggerTokens, split, modelId };
}

function formatCompactionCompletion(options: {
  mode: "automatic" | "manual";
  before: number;
  after: number;
  messages: number;
  appended: number;
}): string {
  const reduction = options.before > 0 ? Math.max(0, ((options.before - options.after) / options.before) * 100) : 0;
  return [
    options.mode === "manual" ? "✅ COMPACTACIÓN MANUAL COMPLETADA" : "✅ Compactación automática completada",
    "",
    `Antes: ~${options.before.toLocaleString("es-MX")} tokens`,
    `Después: ~${options.after.toLocaleString("es-MX")} tokens`,
    `Reducción: ${reduction.toFixed(1)}%`,
    `Mensajes compactados: ${options.messages}`,
    options.appended > 0 ? `Mensajes nuevos preservados durante el proceso: ${options.appended}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Inicia una compactación sobre un snapshot y devuelve inmediatamente. El LLM
 * resume fuera del lock; al confirmar el resultado se fusiona cualquier cola de
 * mensajes nueva que haya llegado mientras tanto.
 */
function startContextCompaction(
  transport: MessagingTransport,
  jid: string,
  mode: "automatic" | "manual",
): { started: boolean; reason?: string; tokensBefore?: number; triggerTokens?: number } {
  if (!contextManager || !llmConfig) return { started: false, reason: "El proveedor LLM todavía no está disponible." };
  const active = compactionJobs.get(jid);
  if (active) {
    return { started: false, reason: "Ya hay una compactación en curso.", tokensBefore: active.tokensBefore, triggerTokens: active.triggerTokens };
  }
  const plan = buildCompactionPlan(jid, mode);
  if (!plan) {
    const messages = contextManager.getMessages(jid);
    const tokens = estimateTokensAccurate(messages);
    return {
      started: false,
      reason: mode === "manual" ? "No hay suficientes mensajes antiguos para compactar todavía." : "No se alcanzó el umbral automático.",
      tokensBefore: tokens,
    };
  }

  const cm = contextManager;
  const cfg = llmConfig;
  const persistentMemory = getMemoryContent(jid);
  const previousSummary = cm.getCompactionSummary(jid);
  const compactionMessages = buildCompactionPrompt({
    previousSummary: previousSummary ?? null,
    messagesToCompact: plan.split.messagesToCompact,
    persistentMemory,
  });
  const startedAt = new Date().toISOString();
  const controller = new AbortController();

  const promise = (async () => {
    try {
      debugInfo("context.compaction", "started", {
        jid,
        mode,
        tokensBefore: plan.currentTokens,
        effectiveBudget: plan.effectiveBudget,
        messagesToCompact: plan.split.messagesToCompact.length,
      });
      const compactRaw = await chatCompletion(
        compactionMessages,
        plan.modelId,
        cfg,
        2,
        4096,
        { jid, purpose: "compaction" },
        controller.signal,
      );
      const parsedSummary = parseCompactedResponse(compactRaw);
      if (!parsedSummary) {
        debugWarn("context.compaction", "invalid_summary", { jid, mode, responseChars: compactRaw.length });
        if (mode === "manual") {
          await sendWhatsAppMessage(transport, jid, { text: "⚠️ No pude validar el resumen de compactación. Conservé intacta la conversación." }, { waitForDelivery: false });
        }
        return;
      }

      const applied = await cm.withLock(jid, async () => cm.applyCompactionSnapshot(
        jid,
        plan.snapshot,
        plan.split.messagesToKeep,
        parsedSummary,
        plan.currentTokens,
        plan.split.messagesToCompact.length,
        estimateTokensAccurate,
      ));
      if (!applied.applied) {
        debugWarn("context.compaction", "stale_snapshot", { jid, mode });
        if (mode === "manual") {
          await sendWhatsAppMessage(transport, jid, { text: "⚠️ La conversación cambió de forma incompatible durante la compactación. No reemplacé ningún mensaje; puedes ejecutar /compact nuevamente." }, { waitForDelivery: false });
        }
        return;
      }

      usageStore.recordCompaction(jid, {
        messagesCompacted: plan.split.messagesToCompact.length,
        tokensBefore: plan.currentTokens,
        tokensAfter: applied.tokensAfter,
      });
      debugInfo("context.compaction", "completed", {
        jid,
        mode,
        tokensBefore: plan.currentTokens,
        tokensAfter: applied.tokensAfter,
        appendedMessages: applied.appendedMessages,
      });
      await sendWhatsAppMessage(transport, jid, {
        text: formatCompactionCompletion({
          mode,
          before: plan.currentTokens,
          after: applied.tokensAfter,
          messages: plan.split.messagesToCompact.length,
          appended: applied.appendedMessages,
        }),
      }, { waitForDelivery: false });
    } catch (error) {
      if (controller.signal.aborted) {
        debugInfo("context.compaction", "cancelled", { jid, mode });
        return;
      }
      debugError("context.compaction", "failed", error, { jid, mode });
      if (mode === "manual") {
        await sendWhatsAppMessage(transport, jid, { text: "❌ La compactación falló y conservé intacta la conversación." }, { waitForDelivery: false });
      }
    }
  })().finally(() => {
    const current = compactionJobs.get(jid);
    if (current?.promise === promise) compactionJobs.delete(jid);
  });

  compactionJobs.set(jid, {
    mode,
    startedAt,
    tokensBefore: plan.currentTokens,
    triggerTokens: plan.triggerTokens,
    promise,
    controller,
  });
  return { started: true, tokensBefore: plan.currentTokens, triggerTokens: plan.triggerTokens };
}

function maybeStartAutomaticCompaction(transport: MessagingTransport, jid: string): void {
  if (compactionJobs.has(jid)) return;
  startContextCompaction(transport, jid, "automatic");
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
  const persistedGlobalModel = loadGlobalLlmModel(activeConfig.modelsUrl, configPath);
  if (persistedGlobalModel) activeConfig.defaultModel = persistedGlobalModel;
  llmProviderMode = config ? "custom" : "opencode-free";
  llmConfig = activeConfig;
  availableModels =
    llmProviderMode === "opencode-free"
      ? getOpenCodeFreeFallbackModels()
      : [activeConfig.defaultModel];

  if (contextManager) {
    contextManager.setGlobalModel(activeConfig.defaultModel);
  } else {
    contextManager = new ContextManager(activeConfig.defaultModel);
    contextManager.setMemoryManager(memoryManager);
  }

  // No bloquear el arranque ni /setup-provider por una caída de /models.
  void refreshAvailableModels();
}

function applyGlobalModelSelection(model: string): void {
  if (!llmConfig || !contextManager) throw new Error("El proveedor LLM todavía no está disponible.");
  llmConfig.defaultModel = model;
  contextManager.setGlobalModel(model);
  saveGlobalLlmModel(llmConfig, llmConfigPath);
  if (llmProviderMode === "custom") saveLlmConfig(llmConfig, llmConfigPath);
}

/**
 * Actualiza la referencia al socket activo.
 * Se llama desde connection.ts cuando el socket se conecta/reconecta.
 */
export function setTransport(transport: MessagingTransport | null): void {
  reminderManager.setTransport(transport);
  currentTransport = transport;
}

/** Callback cuando una alarma recurrente debe dispararse. */
async function onAlarmDue(
  alarm: import("./alarm.ts").RecurringAlarm,
): Promise<void> {
  if (!currentTransport) {
    throw new Error("Socket no disponible para entregar la alarma.");
  }

  const dayName = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
  }).format(new Date());

  const deliveredText = await deliverScheduledMessage({
    transport: currentTransport,
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
  sock: MessagingTransport | null,
): Promise<void> {
  if (!sock) {
    throw new Error("Socket no disponible para entregar el recordatorio.");
  }

  const deliveredText = await deliverScheduledMessage({
    transport: sock,
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
  "compact",
  "uso",
]);

function formatCommandName(name: string): string {
  return `${SLASH_COMMANDS.has(name) ? "/" : "!"}${name}`;
}

function agentBackendLabel(agentType: string): "browser-agent" | "api-search" {
  return agentType === "browser-web" ? "browser-agent" : "api-search";
}

function splitCompleteMessage(value: string, maxChars = 3_200): string[] {
  const text = value.trim();
  if (!text) return [];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars * 0.55)) cut = remaining.lastIndexOf(" ", maxChars);
    if (cut < Math.floor(maxChars * 0.55)) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function formatSpawnAgentsProgress(event: SpawnAgentsProgress): string[] {
  switch (event.type) {
    case "task_registered":
      return [`📌 Tarea registrada: ${event.title}\nID: ${event.taskId}\nEstado: en cola; te confirmaré cuando el agente empiece realmente.`];
    case "agent_started": {
      const backend = agentBackendLabel(event.agentType);
      const prefix = `🚀 ${backend} ${event.agentId} activo — ${event.agentName}`;
      const prompt = event.prompt.trim();
      if (!prompt) return [prefix];
      const chunks = splitCompleteMessage(prompt);
      if (chunks.length === 1) return [`${prefix}\nMisión completa:\n${chunks[0]}`];
      return [
        `${prefix}\nMisión completa enviada en ${chunks.length} partes:`,
        ...chunks.map((chunk, index) => `Misión ${index + 1}/${chunks.length}:\n${chunk}`),
      ];
    }
    case "agent_activity":
      return [];
    case "agent_completed": {
      if (event.status === "cancelled") return [];
      const backend = agentBackendLabel(event.agentType);
      const icon = event.status === "completed" ? "✅" : "❌";
      const label = event.status === "completed" ? "terminó" : "falló";
      return [`${icon} ${backend} ${event.agentId} — ${event.agentName}: ${label}.`];
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

function buildDeterministicTaskSummary(taskId: string, title: string, status: string, agents: Array<{ name: string; agentType?: string; status: string; result?: string; error?: string }>): string {
  const lines = [`📋 Revisión automática: ${title}`, "", `Estado de la tarea: ${status}`];
  for (const agent of agents) {
    lines.push("", `- ${agentBackendLabel(agent.agentType ?? "researcher-web")} ${agent.name}: ${agent.status}`);
    if (agent.error) lines.push(`  Error: ${agent.error}`);
    if (agent.result) lines.push(`  Resultado: ${agent.result.replace(/\s+/g, " ").slice(0, 800)}`);
  }
  lines.push("", `ID: ${taskId}`);
  return lines.join("\n");
}

async function reviewBackgroundTask(sock: MessagingTransport, jid: string, taskId: string): Promise<void> {
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
        return { id: agent.id, name: agent.name, agentType: agent.agentType, status: agent.status, activity: agent.activity, error: agent.error, resultPath: agent.resultPath, result };
      });
      let files: string[] = [];
      try { files = workspaceManager.listRecursive(jid, task.taskPath, 400); } catch { /* carpeta ausente */ }
      const artifacts = workspaceManager.listArtifacts(jid)
        .filter((artifact) => artifact.taskId === taskId && artifact.createdBy !== "browser-web-input")
        .slice(0, 8);
      const payload = compactReviewText(JSON.stringify({
        task: { id: task.id, title: task.title, status: finalStatus, taskPath: task.taskPath }, agents, files, artifacts,
      }, null, 2), 45_000);

      let summary = "";
      try {
        summary = (await chatCompletion([
          { role: "system", content: `${STATIC_SYSTEM_PROMPT_CONTENT}\n\nREVISIÓN AUTOMÁTICA DE TAREA:\n- Revisa resultados, errores, carpeta y artefactos reales.\n- No afirmes que sigue activa si el estado es terminal.\n- Explica exactamente qué se logró y qué faltó.\n- No lances nuevas tareas ni inventes contenido.` },
          { role: "user", content: `[Resultado de tarea de fondo confirmado por el sistema]\n\n${payload}` },
        ], cm.getModel(jid), cfg, 3, 3500, { jid, purpose: "task-review" })).trim();
      } catch (error) {
        debugError("agents.review", "llm_review_failed", error, { jid, taskId });
      }
      if (!summary) summary = buildDeterministicTaskSummary(task.id, task.title, finalStatus, agents);
      await cm.withLock(jid, async () => {
        cm.addMessage(jid, { role: "user", content: `[Resultado de tarea de fondo confirmado por el sistema]\nTarea ${task.id} (${task.title}) terminó con estado ${finalStatus}.` });
        cm.addMessage(jid, { role: "assistant", content: summary });
      });
      await sendWithTyping(sock, jid, summary, 1_000, 2_000);
      for (const artifact of artifacts) {
        try { await sendWorkspacePath(sock, jid, workspaceManager, artifact.path, `Resultado de ${task.title}`); }
        catch (error) { debugError("agents.review", "artifact_send_failed", error, { jid, taskId, path: artifact.path }); }
      }
      taskRuntime.update(jid, taskId, { status: finalStatus });
      taskRuntime.reviewTask(jid, taskId);
      reviewDelivered = true;
      debugInfo("agents.review", "completed", { jid, taskId, artifactsSent: artifacts.length });
    } catch (error) {
      debugError("agents.review", "automatic_review_failed", error, { jid, taskId });
    } finally {
      taskRuntime.update(jid, taskId, { status: finalStatus });
      if (!reviewDelivered) debugWarn("agents.review", "left_pending_for_retry", { jid, taskId, finalStatus });
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
  if (activeAgents.length === 0 && activeTasks.length === 0) lines.push("", "No hay agentes ejecutándose en este momento.");
  else {
    if (activeAgents.length > 0) {
      lines.push("", "Activos:");
      for (const agent of activeAgents.slice(0, 12)) {
        const task = tasks.find((item) => item.id === agent.taskId);
        const state = agent.status === "waiting_user" ? `esperando ${agent.waitingFieldName ?? "un dato"}` : agent.status === "queued" ? "en cola" : "en ejecución";
        lines.push(`• ${agentBackendLabel(agent.agentType)} ${agent.id} — ${agent.name}`, `  Estado: ${state}`, `  Ahora: ${agent.activity ?? "Preparando el siguiente paso"}`, `  Último evento: ${formatAgentEventAge(agent.lastEventAt)}`, `  Tarea: ${task?.title ?? agent.taskId}`);
      }
    }
    const represented = new Set(activeAgents.map((agent) => agent.taskId));
    for (const task of activeTasks.filter((item) => !represented.has(item.id))) {
      if (task.status === "queued") lines.push("", `⏳ ${task.title}: registrada y en cola; todavía no hay un agente confirmado como iniciado.`);
      else if (task.status === "synthesizing") lines.push("", `🧠 ${task.title}: Luna está revisando resultados, carpeta y artefactos.`);
      else lines.push("", `🔄 ${task.title}: el supervisor está conciliando sus agentes activos.`);
    }
  }
  if (recentTerminal.length > 0) {
    lines.push("", "Recientes:");
    for (const task of recentTerminal) lines.push(`• ${task.title}: ${task.status}, ${task.reviewStatus === "reviewed" ? "revisada" : "pendiente de revisión/reintento"} — ${task.id}`);
  }
  return lines.join("\n");
}

function retryPendingBackgroundReviews(sock: MessagingTransport, jid: string): void {
  const pending = taskRuntime.list(jid).filter((task) => task.reviewStatus === "pending" && ["completed", "partial", "failed", "interrupted"].includes(task.status)).slice(0, 3);
  for (const task of pending) void reviewBackgroundTask(sock, jid, task.id).catch((error) => debugError("agents.review", "retry_failed", error, { jid, taskId: task.id }));
}

function providerSetupPrompt(step: ProviderSetupStep, models: readonly string[] = []): string {
  switch (step) {
    case "chatCompletionsUrl":
      return [
        "1/3 — URL BASE DEL PROVEEDOR",
        "",
        "Envía únicamente la URL base OpenAI-compatible.",
        "Ejemplo: https://api.example.com/v1",
        "",
        "Si pegas /models o /chat/completions, Luna recuperará la base automáticamente.",
      ].join("\n");
    case "apiKey":
      return [
        "2/3 — API KEY",
        "",
        "Envía la clave del proveedor.",
        "Si no requiere clave, responde: sin-clave",
        "",
        "Después consultaré automáticamente /models.",
        "Por seguridad intentaré eliminar este mensaje después de leerlo.",
      ].join("\n");
    case "defaultModel":
      return [
        "3/3 — MODELO GLOBAL",
        "",
        "Catálogo detectado correctamente. Elige el número del modelo que usarán todos los chats y agentes:",
        "",
        ...models.map((model, index) => `${index + 1}. ${model}`),
        "",
        `Responde con un número entre 1 y ${models.length}.`,
      ].join("\n");
  }
}

async function deleteSensitiveIncomingMessage(
  sock: MessagingTransport,
  message: TransportIncomingMessage,
): Promise<void> {
  try {
    await sock.deleteMessage(message);
  } catch {
    // El transporte puede impedir borrar mensajes ajenos o ya expirados.
  }
}

function buildHelpText(jid: string): string {
  return moduleRegistry.renderHelp(getModuleSession(jid), undefined, formatCommandName);
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

  const compactionJob = compactionJobs.get(jid);
  if (compactionJob && !compactionJob.controller.signal.aborted) {
    compactionJob.controller.abort(new Error("user-cancelled-compaction"));
    cancelledSomething = true;
  }

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
    case "account_password_change_start": {
      const username = authManager.getUsername(jid);
      if (!username) return "Error: necesitas una sesión autenticada para cambiar la contraseña.";
      authManager.setPendingAction(jid, { type: "change-password", step: "awaiting-password", username });
      return "🔐 Envía tu nueva contraseña en el siguiente mensaje. Se procesará fuera del LLM y Luna intentará borrar el mensaje después.";
    }
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
          applyGlobalModelSelection(partial[0]!);
          return `✅ Modelo seleccionado: ${partial[0]}`;
        }
        return `Error: el modelo '${requested}' no está disponible. Usa model_list para consultar los modelos actuales.`;
      }
      applyGlobalModelSelection(exact);
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
        `Modelo global: ${llmConfig?.defaultModel ?? "no disponible"}`,
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
  (cmd, senderJid) => ({
    text: moduleRegistry.renderHelp(
      getModuleSession(senderJid),
      cmd.args[0],
      formatCommandName,
    ),
  }),
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

registerCommand(
  "compact",
  "Compacta manualmente la conversación o muestra el estado con /compact estado",
  (cmd, senderJid, transport) => {
    const sub = cmd.args[0]?.toLowerCase() ?? "";
    if (sub === "estado" || sub === "status") {
      const job = compactionJobs.get(senderJid);
      const metadata = contextManager?.getCompactionMetadata(senderJid);
      const lines = ["🧹 ESTADO DE COMPACTACIÓN", ""];
      if (job) {
        lines.push(
          `Estado: en curso (${job.mode === "manual" ? "manual" : "automática"})`,
          `Inicio: ${job.startedAt}`,
          `Snapshot: ~${job.tokensBefore.toLocaleString("es-MX")} tokens`,
        );
      } else {
        lines.push("Estado: sin compactación activa");
      }
      lines.push(
        "",
        `Compactaciones completadas: ${metadata?.count ?? 0}`,
        `Mensajes compactados: ${metadata?.messagesCompacted ?? 0}`,
        metadata?.lastCompactedAt ? `Última: ${metadata.lastCompactedAt}` : "Última: ninguna",
      );
      if (metadata?.estimatedTokensBefore) {
        const reduction = metadata.estimatedTokensBefore > 0
          ? ((metadata.estimatedTokensBefore - metadata.estimatedTokensAfter) / metadata.estimatedTokensBefore) * 100
          : 0;
        lines.push(`Última reducción: ~${metadata.estimatedTokensBefore.toLocaleString("es-MX")} → ~${metadata.estimatedTokensAfter.toLocaleString("es-MX")} (${Math.max(0, reduction).toFixed(1)}%)`);
      }
      return { text: lines.join("\n") };
    }

    const started = startContextCompaction(transport, senderJid, "manual");
    if (!started.started) {
      return { text: `🧹 ${started.reason ?? "No se pudo iniciar la compactación."}` };
    }
    return {
      text: [
        "🧹 Compactación manual iniciada en segundo plano.",
        "",
        `Snapshot: ~${started.tokensBefore?.toLocaleString("es-MX") ?? "?"} tokens`,
        "Puedes seguir hablando conmigo mientras termina; los mensajes nuevos se preservarán.",
      ].join("\n"),
    };
  },
);

registerCommand(
  "uso",
  "Muestra métricas de contexto y consumo; usa /uso texto para formato textual",
  async (cmd, senderJid, transport) => {
    const report = formatUsageText(senderJid);
    if ((cmd.args[0]?.toLowerCase() ?? "") === "texto") return { text: report };
    const ctx = getUsageSnapshotForDisplay(senderJid);
    if (!ctx) return { text: report };
    const data = usageStore.get(senderJid);
    const displayData = structuredClone(data);
    const metadata = contextManager?.getCompactionMetadata(senderJid);
    if (metadata && metadata.count > displayData.compaction.count) {
      displayData.compaction.count = metadata.count;
      displayData.compaction.messagesCompacted = metadata.messagesCompacted;
      displayData.compaction.lastCompactedAt = metadata.lastCompactedAt;
      displayData.compaction.estimatedTokensBefore = metadata.estimatedTokensBefore;
      displayData.compaction.estimatedTokensAfter = metadata.estimatedTokensAfter;
      displayData.compaction.lastReductionPercent = metadata.estimatedTokensBefore > 0
        ? Math.max(0, ((metadata.estimatedTokensBefore - metadata.estimatedTokensAfter) / metadata.estimatedTokensBefore) * 100)
        : 0;
    }
    const image = renderUsageCard(displayData, ctx);
    const source = data.lastRequest?.source === "provider"
      ? "métricas del provider"
      : data.lastRequest?.source === "mixed"
        ? "métricas mixtas"
        : "estimación local";
    await transport.send(senderJid, {
      image,
      mimetype: "image/png",
      caption: `📊 Uso de contexto — ${ctx.percentOfInputBudget.toFixed(1)}% del presupuesto de entrada · ${source}`,
    });
    return { text: "" };
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
            `Se muestra el modelo global: ${llmConfig.defaultModel}`,
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
          ? "La configuración personalizada actual se reemplazará al completar los 3 pasos."
          : `${OPENCODE_FREE_PROVIDER_NAME} seguirá activo hasta completar los 3 pasos.`,
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
  sock: MessagingTransport,
  message: TransportIncomingMessage,
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
      case "change-password":
        await handleChangePasswordStep(sock, jid, text, action);
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
  sock: MessagingTransport,
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
  sock: MessagingTransport,
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
  sock: MessagingTransport,
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

async function handleChangePasswordStep(
  sock: MessagingTransport,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  const username = action.username ?? authManager.getUsername(jid);
  if (!username) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(sock, jid, "❌ No pude identificar tu cuenta activa.");
    return;
  }
  const password = text.trim();
  if (!password || password.length < 4) {
    await sendWithTyping(sock, jid, "❌ La contraseña debe tener al menos 4 caracteres. Intenta de nuevo:");
    return;
  }
  await authManager.changePassword(username, password);
  authManager.clearPendingAction(jid);
  await sendWithTyping(sock, jid, "✅ Tu contraseña fue actualizada correctamente.");
}

async function handlePendingProviderSetup(
  sock: MessagingTransport,
  message: TransportIncomingMessage,
  jid: string,
  text: string,
): Promise<void> {
  const currentStep = providerSetupManager.getStep(jid);
  if (!currentStep) return;

  try {
    const result = providerSetupManager.submit(jid, text);
    if (!result.completed) {
      if (result.secretInput) await deleteSensitiveIncomingMessage(sock, message);
      if (result.discover) {
        const discovered = await discoverProviderModels(
          result.discover.candidates,
          result.discover.apiKey,
          result.discover.requestTimeoutMs,
        );
        providerSetupManager.setDiscoveredModels(jid, discovered.candidate, discovered.models);
        await sendWithTyping(sock, jid, providerSetupPrompt("defaultModel", discovered.models));
        return;
      }
      await sendWithTyping(sock, jid, providerSetupPrompt(result.nextStep, providerSetupManager.getModels(jid)));
      return;
    }

    const savedConfig = saveLlmConfig(result.config, llmConfigPath);
    saveGlobalLlmModel(savedConfig, llmConfigPath);
    initLlm(savedConfig, llmConfigPath);
    providerSetupManager.cancel(jid);

    await sendWithTyping(sock, jid, [
      "✅ PROVEEDOR CONFIGURADO",
      "",
      `URL base: ${savedConfig.modelsUrl.replace(/\/models\/?$/i, "")}`,
      `Modelo global: ${savedConfig.defaultModel}`,
      "El catálogo se detectó y validó antes de guardar la configuración.",
      "La configuración personalizada tiene prioridad sobre OpenCode Free.",
      "",
      "Este modelo queda activo globalmente para todos los chats existentes y nuevos.",
      "Cualquier cambio posterior con !modelos también se aplicará globalmente.",
    ].join("\n"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const step = providerSetupManager.getStep(jid) ?? currentStep;
    console.warn(`[provider-setup] Entrada inválida en ${step}: ${reason}`);
    await sendWithTyping(sock, jid, [
      `❌ ${reason}`,
      "",
      providerSetupPrompt(step, providerSetupManager.getModels(jid)),
    ].join("\n"));
  }
}

async function handlePendingAgentConfig(
  sock: MessagingTransport,
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
  sock: MessagingTransport,
  message: TransportIncomingMessage,
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
  sock: MessagingTransport,
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
  sock: MessagingTransport,
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
  await deleteSensitiveIncomingMessage(sock, message);
  await sendWithTyping(
    sock,
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
  sock: MessagingTransport,
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
    await sendWithTyping(
      sock,
      jid,
      "🔐 Envía tu nueva contraseña en el siguiente mensaje. Luna intentará borrar ese mensaje después de procesarlo.",
    );
    return true;
  }

  await authManager.changePassword(username, extracted);
  await deleteSensitiveIncomingMessage(sock, message);
  await sendWithTyping(sock, jid, "✅ Tu contraseña fue actualizada correctamente.");
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
  sock: MessagingTransport,
  message: TransportIncomingMessage,
): Promise<void> {
  const remoteJid = message.conversationId;
  const fromMe = message.fromSelf;

  if (!remoteJid || fromMe || isWhatsAppGroupJid(remoteJid)) return;

  // Marcar como leído inmediatamente mediante el transporte activo.
  void sock.markRead(message).catch(() => {});

  const mediaKind = getMediaKind(message);
  let text = message.text;

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

  // La cancelación es una ruta prioritaria: nunca espera el lock de conversación,
  // al LLM ni a un proveedor de búsqueda. Así puede abortar api-search/browser-agent
  // aunque otra ejecución del mismo chat continúe en segundo plano.
  if (command?.name === "cancelar" && authManager.isLoggedIn(remoteJid)) {
    await sendWithTyping(sock, remoteJid, cancelCurrentOperation(remoteJid));
    return;
  }

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

  if (authManager.isLoggedIn(remoteJid)) {
    retryPendingBackgroundReviews(sock, remoteJid);
    if (isTaskProgressQuestion(text)) {
      await sendWithTyping(sock, remoteJid, formatTaskProgressForUser(remoteJid));
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
  const pendingBrowserInput = browserCredentialStore.getPendingInput(remoteJid);
  if (pendingBrowserInput) {
    if (command && command.name === "cancelar") {
      await sendWithTyping(sock, remoteJid, cancelCurrentOperation(remoteJid));
      return;
    }

    const normalizedPendingText = normalizeNaturalText(text);
    if (["continua", "continuar", "sigue", "seguir"].includes(normalizedPendingText)) {
      const secret = pendingBrowserInput.kind === "password" || pendingBrowserInput.kind === "otp";
      const targetLines = [
        secret ? "🔐 MENSAJE DEL SISTEMA" : "🧩 MENSAJE DEL SISTEMA",
        "",
        secret
          ? `Este es el mensaje seguro del sistema: envía ahora ${pendingBrowserInput.fieldName}.`
          : `La misma tarea del navegador está pausada esperando ${pendingBrowserInput.fieldName}.`,
      ];
      if (pendingBrowserInput.url) targetLines.push(`Sitio: ${pendingBrowserInput.url}`);
      if (pendingBrowserInput.username) targetLines.push(`Cuenta: ${pendingBrowserInput.username}`);
      targetLines.push(
        "",
        secret
          ? "El agente no verá el valor. Tu respuesta se capturará fuera del modelo y se inyectará únicamente en la misma tarea del navegador, que continuará sin reiniciar la sesión."
          : "Responde con el dato solicitado y la misma tarea continuará desde la página actual.",
      );
      await sendWithTyping(sock, remoteJid, targetLines.join("\n"));
      return;
    }

    // Una espera creada por browser-web tiene requestId. En este caso NO se
    // vuelve a invocar handleAiChat: resolvemos la Promise de la ejecución viva
    // y el mismo subagente continúa con la misma sesión del navegador.
    if (pendingBrowserInput.requestId) {
      if (pendingBrowserInput.kind === "password") {
        const password = extractPendingBrowserSecret(text);
        if (!password || !pendingBrowserInput.url || !pendingBrowserInput.username) {
          await sendWithTyping(sock, remoteJid, [
            "🔐 MENSAJE DEL SISTEMA",
            "",
            "No pude asociar la contraseña con una cuenta concreta.",
            "La tarea sigue pausada; primero debe conocerse el sitio y el correo/usuario.",
          ].join("\n"));
          return;
        }
        const credential = browserCredentialStore.create({
          jid: remoteJid,
          url: pendingBrowserInput.url,
          username: pendingBrowserInput.username,
          password,
        });
        await deleteSensitiveIncomingMessage(sock, message);
        const resumed = browserCredentialStore.resolvePendingInput(remoteJid, {
          kind: "password",
          credentialRef: credential.ref,
          url: credential.url,
          username: credential.username,
        });
        if (!resumed) {
          browserCredentialStore.delete(credential.ref);
          await sendWithTyping(sock, remoteJid, "⚠️ La espera del navegador ya no estaba activa. Vuelve a solicitar la navegación.");
          return;
        }
        await sendWhatsAppMessage(sock, remoteJid, {
          text: "🔐 MENSAJE DEL SISTEMA\n\nContraseña recibida de forma segura. La misma tarea del navegador continúa ahora desde la sesión que estaba abierta.",
        }, { waitForDelivery: false });
        return;
      }

      if (pendingBrowserInput.kind === "otp") {
        const value = extractPendingBrowserSecret(text);
        if (!value) {
          await sendWithTyping(sock, remoteJid, "🔐 MENSAJE DEL SISTEMA\n\nEnvía ahora el código solicitado. La misma tarea permanece pausada.");
          return;
        }
        const secret = browserCredentialStore.createSecret({ jid: remoteJid, kind: "otp", value });
        await deleteSensitiveIncomingMessage(sock, message);
        const resumed = browserCredentialStore.resolvePendingInput(remoteJid, { kind: "otp", secretRef: secret.ref });
        if (!resumed) {
          browserCredentialStore.delete(secret.ref);
          await sendWithTyping(sock, remoteJid, "⚠️ La espera del navegador ya no estaba activa.");
          return;
        }
        await sendWhatsAppMessage(sock, remoteJid, {
          text: "🔐 MENSAJE DEL SISTEMA\n\nCódigo recibido de forma segura. La misma tarea del navegador continúa ahora.",
        }, { waitForDelivery: false });
        return;
      }

      const value = pendingBrowserInput.kind === "username"
        ? extractPendingBrowserUsername(text)
        : text.trim();
      if (!value) {
        await sendWithTyping(sock, remoteJid, `🧩 MENSAJE DEL SISTEMA\n\nEnvía ${pendingBrowserInput.fieldName}. La misma tarea permanece pausada.`);
        return;
      }
      const resumed = browserCredentialStore.resolvePendingInput(remoteJid, {
        kind: pendingBrowserInput.kind,
        value,
      });
      if (!resumed) {
        await sendWithTyping(sock, remoteJid, "⚠️ La espera del navegador ya no estaba activa.");
        return;
      }
      await sendWhatsAppMessage(sock, remoteJid, {
        text: `🧩 MENSAJE DEL SISTEMA\n\nDato recibido. La misma tarea del navegador continúa ahora desde la página actual.`,
      }, { waitForDelivery: false });
      return;
    }

    // Compatibilidad con el flujo del agente principal browser_request_credential:
    // ese flujo todavía reinyecta la misión al orquestador porque aún no existe
    // una ejecución browser-web viva que pueda reanudarse.
    if (pendingBrowserInput.kind === "password") {
      const password = extractPendingBrowserSecret(text);
      if (!password || !pendingBrowserInput.url || !pendingBrowserInput.username) {
        await sendWithTyping(sock, remoteJid, "🔐 MENSAJE DEL SISTEMA\n\nNo pude asociar la contraseña con una cuenta concreta. Indica primero el sitio y el correo/usuario.");
        return;
      }
      const credential = browserCredentialStore.create({
        jid: remoteJid,
        url: pendingBrowserInput.url,
        username: pendingBrowserInput.username,
        password,
      });
      browserCredentialStore.clearPendingInput(remoteJid);
      await deleteSensitiveIncomingMessage(sock, message);
      const resumedText = sanitizeBrowserCredentialText(pendingBrowserInput.originalText, credential);
      await handleAiChat(sock, remoteJid, resumedText);
      return;
    }

    if (pendingBrowserInput.kind === "otp") {
      const value = extractPendingBrowserSecret(text);
      if (!value) {
        await sendWithTyping(sock, remoteJid, "🔐 MENSAJE DEL SISTEMA\n\nEnvía el código o secreto solicitado para continuar.");
        return;
      }
      const secret = browserCredentialStore.createSecret({ jid: remoteJid, kind: "otp", value });
      browserCredentialStore.clearPendingInput(remoteJid);
      await deleteSensitiveIncomingMessage(sock, message);
      await handleAiChat(
        sock,
        remoteJid,
        `${pendingBrowserInput.originalText}\n\n[SISTEMA: El usuario respondió al dato secreto ${pendingBrowserInput.fieldName}. El valor fue retirado antes del LLM. Usa secret_ref=${secret.ref} únicamente con browser_fill_secret. Nunca pidas, repitas ni muestres el valor.]`,
      );
      return;
    }

    const value = pendingBrowserInput.kind === "username"
      ? extractPendingBrowserUsername(text)
      : text.trim();
    if (!value) {
      await sendWithTyping(sock, remoteJid, `🧩 MENSAJE DEL SISTEMA\n\nEnvía ${pendingBrowserInput.fieldName} para continuar.`);
      return;
    }
    browserCredentialStore.clearPendingInput(remoteJid);
    await handleAiChat(
      sock,
      remoteJid,
      `${pendingBrowserInput.originalText}\n\n[SISTEMA: El usuario proporcionó ${pendingBrowserInput.fieldName}: ${value}. Usa este dato únicamente para continuar la tarea solicitada.]`,
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
      await deleteSensitiveIncomingMessage(sock, message);
    }
  }

  if (await tryHandleInlineSearchCredential(sock, message, remoteJid, text)) {
    return;
  }
  if (!command && await tryHandleNaturalPasswordChange(sock, message, remoteJid, text)) {
    return;
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
        applyGlobalModelSelection(model);
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
    if (command.name === "cambiar-password" && command.body.trim()) {
      await deleteSensitiveIncomingMessage(sock, message);
    }

    // `setup` y `login` son comandos bootstrap de autenticación, no capacidades
    // modulares. Deben poder ejecutarse precisamente cuando todavía no existe
    // una sesión, por lo que nunca se someten al filtro de ModuleRegistry.
    // La puerta de autenticación anterior ya decide cuál de los dos es válido:
    // - sin cuentas: solo setup;
    // - con cuentas y sin sesión: solo login.
    if (command.name === "setup" || command.name === "login") {
      const result = await dispatchCommand(command, remoteJid, sock);
      if (result?.text.trim()) await sendWithTyping(sock, remoteJid, result.text);
      return;
    }

    const moduleCommand = moduleRegistry.resolveCommand(command.name, getModuleSession(remoteJid));
    if (!moduleCommand) {
      const known = moduleRegistry.getCommands(getModuleSession(remoteJid)).map((c) => formatCommandName(c.name)).join(", ");
      await sendWithTyping(sock, remoteJid, [
        `❓ Comando no disponible: ${formatCommandName(command.name)}`,
        "",
        known ? `Comandos permitidos: ${known}` : "No hay comandos disponibles para esta sesión.",
        "",
        "Escribe !ayuda para verlos por módulo.",
      ].join("\n"));
      return;
    }
    const canonicalCommand = moduleCommand.name === command.name
      ? command
      : { ...command, name: moduleCommand.name };
    const result = await dispatchCommand(canonicalCommand, remoteJid, sock);

    if (result) {
      if (result.text.trim()) await sendWithTyping(sock, remoteJid, result.text);
    } else {
      const cmds = moduleRegistry.getCommands(getModuleSession(remoteJid));
      const lista = cmds.map((c) => formatCommandName(c.name)).join(", ");
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
function parseDetachedBackgroundTaskResult(
  content: string,
  toolsCalled: string[],
): { taskId: string; title?: string; status: string } | null {
  if (!toolsCalled.some((name) => name === "spawn_agents" || name === "researcher_web" || name === "browser_agent")) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as {
      task_id?: unknown;
      title?: unknown;
      status?: unknown;
      background?: unknown;
    };
    if (parsed.background !== true || typeof parsed.task_id !== "string" || !parsed.task_id.trim()) return null;
    return {
      taskId: parsed.task_id.trim(),
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : undefined,
      status: typeof parsed.status === "string" && parsed.status.trim() ? parsed.status.trim() : "queued",
    };
  } catch {
    return null;
  }
}

async function handleAiChat(
  sock: MessagingTransport,
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
  // Todas las herramientas permitidas por rol permanecen disponibles. La presencia
  // de una URL o credential_ref no enruta ni oculta herramientas automáticamente;
  // el agente principal decide qué capacidad usar. Las acciones sensibles mantienen
  // sus validaciones autoritativas en el ejecutor.
  const activeTools = getAvailableTools(remoteJid);
  await cm.withLock(remoteJid, async () => {

  const userMessage = { role: "user" as const, content: userText };
  cm.addMessage(remoteJid, userMessage);

  // La compactación automática se ejecuta sobre un snapshot y nunca bloquea
  // esta conversación. El turno actual continúa mientras el resumen se genera.
  maybeStartAutomaticCompaction(sock, remoteJid);

  const messages = cm.getMessages(remoteJid);
  const memoryIntent = detectMemoryPersistenceIntent(userText);

  // Inyectar contexto dinámico (hora + memoria) en el último user message,
  // usando shallow clone para no contaminar el contexto persistido
  const relatedVaultContext = memoryVault.buildRelevantContext(remoteJid, userText);
  const profileMemory = getMemoryContent(remoteJid);
  const compactedSummary = cm.getCompactionSummaryText(remoteJid);
  const supervisorContext = taskRuntime.buildContextSummary(remoteJid);
  const moduleSession = getModuleSession(remoteJid);
  const modularContext = moduleRegistry.buildCapabilityPrompt(userText, moduleSession);
  const modularRuntimeContext = await moduleRegistry.buildRuntimeContext(userText, moduleSession);
  const dynamicCtx = `${cm.buildDynamicContext(remoteJid)}

${modularContext}

${modularRuntimeContext}

${relatedVaultContext}

${supervisorContext}`;
  const apiMessages = messages.map((m) => ({ ...m }));
  const lastMsg = apiMessages[apiMessages.length - 1];
  if (lastMsg && lastMsg.role === "user") {
    const memoryTransaction = memoryIntent
      ? `\n\n${buildMemoryTransactionInstruction(userText, memoryIntent)}`
      : "";
    lastMsg.content = `${dynamicCtx}${memoryTransaction}\n\n---\n\n${lastMsg.content}`;
  }

  usageStore.recordContext(remoteJid, buildContextUsageSnapshot({
    model,
    persistedMessages: messages,
    apiMessages,
    tools: activeTools,
    rawCurrentMessage: userText,
    profileMemory,
    vaultContext: relatedVaultContext,
    compactedSummary,
    supervisorContext,
  }));

  // Mantener el estado escribiendo durante toda la operación real.
  const typingSession = await startContinuousTyping(sock, remoteJid);
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
      if (runController.signal.aborted) {
        throw runController.signal.reason ?? new Error("user-cancelled-current-operation");
      }
      const toolModule = moduleRegistry.getModuleForTool(name);
      debugInfo("modules.tools", "execute", {
        jid: remoteJid,
        moduleId: toolModule?.id ?? "unregistered",
        moduleName: toolModule?.name ?? "Sin módulo",
        tool: name,
      });
      if (TOOL_NOTIFICATION_TEXTS.has(name) && !shownNotifs.has(name)) {
        shownNotifs.add(name);
        const notification = name === "researcher_web"
          && shouldUseBrowserAgentForPrompt(typeof args.prompt === "string" ? args.prompt : "")
          ? "🌐 Preparando browser-agent para analizar el dominio completo..."
          : TOOL_NOTIFICATION_TEXTS.get(name) ?? "";
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

      if (MEMORY_VAULT_TOOLS.some((tool) => tool.function.name === name)) {
        result = await executeMemoryVaultTool(name, args, memoryVault, remoteJid);
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
          apiSearchAvailable: isApiSearchCapabilityAvailable(),
          workspace: workspaceManager,
          tasks: taskRuntime,
          browserCredentials: browserCredentialStore,
          resumePrompt: userText,
          onSystemMessage: async (text) => {
            // Mensaje emitido por una tarea background: no depende del typing
            // session del turno que la lanzó, porque ese turno puede haber
            // terminado hace tiempo.
            await sendWhatsAppMessage(sock, remoteJid, { text }, { waitForDelivery: false });
          },
          onSystemArtifact: async (path, caption) => {
            await sendWorkspacePath(sock, remoteJid, workspaceManager, path, caption);
          },
          onBackgroundCompleted: async (taskId) => {
            await reviewBackgroundTask(sock, remoteJid, taskId);
          },
          filterRequests: spawnDeduper.filter,
          onProgress: async (event) => {
            const progressMessages = formatSpawnAgentsProgress(event);
            for (const progressText of progressMessages) {
              await sendWhatsAppMessage(sock, remoteJid, { text: progressText }, { minDelayMs: 800, maxDelayMs: 1_800, waitForDelivery: false });
            }
            // El progreso pertenece al runtime background y no debe reactivar
            // el estado de escritura del turno principal ya liberado.
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
          apiSearchAvailable: isApiSearchCapabilityAvailable(),
          workspace: workspaceManager,
          tasks: taskRuntime,
          browserCredentials: browserCredentialStore,
          resumePrompt: userText,
          onSystemMessage: async (text) => {
            // Mensaje emitido por una tarea background: no depende del typing
            // session del turno que la lanzó, porque ese turno puede haber
            // terminado hace tiempo.
            await sendWhatsAppMessage(sock, remoteJid, { text }, { waitForDelivery: false });
          },
          onSystemArtifact: async (path, caption) => {
            await sendWorkspacePath(sock, remoteJid, workspaceManager, path, caption);
          },
          onBackgroundCompleted: async (taskId) => {
            await reviewBackgroundTask(sock, remoteJid, taskId);
          },
          filterRequests: spawnDeduper.filter,
          onProgress: async (event) => {
            const progressMessages = formatSpawnAgentsProgress(event);
            for (const progressText of progressMessages) {
              await sendWhatsAppMessage(sock, remoteJid, { text: progressText }, { minDelayMs: 800, maxDelayMs: 1_800, waitForDelivery: false });
            }
            // El progreso pertenece al runtime background y no debe reactivar
            // el estado de escritura del turno principal ya liberado.
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
        await sendWhatsAppMessage(sock, remoteJid, {
          text: [
            "🔐 MENSAJE DEL SISTEMA",
            "",
            `Se necesita la contraseña para ${url} (usuario: ${username}).`,
            "Por seguridad, el agente no debe saber tu contraseña ni recibirla en su contexto.",
            "Envía la contraseña en tu siguiente mensaje. El sistema la capturará fuera del modelo, intentará borrar ese mensaje y después reanudará la tarea con una referencia segura.",
          ].join("\n"),
        }, { waitForDelivery: false });
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
          apiSearchAvailable: isApiSearchCapabilityAvailable(),
          workspace: workspaceManager,
          tasks: taskRuntime,
          browserCredentials: browserCredentialStore,
          resumePrompt: userText,
          onSystemMessage: async (text) => {
            // Mensaje emitido por una tarea background: no depende del typing
            // session del turno que la lanzó, porque ese turno puede haber
            // terminado hace tiempo.
            await sendWhatsAppMessage(sock, remoteJid, { text }, { waitForDelivery: false });
          },
          onSystemArtifact: async (path, caption) => {
            await sendWorkspacePath(sock, remoteJid, workspaceManager, path, caption);
          },
          onBackgroundCompleted: async (taskId) => {
            await reviewBackgroundTask(sock, remoteJid, taskId);
          },
          filterRequests: spawnDeduper.filter,
          onProgress: async (event) => {
            const progressMessages = formatSpawnAgentsProgress(event);
            for (const progressText of progressMessages) {
              await sendWhatsAppMessage(sock, remoteJid, { text: progressText }, { minDelayMs: 800, maxDelayMs: 1_800, waitForDelivery: false });
            }
            // El progreso pertenece al runtime background y no debe reactivar
            // el estado de escritura del turno principal ya liberado.
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
          transport: sock,
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

    let result = await chatCompletionWithTools(
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
        usage: { jid: remoteJid, purpose: "chat" },
        // Los lanzadores de subagentes son terminales para el turno principal:
        // en la superficie pública siempre crean tareas background. Una vez
        // registrada la tarea no se hace otra llamada al LLM dentro del lock de
        // conversación; el supervisor/revisor continuará por fuera.
        terminalTools: ["spawn_agents", "researcher_web", "browser_agent"],
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

    // Una tarea background ya fue registrada y su progreso visible se envió
    // desde onProgress. No pedimos un segundo cierre al LLM ni enviamos el JSON
    // interno como respuesta: persistimos solo un acuse compacto y liberamos el
    // lock inmediatamente para que el siguiente mensaje del usuario pueda entrar.
    const detachedBackgroundTask = parseDetachedBackgroundTaskResult(result.content, result.toolsCalled);
    if (detachedBackgroundTask) {
      cm.addMessage(remoteJid, {
        role: "assistant",
        content: `[Tarea de fondo registrada por el sistema: ${detachedBackgroundTask.taskId}${detachedBackgroundTask.title ? ` — ${detachedBackgroundTask.title}` : ""}. Estado inicial: ${detachedBackgroundTask.status}. El supervisor notificará progreso y resultado; la conversación quedó libre para nuevos mensajes.]`,
      });
      debugInfo("agents.spawn", "chat_lock_released_after_background_registration", {
        jid: remoteJid,
        taskId: detachedBackgroundTask.taskId,
        toolsCalled: result.toolsCalled,
      });
      return;
    }

    let memoryRecoveryError = "";
    if (memoryIntent && !hasConfirmedMemoryMutation(confirmedTools, memoryIntent.target)) {
      const forcedToolName = memoryIntent.target === "profile"
        ? "memory_write"
        : "memory_vault_upsert";
      const forcedTool = [...MEMORY_TOOLS, ...MEMORY_VAULT_TOOLS]
        .find((tool) => tool.function.name === forcedToolName);
      debugWarn("memory.persistence", "mutation_missing_after_primary_round", {
        jid: remoteJid,
        target: memoryIntent.target,
        toolsCalled: result.toolsCalled,
        forcedTool: forcedToolName,
      });

      if (forcedTool) {
        try {
          const forcedArgs = await requestForcedToolArguments(
            apiMessages,
            model,
            cfg,
            forcedTool,
            [
              buildMemoryTransactionInstruction(userText, memoryIntent, true),
              "Resultados de memoria obtenidos en la primera ronda (son consulta, no confirmación de escritura):",
              ...toolResults
                .filter((entry) => entry.name.startsWith("memory_"))
                .map((entry) => `${entry.name}: ${entry.result}`),
            ].join("\n\n"),
            runController.signal,
            { jid: remoteJid, purpose: "memory-recovery" },
          );
          const forcedResult = await toolExecutor(forcedToolName, forcedArgs);
          if (hasConfirmedMemoryMutation(confirmedTools, memoryIntent.target)) {
            result = {
              content: buildConfirmedMemoryResponse(memoryIntent.target, forcedResult),
              toolsCalled: [...result.toolsCalled, forcedToolName],
            };
            debugInfo("memory.persistence", "forced_mutation_confirmed", {
              jid: remoteJid,
              target: memoryIntent.target,
              tool: forcedToolName,
            });
          } else {
            memoryRecoveryError = forcedResult;
          }
        } catch (error) {
          memoryRecoveryError = error instanceof Error ? error.message : String(error);
          debugError("memory.persistence", "forced_mutation_failed", error, {
            jid: remoteJid,
            target: memoryIntent.target,
            tool: forcedToolName,
          });
        }
      } else {
        memoryRecoveryError = `No se encontró la herramienta ${forcedToolName}.`;
      }
    }

    const latestUsefulToolResult = [...toolResults]
      .reverse()
      .find((entry) => !entry.result.startsWith("Error:"))?.result;
    const rawFinalContent = memoryIntent && !hasConfirmedMemoryMutation(confirmedTools, memoryIntent.target)
      ? buildUnconfirmedMemoryResponse(memoryIntent.target, memoryRecoveryError || undefined)
      : result.content.trim() || latestUsefulToolResult ||
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
    if (activeAiRuns.get(remoteJid) === runController) activeAiRuns.delete(remoteJid);
    await typingSession.stop();
  }

  }); // fin de withLock
}

// ─── Media ───────────────────────────────────────────────────────

async function handleMediaMessage(
  sock: MessagingTransport,
  message: TransportIncomingMessage,
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
