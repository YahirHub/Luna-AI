import { join } from "node:path";
import { getAppDir, getMexicoCityNow, isValidYmdDate } from "./utils.ts";
import { readJsonFile, writeJsonFileAtomically } from "./storage.ts";
import type { WASocket } from "@whiskeysockets/baileys";
import {
  buildReminderDeliveryMessage,
  normalizePreparedScheduledMessage,
} from "./scheduled-copy.ts";

// ─── Types ───────────────────────────────────────────────────────

export interface Reminder {
  id: string;
  jid: string;
  text: string;
  /** Cuerpo autocontenido preparado al crear el recordatorio. */
  deliveryMessage: string;
  hour: number;
  minute: number;
  /** Fecha en formato YYYY-MM-DD. Si es "any", se registró sin fecha fija. */
  date: string;
  createdAt: string;
  fired: boolean;
  /** Se activa antes de enviar para poder reintentar tras fallos o reinicios. */
  deliveryPending?: boolean;
}

/** Formato del archivo reminders.json. */
interface RemindersFile {
  reminders: Reminder[];
}

// ─── ReminderManager ─────────────────────────────────────────────

export class ReminderManager {
  private reminders: Reminder[] = [];
  private readonly filePath: string;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private sock: WASocket | null = null;
  private checking = false;

  constructor(testPath?: string) {
    this.filePath = testPath ?? join(getAppDir(), "persistent", "reminders.json");
    this.load();
  }

  // ── Persistencia ─────────────────────────────────────────────

  private load(): void {
    try {
      const data = readJsonFile<RemindersFile>(this.filePath);
      const stored = Array.isArray(data?.reminders) ? data.reminders : [];
      let migrated = false;
      this.reminders = stored.map((reminder) => {
        const fallback = buildReminderDeliveryMessage(String(reminder.text ?? ""));
        const deliveryMessage = normalizePreparedScheduledMessage(
          reminder.deliveryMessage,
          fallback,
        );
        if (reminder.deliveryMessage !== deliveryMessage) migrated = true;
        return { ...reminder, deliveryMessage };
      });
      if (migrated) {
        try {
          this.save();
        } catch (error) {
          console.warn("[reminder] No se pudo persistir la migración de mensajes:", error);
        }
      }
    } catch (err) {
      console.warn("[reminder] Error al cargar recordatorios:", err);
      this.reminders = [];
    }
  }

  private save(): void {
    writeJsonFileAtomically(this.filePath, { reminders: this.reminders });
  }

  /** Revierte el estado en memoria si la persistencia falla. */
  private persistMutation<T>(mutate: () => T): T {
    const snapshot = this.reminders.map((reminder) => ({ ...reminder }));
    try {
      const result = mutate();
      this.save();
      return result;
    } catch (err) {
      this.reminders = snapshot;
      throw err;
    }
  }

  // ── Socket ───────────────────────────────────────────────────

  /** Actualiza la referencia al socket activo (cambia en reconexiones). */
  setSock(sock: WASocket | null): void {
    this.sock = sock;
  }

  getSock(): WASocket | null {
    return this.sock;
  }

  // ── CRUD ─────────────────────────────────────────────────────

  /**
   * Crea un recordatorio.
   * Si no se especifica date, se calcula automáticamente: hoy si la hora
   * no ha pasado (con tolerancia de 10 min para cubrir latencia del AI
   * y errores del LLM en los parámetros), o mañana si ya pasó.
   */
  createReminder(
    jid: string,
    text: string,
    hour: number,
    minute: number,
    date?: string,
    deliveryMessage?: string,
  ): Reminder {
    const now = getMexicoCityNow();
    let targetDate = date;

    if (!targetDate) {
      targetDate = determineReminderDate(hour, minute, now.ts, now.ymd);
    }

    const reminder: Reminder = {
      id: crypto.randomUUID(),
      jid,
      text,
      deliveryMessage: normalizePreparedScheduledMessage(
        deliveryMessage,
        buildReminderDeliveryMessage(text),
      ),
      hour,
      minute,
      date: targetDate,
      createdAt: new Date().toISOString(),
      fired: false,
      deliveryPending: false,
    };

    this.persistMutation(() => this.reminders.push(reminder));

    console.log(
      `[reminder] Creado recordatorio #${reminder.id.slice(0, 8)} ` +
      `para ${jid} a las ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ` +
      `del ${targetDate}`,
    );

    return reminder;
  }

