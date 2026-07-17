import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONTEXTS_DIR } from "./context.ts";
import { getMexicoCityNow } from "./utils.ts";
import type { ToolDefinition } from "./ai.ts";
import {
  readJsonFile,
  sanitizePathSegment,
  writeJsonFileAtomically,
} from "./storage.ts";

// ─── Types ───────────────────────────────────────────────────────

export interface RecurringAlarm {
  id: string;
  jid: string;
  text: string;
  hour: number;
  minute: number;
  /** Días de la semana: 0=domingo, 1=lunes, ..., 6=sábado */
  daysOfWeek: number[];
  enabled: boolean;
  /** Fecha YYYY-MM-DD de la última vez que se disparó. Evita duplicados en el mismo día. */
  lastFiredDate: string;
  /** Fecha cuya entrega ya comenzó y debe reintentarse si falla. */
  pendingDeliveryDate?: string;
  createdAt: string;
}

interface AlarmsFile {
  alarms: RecurringAlarm[];
}

// ─── Helpers ─────────────────────────────────────────────────────

function alarmsFilePath(baseDir: string, jid: string): string {
  return join(baseDir, sanitizePathSegment(jid), "alarms.json");
}

// ─── AlarmManager ────────────────────────────────────────────────

export class AlarmManager {
  private alarms: RecurringAlarm[] = [];
  private readonly baseDir: string;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(testBaseDir?: string) {
    this.baseDir = testBaseDir ?? CONTEXTS_DIR;
    this.loadAll();
  }

  // ── Persistencia ─────────────────────────────────────────────

