import { debugInfo, debugWarn } from "./debug.ts";
import { join } from "node:path";
import type { ChatMessage } from "./ai.ts";
import { getAppDir, getMexicoCityNow } from "./utils.ts";
import type { MemoryManager } from "./memory.ts";
import type { CompactionMetadata } from "./compaction.ts";
import { summaryToTextBlock } from "./compaction.ts";
import {
  readJsonFile,
  sanitizePathSegment,
  writeJsonFileAtomically,
} from "./storage.ts";

export const CONTEXTS_DIR = join(getAppDir(), "persistent", "contexts");

/** Datos persistidos por usuario. */
interface UserContextData {
  jid: string;
  model?: string;
  messages: ChatMessage[];
  awaitingModelSelection: boolean;
  /** Metadatos de compactación (undefined si nunca se ha compactado). */
  compaction?: CompactionMetadata;
}

const VALID_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

function normalizePersistedMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.role !== "string" || !VALID_MESSAGE_ROLES.has(raw.role)) {
    return null;
  }

  const role = raw.role as ChatMessage["role"];
  const toolCalls = Array.isArray(raw.tool_calls)
    ? raw.tool_calls.filter((call) => {
        if (!call || typeof call !== "object") return false;
        const candidate = call as Record<string, unknown>;
        const fn = candidate.function as Record<string, unknown> | undefined;
        return (
          typeof candidate.id === "string" &&
          candidate.type === "function" &&
          fn != null &&
          typeof fn.name === "string" &&
          typeof fn.arguments === "string"
        );
      }) as ChatMessage["tool_calls"]
    : undefined;

  const content = typeof raw.content === "string"
    ? raw.content
    : role === "assistant" && toolCalls?.length
      ? ""
      : null;
  if (content === null) return null;

  if (role === "tool" && typeof raw.tool_call_id !== "string") {
    return null;
  }

  return {
    role,
    content,
    ...(typeof raw.tool_call_id === "string"
      ? { tool_call_id: raw.tool_call_id }
      : {}),
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
  };
}

/** Retorna la hora actual en CDMX formateada legible. */
export function getMexicoCityTime(): string {
  return getMexicoCityNow().text;
}

/** System prompt ESTÁTICO — nunca cambia, para que el proveedor pueda cachearlo. */
export const STATIC_SYSTEM_PROMPT_CONTENT = [
  "Eres Luna, una amiga virtual mexicana y el orquestador principal del sistema.",
  "",
  "PERSONALIDAD:",
  "- Eres cálida, amigable y divertida, como una buena amiga",
  "- Usas emojis con naturalidad para expresar emociones 😊✨",
  "- Te adaptas al estado de ánimo de la persona y mantienes honestidad cuando no sabes algo",
  "- Puedes usar expresiones mexicanas ligeras cuando exista confianza, sin forzarlas",
  "- Nunca revelas ubicación, dirección, secretos internos ni credenciales",
  "",
  "ARQUITECTURA MODULAR:",
  "- Las capacidades disponibles y las instrucciones específicas de cada módulo se adjuntan dinámicamente al mensaje del usuario",
  "- Usa únicamente tools presentes en la solicitud actual; una tool ausente no está autorizada para esta sesión",
  "- Todas las capacidades normales requieren una sesión autenticada. Las capacidades administrativas solo aparecen para administradores autenticados",
  "- No inventes comandos, tools, módulos ni permisos que no aparezcan en el contexto modular",
  "",
  "VERACIDAD Y CONFIRMACIÓN DE HERRAMIENTAS:",
  "- Una afirmación anterior del asistente no demuestra que una acción ocurrió",
  "- Solo un resultado confirmado de herramienta demuestra que una acción persistente fue ejecutada",
  "- Nunca digas que creaste, guardaste, configuraste, eliminaste, enviaste o activaste algo si la herramienta correspondiente no confirmó éxito",
  "- Respeta con prioridad las negaciones del usuario: si dice no crear, no guardar, no enviar o no programar, no ejecutes esa mutación",
  "- No inventes fuentes, URLs, fechas, archivos, estados de tareas ni resultados de herramientas",
  "",
  "ADJUNTOS Y TRANSCRIPCIONES BAJO DEMANDA:",
  "- Un bloque [ADJUNTO DISPONIBLE — NO DESCARGADO AUTOMÁTICAMENTE] contiene solo metadata; no implica que conozcas el contenido del archivo",
  "- Decide si necesitas descargar o inspeccionar el adjunto mediante las tools autorizadas; si no es necesario, responde sin descargarlo",
  "- Los resultados de attachment_ocr y attachment_transcribe_audio pueden contener errores de reconocimiento",
  "- No inventes nombres, cantidades, fechas, horas, direcciones o acciones ausentes",
  "- Si una ambigüedad en OCR/transcripción puede cambiar una acción persistente o destructiva, pide una aclaración breve antes de ejecutarla",
  "- Cuando el usuario corrija o reformule una transcripción, la versión más reciente sustituye a la anterior",
  "",
  "ORQUESTACIÓN:",
  "- Los estados autoritativos del sistema y de las tools tienen prioridad sobre tus inferencias",
  "- Cuando una tarea delegada produzca archivos o resultados, revísalos antes de afirmar que se completó la solicitud global",
  "- No bloquees el chat esperando trabajos de fondo cuando el sistema ya los ejecuta de forma asíncrona",
  "",
  "⚠️ REGLAS DE FORMATO (WhatsApp):",
  "- No uses Markdown en respuestas normales de WhatsApp: nada de encabezados #, triple backtick ni sintaxis decorativa",
  "- Para listas usa guiones o números seguidos de punto",
  "- Separa párrafos con un renglón vacío y usa frases fáciles de leer en celular",
  "- Usa emojis con naturalidad, no como sustituto de información",
].join("\n");