  /** Para seguimiento de ventana en getDueReminders. */
  private lastCheckTs: number = -1;
  private lastCheckDate: string = "";

  /**
   * Retorna los recordatorios que deben dispararse ahora.
   * Usa el timestamp del ultimo check como inicio de ventana
   * para no perder recordatorios si el verificador se retrasa,
   * pero sin disparar recordatorios viejos.
   * Maneja el cruce de medianoche correctamente.
   */
  getDueReminders(): Reminder[] {
    const now = getMexicoCityNow();

    // Calcular inicio de ventana de forma segura
    let windowStart: number;
    if (this.lastCheckTs === -1 || this.lastCheckDate !== now.ymd) {
      // Primer check o cambio de dia: tolerancia de 2 min
      windowStart = now.ts - 2;
    } else if (now.ts < this.lastCheckTs) {
      // Cruce de medianoche: tolerancia de 2 min
      windowStart = now.ts - 2;
    } else {
      windowStart = this.lastCheckTs;
    }

    this.lastCheckTs = now.ts;
    this.lastCheckDate = now.ymd;

    return this.reminders.filter((r) => {
      if (r.fired) return false;
      if (r.deliveryPending) return true;
      if (r.date !== now.ymd) return false;
      const rTs = r.hour * 60 + r.minute;
      return rTs >= windowStart && rTs <= now.ts;
    });
  }

  /** Persiste que el recordatorio ya entró al proceso de entrega. */
  private markDeliveryPending(id: string): void {
    const reminder = this.reminders.find((item) => item.id === id);
    if (!reminder || reminder.fired || reminder.deliveryPending) return;
    this.persistMutation(() => {
      reminder.deliveryPending = true;
    });
  }

  /** Marca un recordatorio como disparado. */
  markFired(id: string): void {
    const reminder = this.reminders.find((item) => item.id === id);
    if (!reminder) return;
    this.persistMutation(() => {
      reminder.fired = true;
      reminder.deliveryPending = false;
    });
  }

  /** Obtiene la lista completa (lectura). */
  getAll(): Reminder[] {
    return this.reminders.map((r) => ({ ...r }));
  }

