import { describe, expect, it } from "bun:test";

describe("mensajes multimedia visibles", () => {
  it("muestra un único estado para audio y otro para imagen", async () => {
    const source = await Bun.file(new URL("../src/bot.ts", import.meta.url)).text();

    expect(source).toContain("🎙️ Transcribiendo audio...");
    expect(source).toContain("🖼️ Extrayendo texto de la imagen...");
    expect(source).not.toContain("Audio recibido. Lo procesaré");
    expect(source).not.toContain("Preparando el modelo local");
    expect(source).not.toContain("TRANSCRIPCIÓN LOCAL");
    expect(source).not.toContain("TEXTO EXTRAÍDO");
  });
});
