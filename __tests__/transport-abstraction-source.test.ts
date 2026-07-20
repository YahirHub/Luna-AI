import { describe, expect, it } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

describe("arquitectura de transportes", () => {
  it("mantiene Baileys fuera del núcleo de bot, comandos, media y mensajería", async () => {
    const files = await Promise.all([
      source("../src/bot.ts"),
      source("../src/commands.ts"),
      source("../src/media.ts"),
      source("../src/messaging.ts"),
      source("../src/scheduled-messages.ts"),
    ]);
    for (const content of files) {
      expect(content).not.toContain("@whiskeysockets/baileys");
      expect(content).not.toContain("WASocket");
      expect(content).not.toContain("WAMessage");
    }
  });

  it("concentra presencia y simulación de escritura en el adaptador Baileys", async () => {
    const adapter = await source("../src/transports/baileys/adapter.ts");
    const genericMessaging = await source("../src/messaging.ts");
    expect(adapter).toContain('sendPresenceUpdate(state, conversationId)');
    expect(adapter).toContain('await this.simulateTyping(item)');
    expect(genericMessaging).not.toContain("sendPresenceUpdate");
    expect(genericMessaging).not.toContain('"composing"');
  });

  it("permite agregar otro cliente mediante un runner sin modificar bot.ts", async () => {
    const types = await source("../src/transports/types.ts");
    const factory = await source("../src/transports/factory.ts");
    expect(types).toContain("export interface MessagingTransport");
    expect(types).toContain("export interface TransportRunner");
    expect(factory).toContain("createTransportRunner");
    expect(factory).toContain('await import("./baileys/runner.ts")');
  });

  it("usa herramienta de envío genérica con detección de rutas", async () => {
    const tool = await source("../src/tools/messaging-tools.ts");
    expect(tool).toContain('name: "message_send"');
    expect(tool).toContain("workspace.resolvePath");
    expect(tool).toContain('mode: "auto"');
  });
});
