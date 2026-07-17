import { describe, it, expect, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync, readFileSync } from "node:fs";

import { AlarmManager, ALARM_TOOLS, executeAlarmTool } from "../src/alarm.ts";

// ─── Helpers ─────────────────────────────────────────────────────

let testCounter = 0;
const TEST_DIRS: string[] = [];

function createIsolatedAlarmManager(): AlarmManager {
  testCounter++;
  const dir = join(tmpdir(), `codewolf-alarm-test-${Date.now()}-${testCounter}`);
  TEST_DIRS.push(dir);
  return new AlarmManager(dir);
}

const TEST_JID = "user@test.com";

afterAll(() => {
  for (const dir of TEST_DIRS) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

// ─── Tests ───────────────────────────────────────────────────────

describe("AlarmManager — creación", () => {
  it("createAlarm guarda una alarma con los campos correctos", () => {
    const am = createIsolatedAlarmManager();
    const alarm = am.createAlarm(TEST_JID, "poner crema a Thowi", 9, 30, [1, 2, 3, 4, 5]);

    expect(alarm.text).toBe("poner crema a Thowi");
    expect(alarm.deliveryMessage).toContain("poner crema a Thowi");
    expect(alarm.deliveryMessage).toContain("⏰");
    expect(alarm.hour).toBe(9);
    expect(alarm.minute).toBe(30);
    expect(alarm.jid).toBe(TEST_JID);
    expect(alarm.daysOfWeek).toEqual([1, 2, 3, 4, 5]); // lunes a viernes
    expect(alarm.enabled).toBe(true);
    expect(alarm.lastFiredDate).toBe("");
    expect(alarm.id).toBeDefined();
    expect(alarm.createdAt).toBeDefined();
  });

  it("persiste el mensaje preparado y lo conserva después de reiniciar", () => {
    const dir = join(tmpdir(), `codewolf-alarm-copy-${Date.now()}`);
    TEST_DIRS.push(dir);
    const first = new AlarmManager(dir);
    first.createAlarm(
      TEST_JID,
      "tomar agua",
      9,
      0,
      [1, 2, 3, 4, 5],
      "¡Vamos! 💧 Es hora de tomar agua.",
    );

    const reloaded = new AlarmManager(dir);
    expect(reloaded.getUserAlarms(TEST_JID)[0]?.deliveryMessage).toBe(
      "¡Vamos! 💧 Es hora de tomar agua.",
    );
  });

  it("createAlarm asigna id único a cada alarma", () => {
    const am = createIsolatedAlarmManager();
    const a1 = am.createAlarm(TEST_JID, "cosa 1", 10, 0, [1]);
    const a2 = am.createAlarm(TEST_JID, "cosa 2", 11, 0, [2]);
    expect(a1.id).not.toBe(a2.id);
  });

  it("getUserAlarms retorna solo las alarmas del JID solicitado", () => {
    const am = createIsolatedAlarmManager();
    am.createAlarm("user1@test.com", "alarma user1", 10, 0, [1]);
    am.createAlarm("user2@test.com", "alarma user2", 11, 0, [2]);
    am.createAlarm("user1@test.com", "otra user1", 12, 0, [1, 3, 5]);

    const user1Alarms = am.getUserAlarms("user1@test.com");
    expect(user1Alarms).toHaveLength(2);
    expect(user1Alarms[0]?.jid).toBe("user1@test.com");
    expect(user1Alarms[1]?.jid).toBe("user1@test.com");
  });

  it("getUserAlarms retorna copia (no referencia mutable)", () => {
    const am = createIsolatedAlarmManager();
    am.createAlarm(TEST_JID, "original", 10, 0, [1]);
    const alarms = am.getUserAlarms(TEST_JID);
    alarms[0]!.text = "modificado";
    // Recargar del manager: debe seguir original
    const reloaded = am.getUserAlarms(TEST_JID);
    expect(reloaded[0]!.text).toBe("original");
  });

  it("getAll retorna todas las alarmas", () => {
    const am = createIsolatedAlarmManager();
    am.createAlarm("u1@t.com", "a", 10, 0, [1]);
    am.createAlarm("u2@t.com", "b", 11, 0, [2]);
    expect(am.getAll()).toHaveLength(2);
  });
});

describe("AlarmManager — persistencia por usuario", () => {
  it("createAlarm guarda el archivo alarms.json del usuario", () => {
    const dir = join(tmpdir(), `codewolf-alarm-persist-${Date.now()}`);
    TEST_DIRS.push(dir);
    const am = new AlarmManager(dir);
    am.createAlarm(TEST_JID, "test persistencia", 14, 30, [1, 3, 5]);

    const sanitizedJid = TEST_JID.replace(/[^a-zA-Z0-9@._-]/g, "_");
    const filePath = join(dir, sanitizedJid, "alarms.json");
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    expect(data.alarms).toHaveLength(1);
    expect(data.alarms[0].text).toBe("test persistencia");
  });

  it("dos usuarios tienen archivos separados", () => {
    const dir = join(tmpdir(), `codewolf-alarm-multi-user-${Date.now()}`);
    TEST_DIRS.push(dir);
    const am = new AlarmManager(dir);
    am.createAlarm("user1@t.com", "alarma user1", 8, 0, [1]);
    am.createAlarm("user2@t.com", "alarma user2", 9, 0, [2]);

    const sanitized1 = "user1@t.com".replace(/[^a-zA-Z0-9@._-]/g, "_");
    const sanitized2 = "user2@t.com".replace(/[^a-zA-Z0-9@._-]/g, "_");

    expect(existsSync(join(dir, sanitized1, "alarms.json"))).toBe(true);
    expect(existsSync(join(dir, sanitized2, "alarms.json"))).toBe(true);

    // Verificar que cada archivo solo contiene sus propias alarmas
    const raw1 = readFileSync(join(dir, sanitized1, "alarms.json"), "utf-8");
    expect(JSON.parse(raw1).alarms).toHaveLength(1);
    expect(JSON.parse(raw1).alarms[0].jid).toBe("user1@t.com");
  });

  it("al recargar desde disco, las alarmas cargan correctamente (simula reinicio)", () => {
    const dir = join(tmpdir(), `codewolf-alarm-reload-${Date.now()}`);
    TEST_DIRS.push(dir);
    const am1 = new AlarmManager(dir);
    am1.createAlarm(TEST_JID, "antes del reinicio", 10, 0, [1, 2, 3]);
    am1.createAlarm(TEST_JID, "otra alarma", 15, 30, [5]);

    // Simular reinicio: nuevo AlarmManager apuntando al mismo directorio
    const am2 = new AlarmManager(dir);
    const alarms = am2.getUserAlarms(TEST_JID);
    expect(alarms).toHaveLength(2);
    expect(alarms.some((a) => a.text === "antes del reinicio")).toBe(true);
    expect(alarms.some((a) => a.text === "otra alarma")).toBe(true);
  });
});

describe("AlarmManager — deleteAlarm", () => {
  it("deleteAlarm elimina una alarma existente del JID correcto", () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "para borrar", 12, 0, [1]);
    expect(am.getUserAlarms(TEST_JID)).toHaveLength(1);

    const deleted = am.deleteAlarm(a.id, TEST_JID);
    expect(deleted).toBe(true);
    expect(am.getUserAlarms(TEST_JID)).toHaveLength(0);
  });

  it("deleteAlarm no elimina alarmas de otro JID", () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "solo mia", 12, 0, [1]);
    const result = am.deleteAlarm(a.id, "other@test.com");
    expect(result).toBe(false);
    expect(am.getUserAlarms(TEST_JID)).toHaveLength(1);
  });

  it("deleteAlarm con ID inexistente retorna false", () => {
    const am = createIsolatedAlarmManager();
    const result = am.deleteAlarm("no-existe", TEST_JID);
    expect(result).toBe(false);
  });
});

