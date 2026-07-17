import { describe, it, expect, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { ReminderManager, REMINDER_TOOLS, executeReminderTool, determineReminderDate } from "../src/reminder.ts";

// ─── Helpers ─────────────────────────────────────────────────────

let testCounter = 0;
const TEST_DIRS: string[] = [];

function createIsolatedReminder(): ReminderManager {
  testCounter++;
  const dir = join(tmpdir(), `codewolf-reminder-test-${Date.now()}-${testCounter}`);
  TEST_DIRS.push(dir);
  return new ReminderManager(dir);
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

describe("ReminderManager — creación", () => {
  it("createReminder guarda un recordatorio con los campos correctos", () => {
    const rm = createIsolatedReminder();
    const reminder = rm.createReminder(TEST_JID, "ir por mi hermana", 8, 44);

    expect(reminder.text).toBe("ir por mi hermana");
    expect(reminder.deliveryMessage).toContain("ir por mi hermana");
    expect(reminder.deliveryMessage).toContain("😊");
    expect(reminder.hour).toBe(8);
    expect(reminder.minute).toBe(44);
    expect(reminder.jid).toBe(TEST_JID);
    expect(reminder.fired).toBe(false);
    expect(reminder.id).toBeDefined();
    expect(reminder.id.length).toBeGreaterThan(0);
    expect(reminder.createdAt).toBeDefined();
  });

  it("persiste el mensaje preparado dentro del sandbox y lo conserva después de reiniciar", () => {
    const dir = join(tmpdir(), `codewolf-reminder-copy-${Date.now()}`);
    const userDir = join(dir, TEST_JID);
    const path = join(userDir, "reminders.json");
    TEST_DIRS.push(dir);

    const first = new ReminderManager(dir);
    first.createReminder(
      TEST_JID,
      "tomar medicamentos",
      10,
      37,
      "2026-07-17",
      "¡Hey! 😊 Ya es hora de tomar tus medicamentos 💊",
    );

    expect(existsSync(path)).toBe(true);
    const reloaded = new ReminderManager(dir);
    expect(reloaded.getUserReminders(TEST_JID)[0]?.deliveryMessage).toBe(
      "¡Hey! 😊 Ya es hora de tomar tus medicamentos 💊",
    );
  });

  it("ignora el antiguo archivo global y no crea una migración automática", () => {
    const dir = join(tmpdir(), `codewolf-reminder-no-migration-${Date.now()}`);
    const globalPath = join(dir, "reminders.json");
    const userPath = join(dir, TEST_JID, "reminders.json");
    TEST_DIRS.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      globalPath,
      JSON.stringify({
        reminders: [{
          id: "legacy-global",
          jid: TEST_JID,
          text: "no migrar",
          deliveryMessage: "No migrar",
          hour: 12,
          minute: 0,
          date: "2026-07-17",
          createdAt: "2026-07-17T00:00:00.000Z",
          fired: false,
        }],
      }),
    );

    const manager = new ReminderManager(dir);
    expect(manager.getAll()).toHaveLength(0);
    expect(existsSync(userPath)).toBe(false);
    expect(existsSync(globalPath)).toBe(true);
  });

  it("dos usuarios mantienen reminders.json separados", () => {
    const dir = join(tmpdir(), `codewolf-reminder-multi-user-${Date.now()}`);
    TEST_DIRS.push(dir);
    const manager = new ReminderManager(dir);
    manager.createReminder("user1@test.com", "recordatorio uno", 8, 0);
    manager.createReminder("user2@test.com", "recordatorio dos", 9, 0);

    const user1Path = join(dir, "user1@test.com", "reminders.json");
    const user2Path = join(dir, "user2@test.com", "reminders.json");
    expect(existsSync(user1Path)).toBe(true);
    expect(existsSync(user2Path)).toBe(true);

    const first = JSON.parse(readFileSync(user1Path, "utf8"));
    const second = JSON.parse(readFileSync(user2Path, "utf8"));
    expect(first.reminders).toHaveLength(1);
    expect(first.reminders[0].jid).toBe("user1@test.com");
    expect(second.reminders).toHaveLength(1);
    expect(second.reminders[0].jid).toBe("user2@test.com");
  });

  it("createReminder asigna id unico a cada recordatorio", () => {
    const rm = createIsolatedReminder();
    const r1 = rm.createReminder(TEST_JID, "cosa 1", 10, 0);
    const r2 = rm.createReminder(TEST_JID, "cosa 2", 11, 0);
    expect(r1.id).not.toBe(r2.id);
  });

  it("createReminder con date explicito usa esa fecha", () => {
    const rm = createIsolatedReminder();
    const reminder = rm.createReminder(TEST_JID, "evento especial", 15, 30, "2026-12-25");
    expect(reminder.date).toBe("2026-12-25");
  });

  it("getAll retorna copia de todos los recordatorios", () => {
    const rm = createIsolatedReminder();
    rm.createReminder(TEST_JID, "uno", 10, 0);
    rm.createReminder(TEST_JID, "dos", 11, 0);

    const all = rm.getAll();
    expect(all).toHaveLength(2);
    expect(all[0]?.text).toBe("uno");
    expect(all[1]?.text).toBe("dos");
  });
});

describe("ReminderManager — markFired", () => {
  it("markFired marca el recordatorio como disparado", () => {
    const rm = createIsolatedReminder();
    const r = rm.createReminder(TEST_JID, "prueba", 12, 0);

    expect(r.fired).toBe(false);
    rm.markFired(r.id);
    const all = rm.getAll();
    const updated = all.find((x) => x.id === r.id);
    expect(updated?.fired).toBe(true);
  });

  it("getDueReminders no incluye recordatorios ya disparados", () => {
    const rm = createIsolatedReminder();
    // Crear un recordatorio para la hora actual y marcarlo como disparado
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const r = rm.createReminder(TEST_JID, "ya disparado", h, m);
    rm.markFired(r.id);

    const due = rm.getDueReminders();
    const found = due.find((x) => x.id === r.id);
    expect(found).toBeUndefined();
  });
});

describe("ReminderManager — reintentos", () => {
  it("persiste una entrega pendiente para reintentar después de reiniciar", () => {
    const dir = join(tmpdir(), `codewolf-reminder-retry-${Date.now()}`);
    TEST_DIRS.push(dir);

    const first = new ReminderManager(dir);
    const reminder = first.createReminder(
      TEST_JID,
      "entrega pendiente",
      0,
      0,
      "2000-01-01",
    );
    const internal = first as unknown as {
      markDeliveryPending(id: string): void;
    };
    internal.markDeliveryPending(reminder.id);

    const reloaded = new ReminderManager(dir);
    expect(
      reloaded.getDueReminders().some((item) => item.id === reminder.id),
    ).toBe(true);
  });
});

describe("ReminderManager — setSock / getSock", () => {
  it("setSock y getSock funcionan", () => {
    const rm = createIsolatedReminder();
    expect(rm.getSock()).toBeNull();

    const fakeSock = {} as any;
    rm.setSock(fakeSock);
    expect(rm.getSock()).toBe(fakeSock);

    rm.setSock(null);
    expect(rm.getSock()).toBeNull();
  });
});

describe("REMINDER_TOOLS — definiciones", () => {
  it("exporta exactamente 3 tools", () => {
    expect(REMINDER_TOOLS).toHaveLength(3);
  });

  it("incluye create_reminder, delete_reminder, list_reminders", () => {
    const names = REMINDER_TOOLS.map((t) => t.function.name);
    expect(names).toContain("create_reminder");
    expect(names).toContain("delete_reminder");
    expect(names).toContain("list_reminders");
  });

  it("create_reminder requiere text, hour, minute", () => {
    const tool = REMINDER_TOOLS.find((t) => t.function.name === "create_reminder")!;
    const required = (tool.function.parameters as any)?.required;
    expect(required).toContain("text");
    expect(required).toContain("delivery_message");
    expect(required).toContain("hour");
    expect(required).toContain("minute");
  });

  it("tiene type function", () => {
    for (const tool of REMINDER_TOOLS) {
      expect(tool.type).toBe("function");
    }
  });
});

// ─── Tests de determineReminderDate (función pura) ────────────────

describe("determineReminderDate", () => {
  it("hora futura se agenda hoy", () => {
    // ahora son las 10:00, target son las 14:30
    const date = determineReminderDate(14, 30, 10 * 60 + 0, "2026-07-16");
    expect(date).toBe("2026-07-16");
  });

  it("hora exactamente ahora se agenda hoy", () => {
    // ahora son las 10:00, target son las 10:00
    const date = determineReminderDate(10, 0, 10 * 60 + 0, "2026-07-16");
    expect(date).toBe("2026-07-16");
  });

  it("hora 5 min atras (dentro de tolerancia 10min) se agenda hoy", () => {
    // ahora son las 10:05, target son las 10:00 → dentro de tolerancia
    const date = determineReminderDate(10, 0, 10 * 60 + 5, "2026-07-16");
    expect(date).toBe("2026-07-16");
  });

  it("BUG REPORTADO: 9:01 target, ahora 9:02 → tolerado como hoy", () => {
    // El AI pasó 9:01 y el tool call se ejecutó a las 9:02
    const date = determineReminderDate(9, 1, 9 * 60 + 2, "2026-07-16");
    expect(date).toBe("2026-07-16");
  });

  it("BUG REPORTADO: 9:00 target, ahora 9:01 → tolerado como hoy", () => {
    // El AI pasó 9:00 y el tool call se ejecutó a las 9:01
    const date = determineReminderDate(9, 0, 9 * 60 + 1, "2026-07-16");
    expect(date).toBe("2026-07-16");
  });

  it("hora 11 min atras (fuera de tolerancia 10min) se agenda manana", () => {
    // ahora son las 10:11, target son las 10:00 → fuera de tolerancia
    const date = determineReminderDate(10, 0, 10 * 60 + 11, "2026-07-16");
    expect(date).toBe("2026-07-17");
  });

  it("hora exactamente en el limite de tolerancia (10 min) se agenda hoy", () => {
    // ahora son las 10:10, target son las 10:00 → justo en el limite
    const date = determineReminderDate(10, 0, 10 * 60 + 10, "2026-07-16");
    expect(date).toBe("2026-07-16");
  });

  it("hora justo fuera del limite (11 min) se agenda manana", () => {
    // ahora son las 10:11, target son las 10:00 → 1 minuto fuera
    const date = determineReminderDate(10, 0, 10 * 60 + 11, "2026-07-16");
    expect(date).toBe("2026-07-17");
  });

  it("cruce de medianoche: target 00:02, ahora 23:55 del dia anterior (futuro manana)", () => {
    // Ahora 23:55 del 2026-07-16, target 00:02 → es mañana 2026-07-17
    const date = determineReminderDate(0, 2, 23 * 60 + 55, "2026-07-16");
    expect(date).toBe("2026-07-17");
  });

  it("cruce de medianoche: target 23:55, ahora 00:02 (futuro hoy mismo)", () => {
    // Ahora 00:02 del 2026-07-17, target 23:55 → es hoy (futuro)
    const date = determineReminderDate(23, 55, 0 * 60 + 2, "2026-07-17");
    expect(date).toBe("2026-07-17");
  });

  it("medianoche: target 00:05, ahora 00:07 dentro de tolerancia → hoy", () => {
    // target hace 2 min, dentro de tolerancia
    const date = determineReminderDate(0, 5, 0 * 60 + 7, "2026-07-17");
    expect(date).toBe("2026-07-17");
  });

  it("medianoche: target 00:03, ahora 00:15 fuera de tolerancia → manana", () => {
    // target hace 12 min, fuera de tolerancia
    const date = determineReminderDate(0, 3, 0 * 60 + 15, "2026-07-17");
    expect(date).toBe("2026-07-18");
  });

  it("tolerance personalizada de 2 min", () => {
    // ahora 10:03, target 10:00, tolerance=2 → fuera
    const date = determineReminderDate(10, 0, 10 * 60 + 3, "2026-07-16", 2);
    expect(date).toBe("2026-07-17");
  });

  it("tolerance personalizada de 2 min, dentro", () => {
    // ahora 10:02, target 10:00, tolerance=2 → dentro
    const date = determineReminderDate(10, 0, 10 * 60 + 2, "2026-07-16", 2);
    expect(date).toBe("2026-07-16");
  });
});

describe("executeReminderTool", () => {
  it("create_reminder con datos validos retorna exito", async () => {
    const rm = createIsolatedReminder();
    const result = await executeReminderTool(
      "create_reminder",
      {
        text: "comprar leche",
        delivery_message: "¡Oye! 😊 No olvides comprar la leche.",
        hour: 18,
        minute: 30,
      },
      rm,
      TEST_JID,
    );

    expect(result).toContain("Recordatorio creado");
    expect(result).toContain("comprar leche");
    expect(result).toContain("18:30");

    const all = rm.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe("comprar leche");
    expect(all[0]?.deliveryMessage).toBe("¡Oye! 😊 No olvides comprar la leche.");
  });

  it("create_reminder con text vacio retorna error", async () => {
    const rm = createIsolatedReminder();
    const result = await executeReminderTool(
      "create_reminder",
      { text: "", hour: 10, minute: 0 },
      rm,
      TEST_JID,
    );
    expect(result).toContain("Error");
  });

  it("create_reminder con hora invalida retorna error", async () => {
    const rm = createIsolatedReminder();
    const result = await executeReminderTool(
      "create_reminder",
      { text: "test", hour: 99, minute: 0 },
      rm,
      TEST_JID,
    );
    expect(result).toContain("Error");
  });

  it("create_reminder con minuto invalido retorna error", async () => {
    const rm = createIsolatedReminder();
    const result = await executeReminderTool(
      "create_reminder",
      { text: "test", hour: 10, minute: 99 },
      rm,
      TEST_JID,
    );
    expect(result).toContain("Error");
  });

  it("tool desconocido retorna error", async () => {
    const rm = createIsolatedReminder();
    const result = await executeReminderTool("unknown_tool", {}, rm, TEST_JID);
    expect(result).toContain("Error");
    expect(result).toContain("unknown_tool");
  });


  it("list_reminders y delete_reminder respetan el sandbox del usuario", async () => {
    const rm = createIsolatedReminder();
    const own = rm.createReminder(TEST_JID, "recordatorio propio", 10, 0);
    const other = rm.createReminder("other@test.com", "recordatorio ajeno", 11, 0);

    const list = await executeReminderTool("list_reminders", {}, rm, TEST_JID);
    expect(list).toContain("recordatorio propio");
    expect(list).not.toContain("recordatorio ajeno");

    const denied = await executeReminderTool(
      "delete_reminder",
      { id: other.id.slice(0, 8) },
      rm,
      TEST_JID,
    );
    expect(denied).toContain("No encontre");
    expect(rm.getUserReminders("other@test.com")).toHaveLength(1);

    const deleted = await executeReminderTool(
      "delete_reminder",
      { id: own.id.slice(0, 8) },
      rm,
      TEST_JID,
    );
    expect(deleted).toContain("Recordatorio eliminado");
    expect(rm.getUserReminders(TEST_JID)).toHaveLength(0);
    expect(rm.getUserReminders("other@test.com")).toHaveLength(1);
  });
  it("create_reminder guarda con date explicito", async () => {
    const rm = createIsolatedReminder();
    await executeReminderTool(
      "create_reminder",
      { text: "navidad", hour: 12, minute: 0, date: "2026-12-25" },
      rm,
      TEST_JID,
    );

    const all = rm.getAll();
    expect(all[0]?.date).toBe("2026-12-25");
  });
});

describe("executeReminderTool — límites de entrada", () => {
  it("rechaza fechas inexistentes", async () => {
    const rm = createIsolatedReminder();
    const result = await executeReminderTool(
      "create_reminder",
      { text: "fecha inválida", hour: 10, minute: 0, date: "2026-02-30" },
      rm,
      TEST_JID,
    );
    expect(result).toContain("Error");
    expect(rm.getAll()).toHaveLength(0);
  });

  it("rechaza textos mayores a 500 caracteres", async () => {
    const rm = createIsolatedReminder();
    const result = await executeReminderTool(
      "create_reminder",
      { text: "x".repeat(501), hour: 10, minute: 0 },
      rm,
      TEST_JID,
    );
    expect(result).toContain("500");
    expect(rm.getAll()).toHaveLength(0);
  });
});
