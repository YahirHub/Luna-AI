import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface VoiceEntry {
  key: string;
  language: { code: string; family: string; name_native: string; name_english: string; country_english: string };
  quality: string;
  files: Record<string, { size_bytes: number; md5_digest: string }>;
}

describe("catálogo de voces Piper", () => {
  it("incluye voces oficiales con ONNX y configuración y permite filtrar español", () => {
    const catalog = JSON.parse(readFileSync(join(process.cwd(), "assets", "piper", "voices.json"), "utf8")) as Record<string, VoiceEntry>;
    const voices = Object.values(catalog);
    expect(voices.length).toBeGreaterThan(100);
    const spanish = voices.filter((voice) => voice.language.family === "es");
    expect(spanish.length).toBeGreaterThan(0);
    expect(spanish.some((voice) => voice.language.code === "es_MX")).toBe(true);
    for (const voice of voices.slice(0, 20)) {
      expect(Object.keys(voice.files).some((path) => path.endsWith(".onnx"))).toBe(true);
      expect(Object.keys(voice.files).some((path) => path.endsWith(".onnx.json"))).toBe(true);
    }
  });
});