describe("AlarmManager — toggleAlarm", () => {
  it("toggleAlarm desactiva una alarma activa", () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "para toggle", 10, 0, [1]);
    expect(a.enabled).toBe(true);

    const newState = am.toggleAlarm(a.id, TEST_JID);
    expect(newState).toBe(false);

    const alarms = am.getUserAlarms(TEST_JID);
    expect(alarms[0]!.enabled).toBe(false);
  });

  it("toggleAlarm activa una alarma pausada", () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "reactivar", 10, 0, [1]);
    am.toggleAlarm(a.id, TEST_JID); // desactivar
    const newState = am.toggleAlarm(a.id, TEST_JID); // reactivar
    expect(newState).toBe(true);
  });

  it("toggleAlarm con ID inexistente retorna null", () => {
    const am = createIsolatedAlarmManager();
    const result = am.toggleAlarm("no-existe", TEST_JID);
    expect(result).toBeNull();
  });
});

describe("AlarmManager — getDueAlarms", () => {
  it("no incluye alarmas desactivadas", () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "desactivada", 0, 0, [0, 1, 2, 3, 4, 5, 6]);
    am.toggleAlarm(a.id, TEST_JID);

    const due = am.getDueAlarms();
    const found = due.find((x) => x.id === a.id);
    expect(found).toBeUndefined();
  });

  it("no incluye alarmas ya disparadas hoy", () => {
    const am = createIsolatedAlarmManager();
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const a = am.createAlarm(TEST_JID, "ya disparada hoy", h, m, [0, 1, 2, 3, 4, 5, 6]);
    am.markFired(a.id);

    const due = am.getDueAlarms();
    const found = due.find((x) => x.id === a.id);
    expect(found).toBeUndefined();
  });

  it("alarma marcada como disparada persiste su lastFiredDate", () => {
    const am = createIsolatedAlarmManager();
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
    const today = `${get("year")}-${get("month").padStart(2, "0")}-${get("day").padStart(2, "0")}`;

    const a = am.createAlarm(TEST_JID, "persistir fired", 0, 0, [0, 1, 2, 3, 4, 5, 6]);
    am.markFired(a.id);

    const alarms = am.getUserAlarms(TEST_JID);
    expect(alarms[0]!.lastFiredDate).toBe(today);
  });
});