  /** Elimina un recordatorio por su ID. */
  deleteById(id: string): boolean {
    const idx = this.reminders.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.persistMutation(() => this.reminders.splice(idx, 1));
      return true;
    }
    return false;
  }

  /**
   * Inicia el verificador periódico (cada 30s).
   * Llama onDue por cada recordatorio que deba dispararse.
   */
  startChecker(
    onDue: (reminder: Reminder, sock: WASocket | null) => Promise<void>,
  ): void {
    if (this.intervalId !== null) return; // ya iniciado

    this.intervalId = setInterval(async () => {
      if (this.checking) return;
      this.checking = true;
      try {
        const due = this.getDueReminders();
        for (const reminder of due) {
          try {
            this.markDeliveryPending(reminder.id);
            await onDue(reminder, this.sock);
            this.markFired(reminder.id);
          } catch (err) {
            console.error(
              `[reminder] Error al disparar recordatorio #${reminder.id.slice(0, 8)}:`,
              err,
            );
          }
        }
      } finally {
        this.checking = false;
      }
    }, 30_000);

    console.log("[reminder] Verificador periódico iniciado (cada 30s)");
  }

  /** Detiene el verificador periódico. */
  stopChecker(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[reminder] Verificador periódico detenido");
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Retorna el YYYY-MM-DD del día siguiente. */
function getTomorrowYmd(todayYmd: string): string {
  const [y, m, d] = todayYmd.split("-").map(Number);
  if (y == null || m == null || d == null) return todayYmd;
  const tomorrow = new Date(y, m - 1, d + 1);
  const yy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const dd = String(tomorrow.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Determina la fecha de un recordatorio según la hora actual.
 * Tolerancia de 10 min: si el target está dentro del margen, se agenda hoy.
 * Extraída como función pura para testing.
 */
export function determineReminderDate(
  targetHour: number,
  targetMinute: number,
  nowTs: number,
  nowYmd: string,
  toleranceMinutes = 10,
): string {
  const targetTs = targetHour * 60 + targetMinute;
  return targetTs >= nowTs - toleranceMinutes
    ? nowYmd
    : getTomorrowYmd(nowYmd);
}

// ─── Tool definitions (OpenAI function calling) ──────────────────

export const REMINDER_TOOLS: import("./ai.ts").ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "create_reminder",
      description:
        "Crea un recordatorio para una hora y fecha especifica. " +
        "El sistema se encargara de notificar al usuario cuando llegue el momento. " +
        "Usa esto cuando el usuario te pida 'recuerdame a las X:Y hacer algo'. " +
        "⚠️ IMPORTANTE: DEBES llamar esta herramienta para que el recordatorio realmente exista. " +
        "No digas que lo creaste si no llamaste esta herramienta.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "Texto exacto del recordatorio: qué hay que recordar",
          },
          delivery_message: {
            type: "string",
            description:
              "Mensaje final y autocontenido que Luna enviará cuando llegue la hora. " +
              "Escríbelo desde ahora con la personalidad cálida de Luna, conserva exactamente " +
              "la acción, nombres, cantidades y datos importantes, y no uses referencias como " +
              "'eso que me dijiste' porque puede enviarse sin acceso al modelo.",
          },
          hour: {
            type: "number",
            description: "Hora en formato 24h (0-23), hora CDMX",
          },
          minute: {
            type: "number",
            description: "Minuto (0-59)",
          },
          date: {
            type: "string",
            description:
              "Fecha opcional en formato YYYY-MM-DD. " +
              "Si no se especifica, el sistema asigna hoy si la hora aun no paso, " +
              "o manana si ya paso.",
          },
        },
        required: ["text", "delivery_message", "hour", "minute"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_reminder",
      description:
        "Elimina un recordatorio existente. " +
        "Usa esto cuando el usuario te pida cancelar, eliminar o borrar un recordatorio. " +
        "Puedes buscar por el texto del recordatorio o mostrarle los que tiene para que elija. " +
        "⚠️ IMPORTANTE: DEBES llamar esta herramienta para que el recordatorio realmente se elimine.",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description:
              "Texto a buscar en el recordatorio (parte del texto, hora o ID). " +
              "Si hay varios que coinciden, se eliminara el primero. " +
              "Si solo hay uno con ese texto, se elimina ese.",
          },
          id: {
            type: "string",
            description:
              "ID exacto del recordatorio a eliminar (los primeros 8 caracteres del ID). " +
              "El usuario puede ver los IDs con list_reminders.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description:
        "Lista todos los recordatorios pendientes del usuario. " +
        "Usa esto cuando el usuario pregunte 'que recordatorios tengo', 'muestrame mis alarmas', " +
        "o similar. " +
        "⚠️ IMPORTANTE: DEBES llamar esta herramienta para ver la lista real. " +
        "No inventes recordatorios.",
      parameters: {
        type: "object",
        properties: {
          all: {
            type: "boolean",
            description:
              "Si es true, muestra tambien los recordatorios ya disparados.",
          },
        },
      },
    },
  },
];

/**
 * Busca un recordatorio por texto o ID en los recordatorios de un JID.
 * Retorna el primero que coincida, o null.
 */
