import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WHISPER_CONFIG,
  WHISPER_MODEL_CATALOG,
  getWhisperModel,
  loadWhisperConfig,
  normalizeWhisperConfig,
  saveWhisperConfig,
} from "../src/whisper-config.ts";
import { WhisperSetupManager } from "../src/whisper-setup.ts";

const temporaryDirs: string[] = [];

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "luna-whisper-config-"));
  temporaryDirs.push(directory);
  return join(directory, "whisper.json");
}

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("configuración global de Whisper", () => {
  it("incluye el catálogo oficial y usa base-q5_1 por defecto", () => {
    expect(WHISPER_MODEL_CATALOG.length).toBeGreaterThanOrEqual(30);
    expect(getWhisperModel("base-q5_1")?.displaySize).toBe("57 MiB");
    expect(DEFAULT_WHISPER_CONFIG.modelId).toBe("base-q5_1");
  });

  it("normaliza parámetros fuera de rango", () => {
    const config = normalizeWhisperConfig({
      modelId: "desconocido",
      language: "ES-MX",
      threads: 99,
      bestOf: 0,
      beamSize: 50,
      temperature: 3,
      noSpeechThreshold: -2,
      maxAudioSeconds: 10,
      timeoutSeconds: 9_999,
    });
    expect(config.modelId).toBe("base-q5_1");
    expect(config.language).toBe("es");
    expect(config.threads).toBe(32);
    expect(config.bestOf).toBe(1);
    expect(config.beamSize).toBe(10);
    expect(config.temperature).toBe(1);
    expect(config.noSpeechThreshold).toBe(0);
    expect(config.maxAudioSeconds).toBe(30);
    expect(config.timeoutSeconds).toBe(3_600);
  });

  it("persiste la selección global atómicamente", () => {
    const path = temporaryPath();
    saveWhisperConfig({ ...DEFAULT_WHISPER_CONFIG, modelId: "small-q5_1", threads: 4 }, path);
    expect(loadWhisperConfig(path).modelId).toBe("small-q5_1");
    expect(JSON.parse(readFileSync(path, "utf8")).threads).toBe(4);
  });
});

describe("flujo !setup-whisper", () => {
  it("selecciona un modelo disponible y lo deja como predeterminado global", async () => {
    const path = temporaryPath();
    const manager = new WhisperSetupManager(
      path,
      async () => "unused",
      (modelId) => modelId === "tiny-q5_1" || modelId === "base-q5_1",
      () => 0,
    );
    const jid = "admin@s.whatsapp.net";
    expect(manager.start(jid)).toContain("CONFIGURACIÓN GLOBAL DE WHISPER");
    await manager.submit(jid, "1");
    const result = await manager.submit(jid, "1");
    expect(result.text).toContain("tiny-q5_1");
    expect(loadWhisperConfig(path).modelId).toBe("tiny-q5_1");
  });

  it("descarga antes de activar un modelo ausente", async () => {
    const path = temporaryPath();
    const downloaded: string[] = [];
    const manager = new WhisperSetupManager(
      path,
      async (modelId, progress) => {
        downloaded.push(modelId);
        await progress?.({
          model: getWhisperModel(modelId)!,
          downloadedBytes: 1,
          totalBytes: 1,
          percent: 100,
        });
        return "modelo.bin";
      },
      (modelId) => modelId === "base-q5_1",
      () => 0,
    );
    const jid = "admin@s.whatsapp.net";
    manager.start(jid);
    await manager.submit(jid, "1");
    await manager.submit(jid, "13"); // small-q5_1
    const result = await manager.submit(jid, "si");
    expect(downloaded).toEqual(["small-q5_1"]);
    expect(result.text).toContain("descargado y activado");
    expect(loadWhisperConfig(path).modelId).toBe("small-q5_1");
  });
});
