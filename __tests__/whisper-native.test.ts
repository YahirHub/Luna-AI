import { describe, expect, it } from "bun:test";
import {
  buildWhisperArguments,
  encodePcm16Wav,
  type WhisperRuntime,
} from "../src/media-processing/whisper-native.ts";

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
    const runtime: WhisperRuntime = {
      root: "C:/runtime/whisper",
      executable: "C:/runtime/whisper/bin/whisper-cli.exe",
      model: "C:/runtime/whisper/models/base-q5_1.bin",
      libraryDirs: [],
      manifest: {
        schemaVersion: 1,
        version: "v1.9.1",
        platform: process.platform,
        arch: process.arch,
        assetName: "whisper-bin-x64.zip",
        assetDigest: "a".repeat(64),
        executable: "bin/whisper-cli.exe",
        model: "models/base-q5_1.bin",
        libraryDirs: [],
        preparedAt: new Date(0).toISOString(),
      },
    };
    const args = buildWhisperArguments(runtime, "audio.wav", "salida", 4);
    expect(args[0]).toBe(runtime.executable);
    expect(args).toContain("--language");
    expect(args).toContain("es");
    expect(args).toContain("--output-txt");
    expect(args).toContain("--no-gpu");
    expect(args).toContain("4");
  });
});
