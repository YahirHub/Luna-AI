import { describe, expect, it } from "bun:test";
import {
  buildConfirmedToolEvent,
  guardUnconfirmedScheduledCreationClaim,
  isConfirmedScheduledCreation,
  stripUnrelatedPendingNameQuestion,
  userExplicitlyBlocksScheduledCreation,
} from "../src/tool-confirmation.ts";

describe("confirmación autoritativa de herramientas", () => {
  it("bloquea una creación cuando el usuario la niega explícitamente", () => {
    expect(userExplicitlyBlocksScheduledCreation(
      "No creas ningún recordatorio, solo revisa si existe",
      "create_reminder",
    )).toBe(true);
    expect(userExplicitlyBlocksScheduledCreation(
      "No programes ninguna alarma",
      "create_alarm",
    )).toBe(true);
  });

  it("no bloquea una petición afirmativa clara", () => {
    expect(userExplicitlyBlocksScheduledCreation(
      "Crea un recordatorio para hoy a las 12:20",
      "create_reminder",
    )).toBe(false);
  });

  it("bloquea una recreación implícita cuando el usuario solo disputa el resultado", () => {
    expect(userExplicitlyBlocksScheduledCreation(
      "No creaste ningún recordatorio, no ejecutaste la herramienta",
      "create_reminder",
    )).toBe(true);
    expect(userExplicitlyBlocksScheduledCreation(
      "No me sale el recordatorio",
      "create_reminder",
    )).toBe(true);
  });

  it("permite un reintento pedido de forma inequívoca", () => {
    expect(userExplicitlyBlocksScheduledCreation(
      "No creaste el recordatorio; ahora sí créalo de nuevo",
      "create_reminder",
    )).toBe(false);
  });

  it("solo considera confirmada una creación exitosa", () => {
    expect(isConfirmedScheduledCreation(
      "create_reminder",
      "✅ Recordatorio creado exitosamente (ID: abc12345).",
    )).toBe(true);
    expect(isConfirmedScheduledCreation(
      "create_reminder",
      "Error: no se pudo crear",
    )).toBe(false);
  });

  it("marca el resultado persistido como evento del sistema", () => {
    const event = buildConfirmedToolEvent(
      "create_alarm",
      "✅ Alarma recurrente creada (ID: 12345678).",
    );
    expect(event).toContain("[Resultado de herramienta confirmado por el sistema]");
    expect(event).toContain("Estado: ejecución confirmada por el sistema");
    expect(event).toContain("create_alarm");
  });

  it("suprime una afirmación de alarma no respaldada", () => {
    const guarded = guardUnconfirmedScheduledCreationClaim(
      "Ahora que ya lo sabes, tu alarma de bañarse está configurada todos los días.",
      new Set(),
    );
    expect(guarded).toContain("ACCIÓN NO CONFIRMADA");
    expect(guarded).toContain("alarma");
    expect(guarded).not.toContain("bañarse está configurada");
  });

  it("no corrige una creación realmente confirmada del tipo correcto", () => {
    const text = "Listo, tu recordatorio quedó programado para las 12:20.";
    expect(guardUnconfirmedScheduledCreationClaim(
      text,
      new Set(["create_reminder"]),
    )).toBe(text);
  });

  it("no acepta una confirmación de recordatorio como prueba de alarma", () => {
    const guarded = guardUnconfirmedScheduledCreationClaim(
      "Tu alarma quedó programada para todos los días.",
      new Set(["create_reminder"]),
    );
    expect(guarded).toContain("ACCIÓN NO CONFIRMADA");
  });

  it("acepta describir el estado después de consultar la lista", () => {
    const result = guardUnconfirmedScheduledCreationClaim(
      "Tu recordatorio está pendiente para las 12:20.",
      new Set(["list_reminders"]),
    );
    expect(result).toBe("Tu recordatorio está pendiente para las 12:20.");
  });

  it("suprime una promesa de entrega sin creación confirmada", () => {
    const result = guardUnconfirmedScheduledCreationClaim(
      "Te va a llegar el recordatorio a las 12:20.",
      new Set(),
    );
    expect(result).toContain("ACCIÓN NO CONFIRMADA");
    expect(result).not.toContain("Te va a llegar");
  });

  it("suprime una promesa con el tipo mencionado antes del verbo", () => {
    const result = guardUnconfirmedScheduledCreationClaim(
      "El recordatorio te va a llegar en dos minutos.",
      new Set(),
    );
    expect(result).toContain("ACCIÓN NO CONFIRMADA");
    expect(result).not.toContain("te va a llegar");
  });

  it("elimina la pregunta pendiente del nombre en respuestas operativas", () => {
    const content = [
      "📄 Aquí tienes el contenido del informe.",
      "",
      "Y bueno, ya que estamos… ¿y tú cómo te llamas? 😊",
    ].join("\n");
    expect(stripUnrelatedPendingNameQuestion(
      content,
      "Dame el contenido del markdown generado",
      [],
    )).toBe("📄 Aquí tienes el contenido del informe.");
    expect(stripUnrelatedPendingNameQuestion(
      content,
      "Hola, ¿cómo estás?",
      [],
    )).toBe(content);
    expect(stripUnrelatedPendingNameQuestion(
      content,
      "Investiga precios y crea un PDF",
      ["spawn_agents"],
    )).toBe("📄 Aquí tienes el contenido del informe.");
  });

});
