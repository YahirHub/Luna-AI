import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bot = readFileSync(join(root, "src/bot.ts"), "utf8").replace(/\r\n/g, "\n");
const adapter = readFileSync(join(root, "src/transports/baileys/adapter.ts"), "utf8").replace(/\r\n/g, "\n");

describe("routing de adjuntos", () => {
  it("no procesa imágenes/audio automáticamente", () => {
    expect(bot).not.toContain("🎙️ Transcribiendo audio...");
    expect(bot).not.toContain("🖼️ Extrayendo texto de la imagen...");
    expect(bot).not.toContain("handleMediaMessage(");
    expect(bot).toContain("attachmentManager.register(remoteJid, message)");
    expect(bot).toContain("attachmentManager.buildIncomingContext(attachment, text)");
  });

  it("reconoce tipos comunes de archivo en Baileys", () => {
    for (const node of ["imageMessage", "audioMessage", "videoMessage", "documentMessage", "stickerMessage"]) {
      expect(adapter).toContain(node);
    }
  });
});
