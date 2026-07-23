import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const manager = readFileSync(join(root, "src/tts/tts-manager.ts"), "utf8").replace(/\r\n/g, "\n");
const tools = readFileSync(join(root, "src/tts/tts-tools.ts"), "utf8").replace(/\r\n/g, "\n");
const bot = readFileSync(join(root, "src/bot.ts"), "utf8").replace(/\r\n/g, "\n");

describe("integración de modelos Piper manuales", () => {
  it("usa persistent/piper/models y conserva official como reservado", () => {
    expect(manager).toContain('const globalModelsDir = join(appDir, "persistent", "piper", "models")');
    expect(manager).toContain('new ManualPiperModelCatalog(globalModelsDir)');
    expect(manager).toContain('kind: "manual"');
  });

  it("expone listado y selección al orquestador y comandos", () => {
    expect(tools).toContain('name: "tts_list_manual_models"');
    expect(tools).toContain('name: "tts_select_manual_model"');
    expect(bot).toContain('"usar-local"');
    expect(bot).toContain("formatManualModels()");
  });
});
