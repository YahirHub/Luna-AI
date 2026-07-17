import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_WHISPER_CONFIG } from "../src/whisper-config.ts";
import {
  buildWhisperArguments,
  buildWhisperEnvironment,
  encodePcm16Wav,
  type WhisperRuntime,
} from "../src/media-processing/whisper-native.ts";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("runtime nativo de whisper.cpp", () => {
  it("genera WAV PCM mono de 16 bits", () => {
    const wav = encodePcm16Wav(new Float32Array([-1, 0, 1]), 16_000);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(48, true)).toBe(32_767);
  });

  it("invoca whisper-cli en español y produce texto", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-whisper-runtime-"));
    temporaryDirs.push(root);
    const executable = join(root, "bin", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
    const model = join(root, "models", "ggml-base-q5_1.bin");
    mkdirSync(dirname(executable), { recursive: true });
    mkdirSync(dirname(model), { recursive: true });
    writeFileSync(executable, "test");
    writeFileSync(model, "test");
    const runtime: WhisperRuntime = {
      root,
      executable,
      model,
      libraryDirs: [],
      manifest: {
        schemaVersion: 1,
        version: "v1.9.1",
        platform: process.platform,
        arch: process.arch,
        assetName: "whisper-bin-x64.zip",
        assetDigest: "a".repeat(64),
        executable: "bin/whisper-cli.exe",
        model: "models/ggml-base-q5_1.bin",
        libraryDirs: [],
        preparedAt: new Date(0).toISOString(),
      },
    };
    const args = buildWhisperArguments(runtime, "audio.wav", "salida", {
      ...DEFAULT_WHISPER_CONFIG,
      threads: 4,
      language: "auto",
      translateToEnglish: true,
      temperature: 0.2,
    });
    expect(args[0]).toBe(runtime.executable);
    expect(args).toContain("--language");
    expect(args).toContain("auto");
    expect(args).toContain("--output-txt");
    expect(args).toContain("--no-gpu");
    expect(args).toContain("4");
    expect(args).toContain("--best-of");
    expect(args).toContain("--beam-size");
    expect(args).toContain("--temperature");
    expect(args).toContain("--translate");
  });
  it("agrega el runtime a LD_LIBRARY_PATH en Linux", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-whisper-env-"));
    temporaryDirs.push(root);
    const executable = join(root, "bin", "whisper-cli");
    const libraryDir = join(root, "lib");
    const model = join(root, "models", "ggml-base-q5_1.bin");
    mkdirSync(dirname(executable), { recursive: true });
    mkdirSync(libraryDir, { recursive: true });
    mkdirSync(dirname(model), { recursive: true });
    writeFileSync(executable, "test");
    writeFileSync(join(libraryDir, "libwhisper.so.1"), "test");
    writeFileSync(model, "test");
    const runtime: WhisperRuntime = {
      root,
      executable,
      model,
      libraryDirs: [libraryDir],
      manifest: {
        schemaVersion: 1,
        version: "v1.9.1",
        platform: "linux",
        arch: "x64",
        assetName: "whisper-bin-ubuntu-x64.tar.gz",
        assetDigest: "a".repeat(64),
        executable: "bin/whisper-cli",
        model: "models/ggml-base-q5_1.bin",
        libraryDirs: ["lib"],
        preparedAt: new Date(0).toISOString(),
      },
    };

    const env = buildWhisperEnvironment(runtime, {
      platform: "linux",
      environment: { PATH: "/usr/bin", LD_LIBRARY_PATH: "/opt/libs" },
      pathDelimiter: ":",
    });

    expect(env.LD_LIBRARY_PATH).toContain(dirname(executable));
    expect(env.LD_LIBRARY_PATH).toContain(libraryDir);
    expect(env.LD_LIBRARY_PATH).toContain("/opt/libs");
    expect(env.PATH).toContain("/usr/bin");
  });

});
