import { describe, expect, it } from "bun:test";

describe("mensajes multimedia bajo demanda", () => {
  it("no muestra estados de OCR o transcripción en WhatsApp", async () => {
    const source = await Bun.file(new URL("../src/bot.ts", import.meta.url)).text();
    expect(source).not.toContain("🎙️ Transcribiendo audio...");
    expect(source).not.toContain("🖼️ Extrayendo texto de la imagen...");
    expect(source).toContain("attachmentManager.register(remoteJid, message)");
  });

  it("trata OCR/transcripciones como resultados bajo demanda y potencialmente ambiguos", async () => {
    const contextSource = await Bun.file(new URL("../src/context.ts", import.meta.url)).text();
    expect(contextSource).toContain("ADJUNTOS Y TRANSCRIPCIONES BAJO DEMANDA");
    expect(contextSource).toContain("attachment_ocr");
    expect(contextSource).toContain("attachment_transcribe_audio");
    expect(contextSource).toContain("pide una aclaración breve antes de ejecutarla");
  });
});
