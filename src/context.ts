import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "./ai.ts";
import { estimateTokens } from "./ai.ts";
import { getAppDir } from "./utils.ts";
import type { MemoryManager } from "./memory.ts";

export const CONTEXTS_DIR = join(getAppDir(), "persistent", "contexts");

/** Datos persistidos por usuario. */
interface UserContextData {
  jid: string;
  model: string;
  messages: ChatMessage[];
  awaitingModelSelection: boolean;
}

/** Límite de tokens antes de compactar. */
const MAX_TOKENS = 100_000;

/** Fracción de mensajes recientes a conservar (último 25%). */
const KEEP_RECENT_FRACTION = 0.25;

/** Retorna la hora actual en CDMX formateada legible. */
export function getMexicoCityTime(): string {
  const now = new Date();
  const datePart = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);

  const timePart = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

  return `Hoy es ${datePart}. Son las ${timePart} (hora Ciudad de Mexico, America/Mexico_City).`;
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
  "- Es importante que anotes en tu memoria: el nombre de la persona, cómo le gusta que le traten, temas importantes que mencionen",
  "",
  "RECORDATORIOS:",
  "- Puedes crear recordatorios usando create_reminder",
  "- Cuando el usuario te pida 'recuerdame a las X:Y hacer algo', USA LA HERRAMIENTA create_reminder",
  "- ⚠️ IMPORTANTE: SIEMPRE debes llamar la herramienta create_reminder cuando el usuario te pida un recordatorio",
  "- ⚠️ NO digas 'listo ya quedo' o 'ya lo cree' si NO llamaste la herramienta. La herramienta es la UNICA forma de que el recordatorio realmente exista",
  "- ⚠️ Si el usuario te dice que no le llego el recordatorio, es porque NO llamaste la herramienta la primera vez",
  "- create_reminder acepta: text (obligatorio), hour (0-23, obligatorio), minute (0-59, obligatorio), date (opcional, YYYY-MM-DD)",
  "- MINUTO EXACTO: si el usuario dice 'a las 9 am', minute=0. Si dice '9 y media', minute=30. Si dice '9:15', minute=15.",
  "- FECHA EXPLICITA: si el usuario dice 'hoy', pasa date con la fecha actual (YYYY-MM-DD). Si dice 'manana', pasa date con la fecha de manana.",
  "- Si no se especifica fecha, el sistema asigna hoy si la hora no ha pasado (con tolerancia de 10 min), o manana si ya paso.",
  "- Para ver recordatorios existentes: usa list_reminders",
  "- Para eliminar un recordatorio: usa delete_reminder con el texto o ID",
  "- Cuando edites un recordatorio: elimina el viejo con delete_reminder y crea uno nuevo con create_reminder",
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

function safeJid(jid: string): string {
  return jid.replace(/[^a-zA-Z0-9@._-]/g, "_");
}

function contextFilePath(jid: string): string {
  return join(CONTEXTS_DIR, safeJid(jid), "context.json");
}

/** Ruta al archivo memory.md de un usuario. */
export function getMemoryPath(jid: string): string {
  return join(CONTEXTS_DIR, safeJid(jid), "memory.md");
}

