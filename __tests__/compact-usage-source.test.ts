import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bot = readFileSync(join(root, "src/bot.ts"), "utf8");
const ai = readFileSync(join(root, "src/ai.ts"), "utf8");

describe("/compact y /uso", () => {
  it("registra los comandos y no bloquea mensajes mientras compacta", () => {
    expect(bot).toContain('registerCommand(\n  "compact"');
    expect(bot).toContain('registerCommand(\n  "uso"');
    expect(bot).toContain("maybeStartAutomaticCompaction(sock, remoteJid)");
    expect(bot).not.toContain("if (compactingJids.has(remoteJid))");
    expect(bot).toContain("applyCompactionSnapshot");
  });

  it("tolera providers con usage real, parcial o ausente", () => {
    expect(ai).toContain("providerPromptTokens");
    expect(ai).toContain('source: LlmUsageSource');
    expect(ai).toContain('"estimated"');
    expect(ai).toContain('"mixed"');
    expect(ai).toContain("estimatedPromptTokens");
  });
});
