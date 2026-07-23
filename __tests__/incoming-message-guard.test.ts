import { describe, expect, it } from "bun:test";

describe("mensajes entrantes sin contenido", () => {
  it("no envía eventos internos o vacíos al LLM", async () => {
    const source = await Bun.file(new URL("../src/bot.ts", import.meta.url)).text();

    expect(source).toContain("if (!mediaKind && !text.trim())");
  });

  it("permite que un adjunto llegue al orquestador sin OCR automático", async () => {
    const source = await Bun.file(new URL("../src/bot.ts", import.meta.url)).text();

    expect(source).toContain("attachmentManager.register(remoteJid, message)");
    expect(source).toContain("attachmentManager.buildIncomingContext(attachment, text)");
    expect(source).not.toContain("No enviaré una respuesta al asistente sin el resultado del OCR.");
  });
});
