import { describe, expect, it } from "bun:test";
import { detectTtsPersistentModeIntent, detectTtsTurnPreference, isTranscribedAudioMessage, sanitizeTextForSpeech } from "../src/tts/text-sanitizer.ts";

describe("filtro de texto para Piper Neo", () => {
  it("elimina Markdown, URLs, emojis y bloques de código sin destruir el texto natural", () => {
    const input = [
      "# Resultado 🚀",
      "**Hola**, mira [la documentación](https://example.com/docs).",
      "- Primer punto",
      "- Segundo punto `inline()`",
      "```js",
      "console.log('NO PRONUNCIAR');",
      "```",
      "Visita https://example.com y usa A & B.",
    ].join("\n");
    const output = sanitizeTextForSpeech(input);
    expect(output).toContain("Resultado");
    expect(output).toContain("Hola, mira la documentación.");
    expect(output).toContain("Primer punto");
    expect(output).toContain("Segundo punto inline()");
    expect(output).toContain("A y B");
    expect(output).not.toContain("console.log");
    expect(output).not.toContain("https://");
    expect(output).not.toContain("**");
    expect(output).not.toContain("🚀");
  });

  it("detecta preferencias explícitas de texto o voz", () => {
    expect(detectTtsTurnPreference("Respóndeme por mensaje de texto, no por audio")).toBe("text");
    expect(detectTtsTurnPreference("Mándame la respuesta en una nota de voz")).toBe("voice");
    expect(detectTtsTurnPreference("No quiero audios, entiendes? envíame texto")).toBe("text");
    expect(detectTtsTurnPreference("Ahora hablemos soloen texto")).toBe("text");
    expect(detectTtsTurnPreference("Prueba la voz de Cortana")).toBe("voice");
    expect(detectTtsTurnPreference("Ahora dame el resultado por voz")).toBe("voice");
    expect(detectTtsTurnPreference("Explícame cómo funciona")).toBeNull();
  });

  it("distingue cambios persistentes de preferencias de un solo turno", () => {
    expect(detectTtsPersistentModeIntent("Ahora hablemos soloen texto")).toBe("text");
    expect(detectTtsPersistentModeIntent("No quiero audios, entiendes?")).toBe("text");
    expect(detectTtsPersistentModeIntent("A partir de ahora respóndeme por voz")).toBe("voice");
    expect(detectTtsPersistentModeIntent("Ahora dame el resultado por voz")).toBeNull();
  });

  it("reconoce una entrada de audio transcrita o todavía pendiente como adjunto", () => {
    expect(isTranscribedAudioMessage("[Transcripción de audio generada por el sistema]\nHola Luna")).toBe(true);
    expect(isTranscribedAudioMessage("[ADJUNTO DISPONIBLE — NO DESCARGADO AUTOMÁTICAMENTE]\nID: ATT-12345678\nTipo: audio\nMIME: audio/ogg")).toBe(true);
    expect(isTranscribedAudioMessage("Hola Luna")).toBe(false);
  });
});