  /** Escanea el directorio base y carga alarmas de todos los usuarios. */
  private loadAll(): void {
    try {
      if (!existsSync(this.baseDir)) return;

      const entries = readdirSync(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const path = join(this.baseDir, entry.name, "alarms.json");
          if (existsSync(path)) {
            this.loadFile(path);
          }
        }
      }
    } catch (err) {
      console.warn("[alarm] Error al cargar alarmas:", err);
    }
  }

  private loadFile(path: string): void {
    try {
      const data = readJsonFile<AlarmsFile>(path);
      if (Array.isArray(data?.alarms)) {
        this.alarms.push(...data.alarms);
      }
    } catch (err) {
      console.warn(`[alarm] Error al leer ${path}:`, err);
    }
  }

  /** Persiste las alarmas de un JID específico a su archivo. */
  private saveUserAlarms(jid: string): void {
    const userAlarms = this.alarms.filter((a) => a.jid === jid);
    const path = alarmsFilePath(this.baseDir, jid);
    writeJsonFileAtomically(path, { alarms: userAlarms });
  }

  /** Revierte el estado en memoria si la persistencia falla. */
  private persistUserMutation<T>(jid: string, mutate: () => T): T {
    const snapshot = this.alarms.map((alarm) => ({
      ...alarm,
      daysOfWeek: [...alarm.daysOfWeek],
    }));
    try {
      const result = mutate();
      this.saveUserAlarms(jid);
      return result;
    } catch (err) {
      this.alarms = snapshot;
      throw err;
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────

  createAlarm(
    jid: string,
    text: string,
    hour: number,
    minute: number,
    daysOfWeek: number[],
  ): RecurringAlarm {
    const alarm: RecurringAlarm = {
      id: crypto.randomUUID(),
      jid,
      text,
      hour,
      minute,
      daysOfWeek: [...new Set(daysOfWeek)].sort((a, b) => a - b),
      enabled: true,
      lastFiredDate: "",
      pendingDeliveryDate: "",
      createdAt: new Date().toISOString(),
    };

    this.persistUserMutation(jid, () => this.alarms.push(alarm));

    const daysStr = alarm.daysOfWeek
      .map((d) => ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][d])
      .join(",");
    console.log(
      `[alarm] Creada alarma #${alarm.id.slice(0, 8)} ` +
      `para ${jid} a las ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ` +
      `los días [${daysStr}]`,
    );

    return alarm;
  }

  /** Elimina una alarma por ID. Solo elimina si pertenece al JID indicado. */
  deleteAlarm(id: string, jid: string): boolean {
    const idx = this.alarms.findIndex((a) => a.id === id && a.jid === jid);
    if (idx >= 0) {
      this.persistUserMutation(jid, () => this.alarms.splice(idx, 1));
      return true;
    }
    return false;
  }

  /** Activa/desactiva una alarma. Retorna el nuevo estado, o null si no existe. */
  toggleAlarm(id: string, jid: string): boolean | null {
    const alarm = this.alarms.find((a) => a.id === id && a.jid === jid);
    if (!alarm) return null;
    return this.persistUserMutation(jid, () => {
      alarm.enabled = !alarm.enabled;
      if (!alarm.enabled) alarm.pendingDeliveryDate = "";
      return alarm.enabled;
    });
  }

  /** Obtiene las alarmas de un usuario (copia). */
  getUserAlarms(jid: string): RecurringAlarm[] {
    return this.alarms
      .filter((a) => a.jid === jid)
      .map((a) => ({ ...a }));
  }

  /** Obtiene todas las alarmas (copia, para el checker). */
  getAll(): RecurringAlarm[] {
    return this.alarms.map((a) => ({ ...a }));
  }

  // ── Checker ──────────────────────────────────────────────────

  private lastCheckTs: number = -1;
  private lastCheckDate: string = "";

  /**
   * Retorna las alarmas que deben dispararse en esta verificación.
   * Misma lógica de ventana que ReminderManager.
   */
  getDueAlarms(): RecurringAlarm[] {
    const now = getMexicoCityNow();

    // Ventana de inicio segura
    let windowStart: number;
    if (this.lastCheckTs === -1 || this.lastCheckDate !== now.ymd) {
      windowStart = now.ts - 2;
    } else if (now.ts < this.lastCheckTs) {
      // Cruce de medianoche
      windowStart = now.ts - 2;
    } else {
      windowStart = this.lastCheckTs;
    }

    this.lastCheckTs = now.ts;
    this.lastCheckDate = now.ymd;

    return this.alarms.filter((a) => {
      if (!a.enabled) return false;
      if (a.lastFiredDate === now.ymd) return false;
      if (a.pendingDeliveryDate === now.ymd) return true;
      if (!a.daysOfWeek.includes(now.dayOfWeek)) return false;
      const alarmTs = a.hour * 60 + a.minute;
      return alarmTs >= windowStart && alarmTs <= now.ts;
    });
  }

  /** Persiste que la alarma ya entró al proceso de entrega. */
  private markDeliveryPending(id: string): void {
    const alarm = this.alarms.find((item) => item.id === id);
    if (!alarm || !alarm.enabled) return;
    const today = getMexicoCityNow().ymd;
    if (alarm.pendingDeliveryDate === today) return;
    this.persistUserMutation(alarm.jid, () => {
      alarm.pendingDeliveryDate = today;
    });
  }

  /** Marca una alarma como disparada hoy. */
  markFired(id: string): void {
    const alarm = this.alarms.find((item) => item.id === id);
    if (!alarm) return;
    const today = getMexicoCityNow().ymd;
    this.persistUserMutation(alarm.jid, () => {
      alarm.lastFiredDate = today;
      alarm.pendingDeliveryDate = "";
    });
  }

  /** Inicia el verificador periódico (cada 30s). */
  startChecker(
    onDue: (alarm: RecurringAlarm) => Promise<void>,
  ): void {
    if (this.intervalId !== null) return;

    this.intervalId = setInterval(async () => {
      if (this.checking) return;
      this.checking = true;
      try {
        const due = this.getDueAlarms();
        for (const alarm of due) {
          try {
            this.markDeliveryPending(alarm.id);
            await onDue(alarm);
            this.markFired(alarm.id);
          } catch (err) {
            console.error(
              `[alarm] Error al disparar alarma #${alarm.id.slice(0, 8)}:`,
              err,
            );
          }
        }
      } finally {
        this.checking = false;
      }
    }, 30_000);

    console.log("[alarm] Verificador periódico iniciado (cada 30s)");
  }

  /** Detiene el verificador periódico. */
  stopChecker(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[alarm] Verificador periódico detenido");
    }
  }
}

