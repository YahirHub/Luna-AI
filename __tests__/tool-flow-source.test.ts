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

  it("ofrece tools según el registro modular y la sesión autenticada", () => {
    expect(botSource).toContain("getAvailableTools(remoteJid)");
    expect(botSource).toContain("moduleRegistry.filterTools(pool, session)");
    expect(botSource).toContain("if (!session.authenticated) return []");
  });

  it("borra mensajes de contraseña en flujos pendientes", () => {
    expect(botSource).toContain('action.step === "awaiting-password"');
    expect(botSource).toContain("deleteSensitiveIncomingMessage(sock, message)");
  });

  it("el prompt base y módulos reconocen solo resultados confirmados como evidencia", async () => {
    const automation = await Bun.file(new URL("../src/modules/automation/module.ts", import.meta.url)).text();
    expect(contextSource).toContain("Solo un resultado confirmado de herramienta");
    expect(automation).toContain("lista primero antes de crear duplicados");
    expect(contextSource).toContain("Respeta con prioridad las negaciones");
  });
});
