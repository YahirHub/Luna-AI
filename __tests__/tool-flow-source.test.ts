import { describe, expect, it } from "bun:test";

const botSource = await Bun.file(new URL("../src/bot.ts", import.meta.url)).text();
const contextSource = await Bun.file(new URL("../src/context.ts", import.meta.url)).text();

describe("flujo autoritativo de tools", () => {
  it("envía una confirmación visible y guarda un evento del sistema", () => {
    expect(botSource).toContain("buildVisibleSystemConfirmation(result)");
    expect(botSource).toContain("buildConfirmedToolEvent(name, result)");
    expect(botSource).toContain('role: "user"');
  });

  it("ya no persiste resultados de tools como afirmaciones assistant", () => {
    expect(botSource).not.toMatch(/role:\s*"assistant",\s*content:\s*result/s);
  });

  it("bloquea negaciones explícitas antes de crear", () => {
    expect(botSource).toContain("userExplicitlyBlocksScheduledCreation(userText, name)");
    expect(botSource).toContain("No se creó ninguna alarma ni recordatorio");
  });

  it("ofrece tools administrativas solo según el JID autenticado", () => {
    expect(botSource).toContain("getAvailableTools(remoteJid)");
    expect(botSource).toContain("if (jid && isAdminSession(jid))");
    expect(botSource).toContain("tools.push(...ADMIN_TOOLS)");
  });

  it("borra mensajes de contraseña en flujos pendientes", () => {
    expect(botSource).toContain('action.step === "awaiting-password"');
    expect(botSource).toContain("deleteSensitiveIncomingMessage(transport, message)");
  });

  it("el prompt reconoce solo resultados confirmados como evidencia", () => {
    expect(contextSource).toContain("Resultado de herramienta confirmado por el sistema");
    expect(contextSource).toContain("usa list_alarms o list_reminders antes de responder");
    expect(contextSource).toContain("Respeta con prioridad las negaciones");
  });
});