// ─── Tool definitions ────────────────────────────────────────────

export const ALARM_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "create_alarm",
      description:
        "Crea una ALARMA RECURRENTE que se dispara en días específicos de la semana a una hora fija. " +
        "Úsala cuando el usuario quiera una alarma que se repita, por ejemplo: " +
        "'todos los lunes a las 8am', 'cada lunes, miércoles y viernes a las 3pm', " +
        "'todos los días a las 7am y 9pm'. " +
        "Para recordatorios de UNA SOLA VEZ (ej: 'recuérdame mañana a las 5pm'), usa create_reminder. " +
        "⚠️ IMPORTANTE: si el usuario pide múltiples horarios (ej: 'a las 8am, 4pm y 12pm'), " +
        "crea UNA alarma por cada horario, llamando esta herramienta varias veces.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Texto de la alarma: qué hay que recordar",
          },
          hour: {
            type: "number",
            description: "Hora en formato 24h (0-23), hora CDMX",
          },
          minute: {
            type: "number",
            description: "Minuto (0-59)",
          },
          daysOfWeek: {
            type: "array",
            items: { type: "number" },
            description:
              "Días de la semana en que se repite la alarma. " +
              "0=domingo, 1=lunes, 2=martes, 3=miércoles, 4=jueves, 5=viernes, 6=sábado. " +
              "Ejemplo: [1,2,3,4,5] = lunes a viernes. [0,1,2,3,4,5,6] = todos los días. " +
              "[1,3,5] = lunes, miércoles y viernes.",
          },
        },
        required: ["text", "hour", "minute", "daysOfWeek"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_alarm",
      description:
        "Elimina una alarma recurrente existente. " +
        "Usa esto cuando el usuario quiera cancelar una alarma recurrente. " +
        "Puedes buscar por texto o usar el ID exacto.",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description:
              "Texto a buscar en la alarma. Elimina la primera que coincida.",
          },
          id: {
            type: "string",
            description:
              "ID exacto de la alarma (primeros 8 caracteres). " +
              "El usuario puede ver los IDs con list_alarms.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_alarms",
      description:
        "Lista todas las alarmas recurrentes del usuario. " +
        "Usa esto cuando el usuario pregunte 'qué alarmas tengo', " +
        "'muéstrame mis alarmas', o similar.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "toggle_alarm",
      description:
        "Activa o desactiva una alarma recurrente. " +
        "Úsala cuando el usuario quiera pausar o reanudar una alarma.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "ID de la alarma a activar/desactivar (primeros 8 caracteres). " +
              "Usa list_alarms para ver los IDs.",
          },
        },
        required: ["id"],
      },
    },
  },
];

// ─── Tool executor ───────────────────────────────────────────────

/** Busca una alarma por texto o ID, filtrando por JID. */
function findAlarm(
  alarms: RecurringAlarm[],
  jid: string,
  search?: string,
  id?: string,
): RecurringAlarm | null {
  const userAlarms = alarms.filter((a) => a.jid === jid);

  if (id) {
    const found = userAlarms.find((a) => a.id.startsWith(id));
    if (found) return found;
  }

  if (search) {
    const lower = search.toLowerCase();
    const found = userAlarms.find((a) => {
      const timeStr = `${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}`;
      const daysStr = a.daysOfWeek
        .map((d) => ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][d])
        .join(" ");
      return (
        a.text.toLowerCase().includes(lower) ||
        timeStr.includes(lower) ||
        daysStr.includes(lower) ||
        a.id.toLowerCase().startsWith(lower)
      );
    });
    if (found) return found;
  }

  return null;
}

/**
 * Ejecuta un tool call relacionado con alarmas recurrentes.
 * Retorna el string de resultado que se envía al modelo.
 */
