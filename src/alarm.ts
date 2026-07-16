import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONTEXTS_DIR } from "./context.ts";
import type { ToolDefinition } from "./ai.ts";

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
  createdAt: string;
}

interface AlarmsFile {
  alarms: RecurringAlarm[];
}

/** Retorna la hora actual en CDMX con día de la semana. */
function getMexicoCityNow(): {
  hour: number;
  minute: number;
  ymd: string;
  ts: number;
  dayOfWeek: number;
} {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    hour: "numeric",
    minute: "numeric",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "0";
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  const year = get("year");
  const month = get("month").padStart(2, "0");
  const day = get("day").padStart(2, "0");

  // Día de la semana en CDMX (0=domingo, 6=sábado)
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    weekday: "long",
  }).format(now);
  const dayMap: Record<string, number> = {
    "Sunday": 0, "Monday": 1, "Tuesday": 2, "Wednesday": 3,
    "Thursday": 4, "Friday": 5, "Saturday": 6,
  };
  const dayOfWeek = dayMap[dayName] ?? 0;

  return {
    hour,
    minute,
    ymd: `${year}-${month}-${day}`,
    ts: hour * 60 + minute,
    dayOfWeek,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function safeJid(jid: string): string {
  return jid.replace(/[^a-zA-Z0-9@._-]/g, "_");
}

function alarmsFilePath(baseDir: string, jid: string): string {
  return join(baseDir, safeJid(jid), "alarms.json");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ─── AlarmManager ────────────────────────────────────────────────

export class AlarmManager {
  private alarms: RecurringAlarm[] = [];
  private readonly baseDir: string;
  private intervalId: ReturnType<typeof setInterval> | null = null;

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
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw) as AlarmsFile;
      if (Array.isArray(data.alarms)) {
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
    ensureDir(join(this.baseDir, safeJid(jid)));
    try {
      const data: AlarmsFile = { alarms: userAlarms };
      writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error(`[alarm] Error al guardar alarmas de ${jid}:`, err);
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
      daysOfWeek: [...daysOfWeek].sort(),
      enabled: true,
      lastFiredDate: "",
      createdAt: new Date().toISOString(),
    };

    this.alarms.push(alarm);
    this.saveUserAlarms(jid);

    const daysStr = alarm.daysOfWeek
      .map((d) => ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][d])
      .join(",");
    console.log(
      `[alarm] Creada alarma #${alarm.id.slice(0, 8)} ` +
      `para ${jid} a las ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ` +
      `los días [${daysStr}]: "${text}"`,
    );

    return alarm;
  }

  /** Elimina una alarma por ID. Solo elimina si pertenece al JID indicado. */
  deleteAlarm(id: string, jid: string): boolean {
    const idx = this.alarms.findIndex((a) => a.id === id && a.jid === jid);
    if (idx >= 0) {
      this.alarms.splice(idx, 1);
      this.saveUserAlarms(jid);
      return true;
    }
    return false;
  }

  /** Activa/desactiva una alarma. Retorna el nuevo estado, o null si no existe. */
  toggleAlarm(id: string, jid: string): boolean | null {
    const alarm = this.alarms.find((a) => a.id === id && a.jid === jid);
    if (!alarm) return null;
    alarm.enabled = !alarm.enabled;
    this.saveUserAlarms(jid);
    return alarm.enabled;
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
      if (!a.daysOfWeek.includes(now.dayOfWeek)) return false;
      if (a.lastFiredDate === now.ymd) return false;
      const alarmTs = a.hour * 60 + a.minute;
      return alarmTs >= windowStart && alarmTs <= now.ts;
    });
  }

  /** Marca una alarma como disparada hoy. */
  markFired(id: string): void {
    const alarm = this.alarms.find((a) => a.id === id);
    if (alarm) {
      const now = getMexicoCityNow();
      alarm.lastFiredDate = now.ymd;
      this.saveUserAlarms(alarm.jid);
    }
  }

  /** Inicia el verificador periódico (cada 30s). */
  startChecker(
    onDue: (alarm: RecurringAlarm) => Promise<void>,
  ): void {
    if (this.intervalId !== null) return;

    this.intervalId = setInterval(async () => {
      const due = this.getDueAlarms();
      for (const alarm of due) {
        try {
          await onDue(alarm);
          this.markFired(alarm.id);
        } catch (err) {
          console.error(
            `[alarm] Error al disparar alarma #${alarm.id.slice(0, 8)}:`,
            err,
          );
        }
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
      const text = String(args.text ?? "");
      const hour = Number(args.hour);
      const minute = Number(args.minute);
      const daysOfWeek = Array.isArray(args.daysOfWeek)
        ? (args.daysOfWeek.filter(
            (d): d is number => typeof d === "number" && d >= 0 && d <= 6,
          ))
        : [];

      if (!text) {
        return "Error: el texto de la alarma es obligatorio.";
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
