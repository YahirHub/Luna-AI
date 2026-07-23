import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManualPiperModelCatalog } from "../src/tts/manual-model-catalog.ts";

const roots: string[] = [];
function root(): string {
  const path = join(tmpdir(), `luna-piper-manual-${crypto.randomUUID()}`);
  roots.push(path);
  mkdirSync(path, { recursive: true });
  return path;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("modelos Piper colocados manualmente", () => {
  it("descubre .neo y pares .onnx + .onnx.json de forma recursiva", () => {
    const dir = root();
    mkdirSync(join(dir, "idiomas", "es", "narrador"), { recursive: true });
    writeFileSync(join(dir, "voz.neo"), "neo");
    writeFileSync(join(dir, "idiomas", "es", "narrador", "modelo.onnx"), "onnx");
    writeFileSync(join(dir, "idiomas", "es", "narrador", "modelo.onnx.json"), "{}");
    const models = new ManualPiperModelCatalog(dir).list();
    expect(models.map((model) => model.id)).toEqual(["idiomas/es/narrador/modelo", "voz"]);
    expect(models.find((model) => model.kind === "onnx")?.configPath?.endsWith("modelo.onnx.json")).toBe(true);
  });

  it("permite resolver una carpeta con un solo modelo como alias", () => {
    const dir = root();
    mkdirSync(join(dir, "ModeloPersonalizado"), { recursive: true });
    writeFileSync(join(dir, "ModeloPersonalizado", "voz.onnx"), "onnx");
    writeFileSync(join(dir, "ModeloPersonalizado", "voz.onnx.json"), "{}");
    expect(new ManualPiperModelCatalog(dir).resolve("ModeloPersonalizado").model?.id).toBe("ModeloPersonalizado/voz");
  });

  it("ignora official y reporta ONNX sin configuración", () => {
    const dir = root();
    mkdirSync(join(dir, "official", "managed"), { recursive: true });
    writeFileSync(join(dir, "official", "managed", "voice.neo"), "neo");
    writeFileSync(join(dir, "roto.onnx"), "onnx");
    const scan = new ManualPiperModelCatalog(dir).scan();
    expect(scan.models).toHaveLength(0);
    expect(scan.invalid[0]?.relativePath).toBe("roto.onnx");
  });
});