export async function executeAlarmTool(
  toolName: string,
  args: Record<string, unknown>,
  alarmManager: AlarmManager,
  jid: string,
): Promise<string> {
  switch (toolName) {
    case "create_alarm": {
      const text = String(args.text ?? "").trim();
      const hour = Number(args.hour);
      const minute = Number(args.minute);
      const daysOfWeek = Array.isArray(args.daysOfWeek)
        ? [
            ...new Set(
              args.daysOfWeek.filter(
                (day): day is number =>
                  typeof day === "number" &&
                  Number.isInteger(day) &&
                  day >= 0 &&
                  day <= 6,
              ),
            ),
          ]
        : [];

      if (!text) {
        return "Error: el texto de la alarma es obligatorio.";
      }
      if (text.length > 500) {
        return "Error: el texto de la alarma no puede exceder 500 caracteres.";
      }
      if (
        !Number.isInteger(hour) || hour < 0 || hour > 23 ||
        !Number.isInteger(minute) || minute < 0 || minute > 59
      ) {
        return "Error: hora debe ser 0-23 y minuto 0-59.";
      }
      if (daysOfWeek.length === 0) {
        return "Error: daysOfWeek debe contener al menos un día (0-6).";
      }

      const alarm = alarmManager.createAlarm(jid, text, hour, minute, daysOfWeek);
      const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      const dayNames = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
      const daysStr = alarm.daysOfWeek.map((d) => dayNames[d]).join(", ");

      return (
        `✅ Alarma recurrente creada (ID: ${alarm.id.slice(0, 8)}). ` +
        `Te avisaré "${text}" a las ${timeStr} los días: ${daysStr}.`
      );
    }

    case "delete_alarm": {
      const search = typeof args.search === "string" ? args.search : undefined;
      const id = typeof args.id === "string" ? args.id : undefined;

      if (!search && !id) {
        return "Error: proporciona el texto o ID de la alarma a eliminar.";
      }

      const all = alarmManager.getAll();
      const found = findAlarm(all, jid, search, id);

      if (!found) {
        const msg = search
          ? `No encontré ninguna alarma que coincida con "${search}".`
          : `No encontré ninguna alarma con ID "${id}".`;
        return `${msg} Usa list_alarms para ver tus alarmas.`;
      }

      alarmManager.deleteAlarm(found.id, jid);
      const dayNames = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
      const daysStr = found.daysOfWeek.map((d) => dayNames[d]).join(", ");
      return (
        `✅ Alarma eliminada: "${found.text}" ` +
        `(a las ${String(found.hour).padStart(2, "0")}:${String(found.minute).padStart(2, "0")} ` +
        `los ${daysStr})`
      );
    }

    case "list_alarms": {
      const userAlarms = alarmManager.getUserAlarms(jid);

      if (userAlarms.length === 0) {
        return "No tienes ninguna alarma recurrente.";
      }

      const dayNames = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
      const lines = userAlarms.map((a, i) => {
        const status = a.enabled ? "✅ Activa" : "⏸️ Pausada";
        const shortId = a.id.slice(0, 8);
        const timeStr = `${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}`;
        const daysStr = a.daysOfWeek.map((d) => dayNames[d]).join(",");
        return `${i + 1}. [${shortId}] ${timeStr} (${daysStr}) — ${a.text} — ${status}`;
      });

      return `⏰ ALARMAS RECURRENTES\n${lines.join("\n")}`;
    }

    case "toggle_alarm": {
      const id = typeof args.id === "string" ? args.id : undefined;
      if (!id) {
        return "Error: se requiere el ID de la alarma.";
      }

      const all = alarmManager.getAll();
      const found = findAlarm(all, jid, undefined, id);

      if (!found) {
        return `No encontré ninguna alarma con ID "${id}". Usa list_alarms para ver tus alarmas.`;
      }

      const newState = alarmManager.toggleAlarm(found.id, jid);
      const stateStr = newState ? "ACTIVADA" : "PAUSADA";
      return `✅ Alarma ${stateStr}: "${found.text}" (ID: ${found.id.slice(0, 8)})`;
    }

    default:
      return `Error: función desconocida "${toolName}"`;
  }
}
