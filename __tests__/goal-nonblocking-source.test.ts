import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src", "bot.ts"), "utf8");

describe("goal no bloqueante", () => {
  it("responde preguntas de progreso antes de entrar al lock conversacional", () => {
    const progressRouting = source.indexOf("if (isGoalProgressQuestion(text, remoteJid))");
    const conversationLock = source.indexOf("await cm.withLock(remoteJid");
    expect(progressRouting).toBeGreaterThan(-1);
    expect(conversationLock).toBeGreaterThan(-1);
    expect(progressRouting).toBeLessThan(conversationLock);
  });

  it("goal_instruction es terminal para no ejecutar una cadena pesada en el turno principal", () => {
    const terminalTools = /terminalTools:\s*\[([^\]]+)\]/s.exec(source)?.[1] ?? "";
    expect(terminalTools).toContain('"goal_start"');
    expect(terminalTools).toContain('"goal_instruction"');
    expect(source).toContain("goalRuntime.addInstruction(remoteJid, instruction");
  });

  it("el estado de goal incluye subagentes y procesos iniciados por ese goal", () => {
    expect(source).toContain("delegatedTaskIds");
    expect(source).toContain("process.ownerGoalId === goal.id");
    expect(source).toContain("Investigación/subagentes activos");
  });

  it("los controles urgentes de procesos también se resuelven antes del lock", () => {
    const processRouting = source.indexOf("if (await tryHandleNaturalProcessControl(sock, remoteJid, text)) return;");
    const conversationLock = source.indexOf("await cm.withLock(remoteJid");
    expect(processRouting).toBeGreaterThan(-1);
    expect(processRouting).toBeLessThan(conversationLock);
  });

  it("una instrucción llegada durante la iteración impide cerrar el goal viejo", () => {
    const goalSource = readFileSync(join(process.cwd(), "src", "goals", "goal-runtime.ts"), "utf8");
    expect(goalSource).toContain("(goal.pendingInstructions?.length ?? 0) > 0");
    expect(goalSource).toContain("REQUISITOS/CORRECCIONES POSTERIORES DEL USUARIO");
  });
});
