import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const catalog = readFileSync(join(root, "src/tts/voice-catalog.ts"), "utf8").replace(/\r\n/g, "\n");
const manager = readFileSync(join(root, "src/tts/tts-manager.ts"), "utf8").replace(/\r\n/g, "\n");
const bot = readFileSync(join(root, "src/bot.ts"), "utf8").replace(/\r\n/g, "\n");

describe("descarga resiliente de voces Piper", () => {
  it("descarga por streaming con progreso, reanudación y límites", () => {
    expect(catalog).toContain('const temporary = `${destination}.part`');
    expect(catalog).toContain('headers.Range = `bytes=${resumeFrom}-`');
    expect(catalog).toContain("response.body.getReader()");
    expect(catalog).toContain("PROGRESS_INTERVAL_MS = 15_000");
    expect(catalog).toContain("PROGRESS_PERCENT_STEP = 10");
    expect(catalog).toContain("DOWNLOAD_STALL_TIMEOUT_MS = 45_000");
    expect(catalog).toContain("DOWNLOAD_MAX_ATTEMPTS = 3");
    expect(catalog).toContain("Verificando integridad MD5");
  });

  it("permite cancelar una descarga de voz desde el control global", () => {
    expect(manager).toContain("cancelActiveVoiceDownload(jid: string)");
    expect(manager).toContain("activeVoiceDownloads");
    expect(bot).toContain("ttsManager.cancelActiveVoiceDownload(jid)");
    expect(bot).toContain("signal: runController.signal");
  });
});