describe("AlarmManager — reintentos", () => {
  it("persiste el reintento de una entrega fallida durante el mismo día", () => {
    const dir = join(tmpdir(), `codewolf-alarm-retry-${Date.now()}`);
    TEST_DIRS.push(dir);

    const first = new AlarmManager(dir);
    const alarm = first.createAlarm(TEST_JID, "entrega pendiente", 23, 59, []);
    const internal = first as unknown as {
      markDeliveryPending(id: string): void;
    };
    internal.markDeliveryPending(alarm.id);

    const reloaded = new AlarmManager(dir);
    expect(reloaded.getDueAlarms().some((item) => item.id === alarm.id)).toBe(true);
  });

  it("ignora entregas pendientes de días anteriores", () => {
    const am = createIsolatedAlarmManager();
    const alarm = am.createAlarm(TEST_JID, "alarma vencida", 23, 59, []);
    const internal = am as unknown as { alarms: Array<{ id: string; pendingDeliveryDate?: string }> };
    const stored = internal.alarms.find((item) => item.id === alarm.id);
    if (stored) stored.pendingDeliveryDate = "2000-01-01";

    expect(am.getDueAlarms().some((item) => item.id === alarm.id)).toBe(false);
  });
});

describe("ALARM_TOOLS — definiciones", () => {
  it("exporta exactamente 4 tools", () => {
    expect(ALARM_TOOLS).toHaveLength(4);
  });

  it("incluye create_alarm, delete_alarm, list_alarms, toggle_alarm", () => {
    const names = ALARM_TOOLS.map((t) => t.function.name);
    expect(names).toContain("create_alarm");
    expect(names).toContain("delete_alarm");
    expect(names).toContain("list_alarms");
    expect(names).toContain("toggle_alarm");
  });

  it("create_alarm requiere text, hour, minute, daysOfWeek", () => {
    const tool = ALARM_TOOLS.find((t) => t.function.name === "create_alarm")!;
    const required = (tool.function.parameters as any)?.required;
    expect(required).toContain("text");
    expect(required).toContain("delivery_message");
    expect(required).toContain("hour");
    expect(required).toContain("minute");
    expect(required).toContain("daysOfWeek");
  });

  it("toggle_alarm requiere id", () => {
    const tool = ALARM_TOOLS.find((t) => t.function.name === "toggle_alarm")!;
    const required = (tool.function.parameters as any)?.required;
    expect(required).toContain("id");
  });

  it("tiene type function", () => {
    for (const tool of ALARM_TOOLS) {
      expect(tool.type).toBe("function");
    }
  });
});

