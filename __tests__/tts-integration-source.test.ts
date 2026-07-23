import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const bot = readFileSync(join(root, "src/bot.ts"), "utf8").replace(/\r\n/g, "\n");
const moduleSource = readFileSync(join(root, "src/modules/tts/module.ts"), "utf8").replace(/\r\n/g, "\n");
const manager = readFileSync(join(root, "src/tts/tts-manager.ts"), "utf8").replace(/\r\n/g, "\n");

describe("integración Piper Neo adaptativa", () => {
  it("inyecta política TTS por turno y mantiene tts_speak como terminal", () => {
    expect(bot).toContain('bindContextProvider("tts", (message, session) =>');
    expect(bot).toContain("ttsManager.buildTurnGuidance(session.jid, message)");
    expect(bot).toContain('"tts_speak"');
    expect(bot).toContain("payload.spoken_text");
  });

  it("solo fuerza voz automáticamente cuando la política lo exige", () => {
    expect(bot).toContain("ttsManager.shouldForceVoice(remoteJid, userText)");
    expect(manager).toContain("sanitizeTextForSpeech(rawText)");
  });

  it("expone modo adaptativo, texto y voz al orquestador", () => {
    expect(moduleSource).toContain('{ name: "tts_set_mode" }');
    expect(moduleSource).toContain("always: true");
    expect(moduleSource.toLowerCase()).toContain("modo adaptativo");
  });
});
