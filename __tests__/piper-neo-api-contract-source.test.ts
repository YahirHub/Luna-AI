import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/tts/piper-neo-runtime.ts"), "utf8").replace(/\r\n/g, "\n");
const manager = readFileSync(join(process.cwd(), "src/tts/tts-manager.ts"), "utf8").replace(/\r\n/g, "\n");

describe("contrato HTTP oficial de Piper Neo", () => {
  it("arranca el servidor con --server --models y valida /api/health", () => {
    expect(source).toContain('["--server", "--models", modelsDir]');
    expect(source).toContain('`${baseUrl}/api/health`');
    expect(source).toContain('payload?.success === true && payload.data?.status === "ok"');
    expect(source).not.toContain('for (const path of ["/voices", "/health", "/", "/docs", "/openapi.json"])');
  });

  it("sintetiza exclusivamente mediante POST /api/v1/tts y descarga data.url", () => {
    expect(source).toContain('`${baseUrl}/api/v1/tts`');
    expect(source).toContain('const model = basename(request.modelPath)');
    expect(source).toContain('envelope.data?.url');
    expect(source).toContain('/api/v1/files/');
    expect(source).toContain('sameOriginFileUrl(baseUrl, audioPath)');
    expect(source).not.toContain('"/v1/audio/speech"');
    expect(source).not.toContain('"/api/tts"');
    expect(source).not.toContain('"/tts"');
  });

  it("propaga la cancelación del turno hasta la API/CLI de Piper", () => {
    expect(manager).toContain("signal: options.signal");
    expect(source).toContain("AbortSignal.any([signal, timeout])");
    expect(source).toContain('request.signal?.addEventListener("abort", cancel');
  });
});