describe("executeAlarmTool", () => {
  it("create_alarm con datos válidos retorna éxito", async () => {
    const am = createIsolatedAlarmManager();
    const result = await executeAlarmTool(
      "create_alarm",
      {
        text: "poner gotas a Thowi",
        delivery_message: "¡Oye! 😊 Ya toca ponerle las gotas a Thowi.",
        hour: 8,
        minute: 0,
        daysOfWeek: [1, 2, 3, 4, 5],
      },
      am,
      TEST_JID,
    );

    expect(result).toContain("Alarma recurrente creada");
    expect(result).toContain("poner gotas a Thowi");
    expect(result).toContain("08:00");
    expect(result).toContain("lunes");
    expect(result).toContain("viernes");

    const alarms = am.getUserAlarms(TEST_JID);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]?.deliveryMessage).toBe(
      "¡Oye! 😊 Ya toca ponerle las gotas a Thowi.",
    );
  });

  it("create_alarm con text vacío retorna error", async () => {
    const am = createIsolatedAlarmManager();
    const result = await executeAlarmTool(
      "create_alarm",
      { text: "", hour: 10, minute: 0, daysOfWeek: [1] },
      am,
      TEST_JID,
    );
    expect(result).toContain("Error");
  });

  it("create_alarm con hora inválida retorna error", async () => {
    const am = createIsolatedAlarmManager();
    const result = await executeAlarmTool(
      "create_alarm",
      { text: "test", hour: 99, minute: 0, daysOfWeek: [1] },
      am,
      TEST_JID,
    );
    expect(result).toContain("Error");
  });

  it("create_alarm con daysOfWeek vacío retorna error", async () => {
    const am = createIsolatedAlarmManager();
    const result = await executeAlarmTool(
      "create_alarm",
      { text: "test", hour: 10, minute: 0, daysOfWeek: [] },
      am,
      TEST_JID,
    );
    expect(result).toContain("Error");
  });

  it("create_alarm con todos los días funciona", async () => {
    const am = createIsolatedAlarmManager();
    const result = await executeAlarmTool(
      "create_alarm",
      { text: "todos los días", hour: 7, minute: 0, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
      am,
      TEST_JID,
    );
    expect(result).toContain("domingo");
    expect(result).toContain("sábado");

    const alarms = am.getUserAlarms(TEST_JID);
    expect(alarms[0]!.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("delete_alarm con ID existente retorna éxito", async () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "a eliminar", 12, 0, [1]);
    const shortId = a.id.slice(0, 8);
    const result = await executeAlarmTool("delete_alarm", { id: shortId }, am, TEST_JID);
    expect(result).toContain("Alarma eliminada");
    expect(am.getUserAlarms(TEST_JID)).toHaveLength(0);
  });

  it("delete_alarm con ID inexistente retorna mensaje de no encontrado", async () => {
    const am = createIsolatedAlarmManager();
    const result = await executeAlarmTool("delete_alarm", { id: "no-existe" }, am, TEST_JID);
    expect(result).toContain("No encontré");
  });

  it("delete_alarm sin ID ni search retorna error", async () => {
    const am = createIsolatedAlarmManager();
    const result = await executeAlarmTool("delete_alarm", {}, am, TEST_JID);
    expect(result).toContain("Error");
  });

  it("list_alarms sin alarmas retorna mensaje adecuado", async () => {
    const am = createIsolatedAlarmManager();
    const result = await executeAlarmTool("list_alarms", {}, am, TEST_JID);
    expect(result).toBe("No tienes ninguna alarma recurrente.");
  });

  it("list_alarms con alarmas retorna la lista", async () => {
    const am = createIsolatedAlarmManager();
    am.createAlarm(TEST_JID, "alarma test", 9, 30, [1, 3, 5]);
    const result = await executeAlarmTool("list_alarms", {}, am, TEST_JID);
    expect(result).toContain("ALARMAS RECURRENTES");
    expect(result).toContain("alarma test");
    expect(result).toContain("09:30");
  });

  it("toggle_alarm con ID válido cambia estado", async () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "alarma toggle", 10, 0, [1]);
    const shortId = a.id.slice(0, 8);
    const result = await executeAlarmTool("toggle_alarm", { id: shortId }, am, TEST_JID);
    expect(result).toContain("PAUSADA");

    const alarms = am.getUserAlarms(TEST_JID);
    expect(alarms[0]!.enabled).toBe(false);
  });

  it("toggle_alarm con ID inválido retorna no encontrado", async () => {
    const am = createIsolatedAlarmManager();
    const result = await executeAlarmTool("toggle_alarm", { id: "no-existe" }, am, TEST_JID);
    expect(result).toContain("No encontré");
  });

  it("tool desconocido retorna error", async () => {
    const am = createIsolatedAlarmManager();
    const result = await executeAlarmTool("unknown_tool", {}, am, TEST_JID);
    expect(result).toContain("Error");
    expect(result).toContain("unknown_tool");
  });
});

describe("AlarmManager — CRUD con días específicos", () => {
  it("lunes a viernes (1-5) se guarda correctamente", () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "entre semana", 9, 30, [1, 2, 3, 4, 5]);
    expect(a.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("fines de semana (0 y 6)", () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "fin de semana", 10, 0, [0, 6]);
    expect(a.daysOfWeek).toEqual([0, 6]);
  });

  it("día único", () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "solo lunes", 8, 0, [1]);
    expect(a.daysOfWeek).toEqual([1]);
  });

  it("días desordenados se ordenan en el constructor", () => {
    const am = createIsolatedAlarmManager();
    const a = am.createAlarm(TEST_JID, "desordenados", 12, 0, [5, 1, 3, 0, 6]);
    expect(a.daysOfWeek).toEqual([0, 1, 3, 5, 6]);
  });
});

describe("AlarmManager — normalización", () => {
  it("elimina días duplicados y los ordena", () => {
    const am = createIsolatedAlarmManager();
    const alarm = am.createAlarm(TEST_JID, "prueba", 8, 0, [5, 1, 5, 3, 1]);
    expect(alarm.daysOfWeek).toEqual([1, 3, 5]);
  });
});
