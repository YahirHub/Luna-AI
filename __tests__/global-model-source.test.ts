import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

describe("modelo LLM global", () => {
  it("ignora selecciones antiguas persistidas por conversación", () => {
    const context = source("src/context.ts");
    expect(context).toContain("delete data.model");
    expect(context).toContain("getModel(_jid: string): string");
    expect(context).toContain("return this.defaultModel");
  });

  it("cambiar modelo actualiza la selección global persistente", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("function applyGlobalModelSelection(model: string)");
    expect(bot).toContain("saveGlobalLlmModel(llmConfig, llmConfigPath)");
    expect(bot).toContain("contextManager.setGlobalModel(llmConfig.defaultModel)");
  });

  it("configurar un provider fija inmediatamente su modelo como global", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("saveGlobalLlmModel(savedConfig, llmConfigPath)");
    expect(bot).toContain("Este modelo queda activo globalmente para todos los chats existentes y nuevos.");
  });
});