function findReminder(
  reminders: Reminder[],
  jid: string,
  search?: string,
  id?: string,
): Reminder | null {
  // Filtrar solo los que aun no se han disparado
  const pending = reminders.filter((r) => r.jid === jid && !r.fired);

  // Si hay ID, buscar por ID (match parcial de 8 chars)
  if (id) {
    const found = pending.find((r) => r.id.startsWith(id));
    if (found) return found;
  }

  // Si hay texto de busqueda
  if (search) {
    const lower = search.toLowerCase();
    const found = pending.find((r) => {
      const timeStr = `${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`;
      return (
        r.text.toLowerCase().includes(lower) ||
        timeStr.includes(lower) ||
        r.id.toLowerCase().startsWith(lower)
      );
    });
    if (found) return found;
  }

  return null;
}

/**
 * Ejecuta un tool call relacionado con recordatorios.
 * Retorna el string de resultado que se enviara al modelo.
 */
export async function executeReminderTool(
  toolName: string,
  args: Record<string, unknown>,
  reminderManager: ReminderManager,
  jid: string,
): Promise<string> {
  switch (toolName) {
    case "create_reminder": {
      const text = String(args.text ?? "").trim();
      const hour = Number(args.hour);
      const minute = Number(args.minute);
      const date = typeof args.date === "string" ? args.date : undefined;
      const deliveryMessage = normalizePreparedScheduledMessage(
        args.delivery_message,
        buildReminderDeliveryMessage(text),
      );

      if (!text) {
        return "Error: el texto del recordatorio es obligatorio.";
      }
      if (text.length > 500) {
        return "Error: el texto del recordatorio no puede exceder 500 caracteres.";
      }
      if (
        !Number.isInteger(hour) || hour < 0 || hour > 23 ||
        !Number.isInteger(minute) || minute < 0 || minute > 59
      ) {
        return "Error: hora debe ser 0-23 y minuto 0-59.";
      }
      if (date && !isValidYmdDate(date)) {
        return "Error: la fecha debe ser una fecha real en formato YYYY-MM-DD.";
      }

      const reminder = reminderManager.createReminder(
        jid,
        text,
        hour,
        minute,
        date,
        deliveryMessage,
      );
      const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      return (
        `✅ Recordatorio creado exitosamente (ID: ${reminder.id.slice(0, 8)}). ` +
        `Te recordare "${text}" a las ${timeStr} del ${reminder.date}. ` +
        `Mensaje de entrega guardado: "${reminder.deliveryMessage}"`
      );
    }

    case "delete_reminder": {
      const search = typeof args.search === "string" ? args.search : undefined;
      const id = typeof args.id === "string" ? args.id : undefined;

      if (!search && !id) {
        return "Error: proporciona el texto o ID del recordatorio a eliminar.";
      }

      const all = reminderManager.getAll();
      const found = findReminder(all, jid, search, id);

      if (!found) {
        const msg =
          search
            ? `No encontre ningun recordatorio pendiente que coincida con "${search}".`
            : `No encontre ningun recordatorio pendiente con ID "${id}".`;
        return `${msg} Usa list_reminders para ver tus recordatorios.`;
      }

      reminderManager.deleteById(found.id);
      return (
        `✅ Recordatorio eliminado: "${found.text}" ` +
        `(programado para las ${String(found.hour).padStart(2, "0")}:${String(found.minute).padStart(2, "0")}` +
        ` del ${found.date})`
      );
    }

    case "list_reminders": {
      const showAll = args.all === true;
      const all = reminderManager.getAll();
      const userReminders = all.filter((r) => r.jid === jid && (showAll || !r.fired));

      if (userReminders.length === 0) {
        return "No tienes ningun recordatorio pendiente.";
      }

      const lines = userReminders.map((r, i) => {
        const status = r.fired ? "✅ Disparado" : "⏳ Pendiente";
        const shortId = r.id.slice(0, 8);
        const timeStr = `${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`;
        return `${i + 1}. [${shortId}] ${timeStr} del ${r.date} — ${r.text} — ${status}`;
      });

      return `📋 RECORDATORIOS\n${lines.join("\n")}`;
    }

    default:
      return `Error: funcion desconocida "${toolName}"`;
  }
}