function ensureUserDir(jid: string): void {
  const dir = join(CONTEXTS_DIR, safeJid(jid));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function ensureContextsDir(): void {
  if (!existsSync(CONTEXTS_DIR)) {
    mkdirSync(CONTEXTS_DIR, { recursive: true });
  }
}

// ─── Gestor de contextos ─────────────────────────────────────────

export class ContextManager {
  private contexts = new Map<string, UserContextData>();
  private defaultModel: string;
  private memoryManager: MemoryManager | null = null;

  constructor(defaultModel: string) {
    this.defaultModel = defaultModel;
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

  /** Actualiza el modelo por defecto sin crear nueva instancia. */
  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  /** Construye el system prompt estático (sin datos dinámicos). */
  private makeSystemPrompt(): ChatMessage {
    return buildSystemPrompt();
  }

  /**
   * Construye el contexto dinámico (hora actual + memoria) para inyectar
   * en el último user message antes de enviarlo a la API, sin alterar
   * el contexto persistido en disco.
   */
  buildDynamicContext(jid: string): string {
    const timeStr = getMexicoCityTime();
    const memory = this.getMemoryContent(jid);
    const parts: string[] = [timeStr];
    if (memory && memory.trim()) {
      parts.push("", "=== LO QUE RECUERDO ===", memory.trim(), "=== FIN DE MI MEMORIA ===");
    }
    return parts.join("\n");
  }

  /** Carga el contexto desde disco o crea uno nuevo. */
  loadContext(jid: string): UserContextData {
    const cached = this.contexts.get(jid);
    if (cached) {
      return cached;
    }

    ensureContextsDir();
    const path = contextFilePath(jid);

    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const data = JSON.parse(raw) as UserContextData;
        // Asegurar que existe el directorio y memory.md del usuario
        ensureUserDir(jid);
        this.memoryManager?.init(jid);
        // Asegurar que el system prompt es el estático
        const systemIdx = data.messages.findIndex((m) => m.role === "system");
        if (systemIdx >= 0) {
          data.messages[systemIdx] = this.makeSystemPrompt();
        } else {
          data.messages.unshift(this.makeSystemPrompt());
        }
        this.contexts.set(jid, data);
        return data;
      } catch {
        console.warn(`[ctx] Error al leer contexto de ${jid}, creando nuevo`);
      }
    }

    // Crear directorio y memoria del usuario
    ensureUserDir(jid);
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

  /** Guarda el contexto a disco. */
  saveContext(jid: string): void {
    const ctx = this.contexts.get(jid);
    if (!ctx) {
      return;
    }
    ensureUserDir(jid);
    try {
      writeFileSync(contextFilePath(jid), JSON.stringify(ctx, null, 2), "utf-8");
    } catch (err) {
      console.error(`[ctx] Error al guardar contexto de ${jid}:`, err);
    }
  }

  /** Añade un mensaje al contexto y guarda. Compacta si es necesario. */
  addMessage(jid: string, message: ChatMessage): void {
    const ctx = this.loadContext(jid);
    ctx.messages.push(message);

    const tokens = estimateTokens(ctx.messages);
    if (tokens > MAX_TOKENS) {
      this.compactContext(jid);
    }

    this.saveContext(jid);
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
   */
  clearConversation(jid: string): void {
    const ctx = this.loadContext(jid);
    ctx.messages = [this.makeSystemPrompt()];
    this.saveContext(jid);
    console.log(`[ctx] Conversación reiniciada para ${jid}`);
  }

  /** Compacta el contexto: resume mensajes antiguos y conserva los recientes. */
  private compactContext(jid: string): void {
    const ctx = this.loadContext(jid);
    const messages = ctx.messages;

    if (messages.length <= 2) {
      return;
    }

    const systemMsg = messages[0];
    if (!systemMsg || systemMsg.role !== "system") {
      return;
    }

    const nonSystem = messages.slice(1);
    const keepCount = Math.max(2, Math.ceil(nonSystem.length * KEEP_RECENT_FRACTION));
    const toCompact = nonSystem.slice(0, nonSystem.length - keepCount);
    const recent = nonSystem.slice(nonSystem.length - keepCount);

    if (toCompact.length === 0) {
      return;
    }

    const summaryLines: string[] = [];
    for (const msg of toCompact) {
      const role = msg.role === "user" ? "Usuario" : "Asistente";
      const preview = msg.content.slice(0, 200).replace(/\n/g, " ");
      summaryLines.push(`${role}: ${preview}${msg.content.length > 200 ? "..." : ""}`);
    }

    const compactSummary =
      `[Resumen de la conversación anterior]\n${summaryLines.join("\n")}\n` +
      `[Fin del resumen. Continúa la conversación reciente:]`;

    ctx.messages = [
      systemMsg,
      { role: "user" as const, content: compactSummary },
      ...recent,
    ];

    const newTokens = estimateTokens(ctx.messages);
    console.log(
      `[ctx] Contexto compactado para ${jid}: ` +
      `${messages.length} → ${ctx.messages.length} mensajes, ` +
      `~${newTokens} tokens`,
    );
  }
}
