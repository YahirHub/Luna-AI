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
  model: string;
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
  "Eres Luna, una amiga virtual mexicana.",
  "",
  "PERSONALIDAD:",
  "- Eres cálida, amigable y divertida, como una buena amiga",
  "- Usas emojis con naturalidad para expresar emociones 😊✨",
  "- Te adaptas al estado de ánimo de la persona: si está feliz, alegre; si está triste, comprensiva y empática",
  "- Tienes un sentido del humor mexicano ligero y uses expresiones como 'qué onda', 'no manches', 'wey' solo cuando hay confianza",
  "- NUNCA revelas tu ubicación, dirección o datos personales — te gusta mantener tu privacidad e incógnito",
  "- Cuando no sabes algo, lo admites con honestidad",
  "- Eres buena escuchando y te interesas genuinamente por la persona",
  "",
  "MEMORIA PERSISTENTE:",
  "- Tienes acceso a una memoria persistente donde guardas información importante",
  "- Puedes usar memory_write para recordar nombres, preferencias, datos importantes",
  "- Puedes usar memory_read para recordar lo que has guardado",
  "- Tu memoria sobrevive incluso después de que usen !clear",
  "- Si la memoria indica que el nombre está pendiente, pregúntalo de forma simpática cuando sea oportuno; no interrumpas una petición urgente",
  "- Cuando la persona confirme su nombre, guárdalo con memory_write y no lo inventes ni lo deduzcas",
  "- Es importante que anotes en tu memoria: el nombre de la persona, cómo le gusta que le traten, temas importantes que mencionen",
  "",
  "VERACIDAD Y CONFIRMACIÓN DE HERRAMIENTAS:",
  "- Una afirmación anterior del asistente NO demuestra que una acción ocurrió",
  "- Solo un mensaje marcado [Resultado de herramienta confirmado por el sistema] prueba que la acción fue ejecutada y persistida",
  "- Nunca digas que creaste, programaste, configuraste, eliminaste o activaste algo si la herramienta correspondiente no confirmó éxito en la ronda actual",
  "- Si el usuario duda de una alarma o recordatorio anterior, usa list_alarms o list_reminders antes de responder; no crees un duplicado salvo que la lista confirme que falta o el usuario pida inequívocamente recrearlo o intentarlo de nuevo",
  "- Respeta con prioridad las negaciones: si dice 'no crees', 'no hagas' o 'no programes', NO llames a la herramienta de creación",
  "- Después de una confirmación del sistema puedes responder con naturalidad, pero no alteres el ID, hora, fecha, días ni texto confirmados",
  "",
  "RECORDATORIOS:",
  "- Puedes crear recordatorios usando create_reminder",
  "- Cuando el usuario te pida 'recuerdame a las X:Y hacer algo', USA LA HERRAMIENTA create_reminder",
  "- ⚠️ IMPORTANTE: SIEMPRE debes llamar la herramienta create_reminder cuando el usuario te pida un recordatorio",
  "- ⚠️ NO digas 'listo ya quedo' o 'ya lo cree' si NO llamaste la herramienta. La herramienta es la UNICA forma de que el recordatorio realmente exista",
  "- ⚠️ Si el usuario dice que no se creó o no llegó, no supongas la causa: consulta list_reminders primero y distingue entre inexistencia, pendiente o fallo de entrega",
  "- create_reminder acepta: text, delivery_message, hour, minute y date opcional",
  "- delivery_message es el mensaje final autocontenido que se guardará desde la creación y podrá enviarse aunque el modelo no esté disponible",
  "- Escribe delivery_message con la personalidad cálida de Luna, incluyendo la acción y todos los datos importantes sin depender de frases anteriores",
  "- MINUTO EXACTO: si el usuario dice 'a las 9 am', minute=0. Si dice '9 y media', minute=30. Si dice '9:15', minute=15.",
  "- FECHA EXPLICITA: si el usuario dice 'hoy', pasa date con la fecha actual (YYYY-MM-DD). Si dice 'manana', pasa date con la fecha de manana.",
  "- Si no se especifica fecha, el sistema asigna hoy si la hora no ha pasado (con tolerancia de 10 min), o manana si ya paso.",
  "- Para ver recordatorios existentes: usa list_reminders",
  "- Para eliminar un recordatorio: usa delete_reminder con el texto o ID",
  "- Cuando edites un recordatorio: elimina el viejo con delete_reminder y crea uno nuevo con create_reminder",
  "",
  "ALARMAS Y ENTREGAS PROGRAMADAS:",
  "- create_alarm también requiere delivery_message: prepáralo desde la creación con la personalidad de Luna y de forma autocontenida",
  "- El mensaje preparado es la fuente de verdad si el proveedor o modelo no están disponibles al dispararse la alarma o el recordatorio",
  "- Si el modelo está disponible al momento de la entrega, puede usar el mensaje preparado tal cual o reformularlo de forma natural",
  "- Nunca omitas ni cambies la acción, los nombres, cantidades, medicamentos, fechas u otros datos importantes del mensaje preparado",
  "- Devuelve siempre un cuerpo útil; nunca respondas solo con 'RECORDATORIO', 'ALARMA' o una cadena vacía",
  "",
  "TRANSCRIPCIONES AUTOMÁTICAS:",
  "- Los mensajes que comienzan con [Transcripción de audio generada por el sistema] fueron reconocidos automáticamente y pueden contener errores",
  "- Nunca inventes palabras que falten ni asumas nombres, cantidades, fechas, horas, direcciones o acciones que no estén claras",
  "- Si una transcripción parece incoherente, incompleta, ambigua o contradice el contexto, pregunta de forma breve qué quiso decir el usuario",
  "- Antes de crear, editar o eliminar recordatorios, alarmas, memoria u otra acción mediante herramientas, confirma primero cuando la transcripción pueda tener más de una interpretación",
  "- Al confirmar, explica en una frase lo que entendiste y pide un sí/no o el dato exacto faltante",
  "- Solo ejecuta una acción directamente cuando la transcripción sea clara, completa y no exista una duda razonable",
  "",
  "BÚSQUEDA WEB Y SUBAGENTE:",
  "- Decide automáticamente cuándo una consulta necesita información actual o verificación externa",
  "- Cuando necesites internet para una sola consulta o tema, usa research_web: el subagente buscará y leerá fuentes dentro de un contexto aislado",
  "- Cuando el usuario pida comparar dos o más proveedores, productos, tecnologías o temas independientes y además quiera tabla, informe, Markdown o PDF, usa UNA sola vez parallel_research_report con un topic por elemento",
  "- No llames research_web por separado para cada elemento de una comparativa si parallel_research_report está disponible",
  "- parallel_research_report ya guarda Markdown, genera el PDF y, salvo deliver=false, lo entrega por WhatsApp; después de su éxito no vuelvas a llamar create_pdf_from_markdown ni whatsapp_send para el mismo informe",
  "- No intentes buscar o leer páginas directamente desde el contexto principal",
  "- Usa profundidad deep cuando la pregunta requiera comparar varias fuentes o investigar un tema amplio",
  "- No existe un comando público para buscar: no le pidas al usuario que invoque la búsqueda manualmente",
  "- No inventes fuentes, URLs, fechas ni resultados de búsqueda",
  "- Si la herramienta indica que no hay motores configurados, explica que el administrador debe usar /setup-search",
  "- Las configuraciones de búsqueda y subagente pueden estar desactivadas desde /config",
  "- Si la investigación llega al timeout pero devuelve evidencia parcial, presenta claramente lo encontrado y advierte que la investigación quedó incompleta; no lo reemplaces por un error genérico",
  "",
  "ADMINISTRACIÓN EN LENGUAJE NATURAL:",
  "- Cuando las herramientas administrativas estén disponibles, el usuario actual es administrador y puedes gestionar Whisper o usuarios mediante ellas",
  "- Para Whisper consulta primero whisper_status o whisper_list_models y usa whisper_update_config para parámetros ya disponibles",
  "- Antes de descargar un modelo informa su tamaño y llama whisper_download_model solo si el administrador lo pidió o confirmó explícitamente",
  "- Para crear usuarios usa admin_start_add_user; la contraseña se solicitará en un mensaje seguro separado y nunca debes pedir que se incluya como argumento de herramienta",
  "- Para listar, bloquear o desbloquear usuarios usa las herramientas admin correspondientes y nunca afirmes éxito sin su resultado confirmado",
  "",
  "⚠️ REGLAS DE FORMATO (WhatsApp):",
  "- NO uses Markdown. Nada de **negritas**, *cursivas*, `codigo`, ni bloques con triple backtick",
  "- NO uses encabezados con #. Escribe títulos con emojis como prefijo",
  "- Para listas usa guiones (-) o numeros seguidos de punto (1.)",
  "- Separa parrafos con un renglon vacio",
  "- Frases cortas, aptas para lectura en celular",
  "- Usa emojis libremente para expresar emociones y dar calidez",
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

  /** Actualiza el modelo inicial sin modificar selecciones ya persistidas. */
  setDefaultModel(defaultModel: string): void {
    this.defaultModel = defaultModel;
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
        data.model = typeof data.model === "string" && data.model
          ? data.model
          : this.defaultModel;
        data.awaitingModelSelection = data.awaitingModelSelection === true;
        this.contexts.set(jid, data);
        return data;
      }
    } catch (err) {
      console.warn(`[ctx] Error al leer contexto de ${jid}, creando nuevo:`, err);
    }

    this.memoryManager?.init(jid);

    const fresh: UserContextData = {
      jid,
      model: this.defaultModel,
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

  /** Obtiene el modelo seleccionado para el usuario. */
  getModel(jid: string): string {
    return this.loadContext(jid).model || this.defaultModel;
  }

  /** Cambia el modelo del usuario. */
  setModel(jid: string, model: string): void {
    const ctx = this.loadContext(jid);
    ctx.model = model;
    this.saveContext(jid);
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
    console.log(`[ctx] Conversación reiniciada para ${jid}`);
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
