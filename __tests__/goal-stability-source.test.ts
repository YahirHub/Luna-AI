import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const goal = readFileSync(join(root, "src/goals/goal-runtime.ts"), "utf8").replace(/\r\n/g, "\n");
const bot = readFileSync(join(root, "src/bot.ts"), "utf8").replace(/\r\n/g, "\n");

 describe("estabilidad de GoalRuntime", () => {
  it("no reinyecta los pendientes deterministas como pasos nuevos", () => {
    expect(goal).toContain("let verifierRan = false");
    expect(goal).toContain("if (verifierRan && verifier.missing.length)");
    expect(goal).not.toContain("if (verifier.missing.length) {\n        this.deps.tasklists.addItems");
  });

  it("protege el plan y detecta falta de progreso real", () => {
    expect(goal).toContain("tasklist_replace solo está permitido durante la planificación inicial");
    expect(goal).toContain("no puedes ampliar la tasklist tras una iteración sin progreso");
    expect(goal).toContain("currentTasklist.items.length >= 30");
    expect(goal).toContain("(^|\\/)tasks(?:\\/|\\s|$)");
  });

  it("reutiliza investigaciones previas antes de lanzar agentes equivalentes", () => {
    expect(goal).toContain('status: "reused_previous_research"');
    expect(goal).toContain("getDelegatedTaskContext");
    expect(goal).toContain("RESULTADOS DE INVESTIGACIONES PREVIAS");
    expect(bot).toContain("buildGoalDelegatedTaskContext");
  });

  it("prioriza preguntas naturales de tokens antes del progreso del goal", () => {
    expect(bot).toContain("function isUsageOrTokenQuestion");
    const usage = bot.indexOf("if (!command && isUsageOrTokenQuestion(text))");
    const goalProgress = bot.indexOf("if (isGoalProgressQuestion(text, remoteJid))");
    expect(usage).toBeGreaterThan(-1);
    expect(usage).toBeLessThan(goalProgress);
  });
});