/** System prompt estático — nunca cambia. */
function buildSystemPrompt(): ChatMessage {
  return {
    role: "system",
    content: STATIC_SYSTEM_PROMPT_CONTENT,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function contextFilePath(jid: string): string {
  return join(CONTEXTS_DIR, sanitizePathSegment(jid), "context.json");
}

/** Ruta al archivo memory.md de un usuario. */
export function getMemoryPath(jid: string): string {
  return join(CONTEXTS_DIR, sanitizePathSegment(jid), "memory.md");
}

// ─── Gestor de contextos ─────────────────────────────────────────

export class ContextManager {
  private contexts = new Map<string, UserContextData>();
  private defaultModel: string;
  private memoryManager: MemoryManager | null = null;
  /** Locks por JID para evitar condiciones de carrera. */
  private locks = new Map<string, Promise<void>>();

  constructor(defaultModel: string) {
    this.defaultModel = defaultModel;
  }

  /** Actualiza el único modelo global usado por todos los contextos. */
  setGlobalModel(defaultModel: string): void {
    this.defaultModel = defaultModel;
    for (const [jid, context] of this.contexts) {
      delete context.model;
      this.saveContext(jid);
    }
  }

  /** Alias conservado para compatibilidad interna. */
  setDefaultModel(defaultModel: string): void {
    this.setGlobalModel(defaultModel);
  }

  /**
   * Ejecuta una operación asíncrona con lock exclusivo por JID.
   * Garantiza que dos procesos no lean-modifiquen-escriban el mismo
   * contexto simultáneamente.
   */
  async withLock<T>(jid: string, fn: () => Promise<T>): Promise<T> {
    // Esperar el lock anterior si existe
    const prev = this.locks.get(jid) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(jid, next);

    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.locks.get(jid) === next) {
        this.locks.delete(jid);
      }
    }
  }

  /** Asigna el MemoryManager para inyectar memoria en los system prompts. */
  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
  }

  /** Obtiene el contenido de memoria de un usuario específico. */
  private getMemoryContent(jid: string): string {
    try {
      return this.memoryManager?.getContent(jid) ?? "";
    } catch {
      return "";
    }
  }

  /** Construye el system prompt estático (sin datos dinámicos). */
  private makeSystemPrompt(): ChatMessage {
    return buildSystemPrompt();
  }

  /**
   * Construye el contexto dinámico (hora actual + memoria + resumen compactado)
   * para inyectar en el último user message antes de enviarlo a la API, sin alterar
   * el contexto persistido en disco.
   */
  buildDynamicContext(jid: string): string {
    const timeStr = getMexicoCityTime();
    const memory = this.getMemoryContent(jid);
    const parts: string[] = [timeStr];
    if (memory && memory.trim()) {
      parts.push("", "=== LO QUE RECUERDO ===", memory.trim(), "=== FIN DE MI MEMORIA ===");
    }
    // Incluir resumen compactado si existe
    const summary = this.getCompactionSummaryText(jid);
    if (summary) {
      parts.push("", summary);
    }
    return parts.join("\n");
  }

  /** Carga el contexto desde disco o crea uno nuevo. */
  loadContext(jid: string): UserContextData {
    const cached = this.contexts.get(jid);
    if (cached) {
      return cached;
    }

    try {
      const data = readJsonFile<UserContextData>(contextFilePath(jid));
      if (data && Array.isArray(data.messages)) {
        data.messages = data.messages
          .map(normalizePersistedMessage)
          .filter((message): message is ChatMessage => message !== null);
        this.memoryManager?.init(jid);
        const systemIdx = data.messages.findIndex((message) => message.role === "system");
        if (systemIdx >= 0) {
          data.messages[systemIdx] = this.makeSystemPrompt();
        } else {
          data.messages.unshift(this.makeSystemPrompt());
        }
        data.jid = jid;
        const hadLegacyModel = typeof data.model === "string" && Boolean(data.model);
        delete data.model;
        data.awaitingModelSelection = data.awaitingModelSelection === true;
        this.contexts.set(jid, data);
        if (hadLegacyModel) this.saveContext(jid);
        return data;
      }
    } catch (err) {
      debugWarn("context", "load_failed_new_context", { jid, error: err instanceof Error ? err.message : String(err) });
    }

    this.memoryManager?.init(jid);

    const fresh: UserContextData = {
      jid,
      messages: [this.makeSystemPrompt()],
      awaitingModelSelection: false,
    };
    this.contexts.set(jid, fresh);
    return fresh;
  }

  /** Guarda el contexto con reemplazo atómico. */
  saveContext(jid: string): void {
    const context = this.contexts.get(jid);
    if (!context) return;
    writeJsonFileAtomically(contextFilePath(jid), context);
  }

  /** Alias conservado para compatibilidad con el flujo de compactación. */
  saveContextAtomically(jid: string): void {
    this.saveContext(jid);
  }

  /**
   * Añade un mensaje al contexto y guarda.
   * NOTA: La compactación se maneja externamente desde bot.ts.
   * addMessage solo persiste el mensaje.
   */
  addMessage(jid: string, message: ChatMessage): void {
    this.addMessages(jid, [message]);
  }

  /** Añade varios mensajes y los persiste en una sola escritura. */
  addMessages(jid: string, messages: ChatMessage[]): void {
    if (messages.length === 0) return;
    const ctx = this.loadContext(jid);
    const previousLength = ctx.messages.length;
    ctx.messages.push(...messages);
    try {
      this.saveContextAtomically(jid);
    } catch (error) {
      ctx.messages.splice(previousLength);
      throw error;
    }
  }

  /** Obtiene los mensajes del contexto. */
  getMessages(jid: string): ChatMessage[] {
    return this.loadContext(jid).messages;
  }

  /** Obtiene el único modelo global activo. */
  getModel(_jid: string): string {
    return this.defaultModel;
  }

  /** Cambia el modelo global; el JID se ignora por compatibilidad. */
  setModel(_jid: string, model: string): void {
    this.setGlobalModel(model);
  }

  /** Marca al usuario como esperando selección de modelo. */
  setAwaitingModelSelection(jid: string): void {
    const ctx = this.loadContext(jid);
    ctx.awaitingModelSelection = true;
    this.saveContext(jid);
  }

  /** Verifica si el usuario está esperando selección de modelo. */
  isAwaitingModelSelection(jid: string): boolean {
    return this.loadContext(jid).awaitingModelSelection;
  }

  /** Limpia el estado de espera de selección. */
  clearAwaitingModelSelection(jid: string): void {
    const ctx = this.loadContext(jid);
    ctx.awaitingModelSelection = false;
    this.saveContext(jid);
  }

  /**
   * Reinicia la conversación: borra mensajes pero conserva
   * el system prompt estático (la memoria se inyecta dinámicamente).
   * También resetea la compactación.
   */
  clearConversation(jid: string): void {
    const ctx = this.loadContext(jid);
    ctx.messages = [this.makeSystemPrompt()];
    ctx.compaction = undefined;
    this.saveContext(jid);
    debugInfo("context", "conversation_cleared", { jid });
  }

  /**
   * Almacena el resultado de una compactación en el contexto del usuario.
   * Reemplaza los mensajes antiguos por el system prompt + los mensajes recientes.
   */
  applyCompaction(
    jid: string,
    messagesToKeep: ChatMessage[],
    summary: import("./compaction.ts").CompactedSummary,
    tokensBefore: number,
    tokensAfter: number,
    compactedCount: number,
  ): void {
    const ctx = this.loadContext(jid);

    const prev = ctx.compaction;
    ctx.messages = messagesToKeep;
    ctx.compaction = {
      version: 1,
      count: (prev?.count ?? 0) + 1,
      summary,
      lastCompactedAt: new Date().toISOString(),
      messagesCompacted: (prev?.messagesCompacted ?? 0) + compactedCount,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensAfter,
    };

    this.saveContextAtomically(jid);
  }

  /**
   * Aplica una compactación generada desde un snapshot sin perder mensajes que
   * hayan llegado mientras el LLM resumía. Si el prefijo cambió por !clear u
   * otra compactación, rechaza el resultado como obsoleto.
   */
  applyCompactionSnapshot(
    jid: string,
    snapshotMessages: ChatMessage[],
    messagesToKeep: ChatMessage[],
    summary: import("./compaction.ts").CompactedSummary,
    tokensBefore: number,
    compactedCount: number,
    estimateTokens: (messages: ChatMessage[]) => number,
  ): { applied: boolean; tokensAfter: number; appendedMessages: number } {
    const ctx = this.loadContext(jid);
    if (ctx.messages.length < snapshotMessages.length) {
      return { applied: false, tokensAfter: estimateTokens(ctx.messages), appendedMessages: 0 };
    }
    for (let index = 0; index < snapshotMessages.length; index++) {
      if (JSON.stringify(ctx.messages[index]) !== JSON.stringify(snapshotMessages[index])) {
        return { applied: false, tokensAfter: estimateTokens(ctx.messages), appendedMessages: 0 };
      }
    }

    const appended = ctx.messages.slice(snapshotMessages.length);
    const merged = [...messagesToKeep, ...appended];
    const tokensAfter = estimateTokens(merged);
    const prev = ctx.compaction;
    ctx.messages = merged;
    ctx.compaction = {
      version: 1,
      count: (prev?.count ?? 0) + 1,
      summary,
      lastCompactedAt: new Date().toISOString(),
      messagesCompacted: (prev?.messagesCompacted ?? 0) + compactedCount,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensAfter,
    };
    this.saveContextAtomically(jid);
    return { applied: true, tokensAfter, appendedMessages: appended.length };
  }

  /** Retorna los metadatos completos de compactación, o null. */
  getCompactionMetadata(jid: string): CompactionMetadata | null {
    const value = this.loadContext(jid).compaction;
    return value ? structuredClone(value) : null;
  }

  /** Retorna el resumen compactado del usuario, o null si nunca se compactó. */
  getCompactionSummary(jid: string): import("./compaction.ts").CompactedSummary | null {
    return this.loadContext(jid).compaction?.summary ?? null;
  }

  /** Retorna el resumen compactado como texto legible, o string vacío. */
  getCompactionSummaryText(jid: string): string {
    try {
      const summary = this.getCompactionSummary(jid);
      if (!summary) return "";
      return summaryToTextBlock(summary);
    } catch {
      return "";
    }
  }
}
