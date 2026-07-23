import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bot = readFileSync(join(root, "src/bot.ts"), "utf8").replace(/\r\n/g, "\n");

describe("control foreground del orquestador", () => {
  it("mantiene estado autoritativo para progreso y cancelación sin esperar el lock", () => {
    expect(bot).toContain("const activeAiRunStates = new Map<string, ForegroundAiRunState>();");
    expect(bot).toContain("activeAiRuns.has(remoteJid) && isForegroundProgressQuestion(text)");
    expect(bot).toContain("formatForegroundProgressForUser(remoteJid)");
    expect(bot).toContain('updateForegroundState({ phase: "tool", toolName: name });');
    expect(bot).toContain('updateForegroundState({ phase: "model", toolName: undefined });');
    expect(bot).toContain('updateForegroundState({ phase: "responding", toolName: undefined });');
    expect(bot).toContain('activeRun.abort(new Error("user-cancelled-current-operation"));');
  });

  it("informa herramientas de workspace que pueden tardar", () => {
    expect(bot).toContain('["workspace_exec", "⚙️ Ejecutando comando en tu entorno..."]');
    expect(bot).toContain('["workspace_apply_patch", "🧩 Aplicando cambios al proyecto..."]');
    expect(bot).toContain('["workspace_delete", "🗑️ Eliminando archivo del workdir..."]');
  });
});
