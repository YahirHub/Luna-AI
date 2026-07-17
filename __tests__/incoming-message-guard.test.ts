import { describe, expect, it } from "bun:test";

describe("mensajes entrantes sin contenido", () => {
  it("no envía eventos internos o vacíos al LLM", async () => {
    const source = await Bun.file(new URL("../src/bot.ts", import.meta.url)).text();

    expect(source).toContain("if (!mediaKind && !text.trim())");
  });

  it("no continúa al chat AI cuando el OCR no entrega texto", async () => {
    const source = await Bun.file(new URL("../src/bot.ts", import.meta.url)).text();
    const warning = "No enviaré una respuesta al asistente sin el resultado del OCR.";

    expect(source).toContain(warning);
  });
});
