import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("integración agéntica", () => {
  it("mantiene alarmas y recordatorios en sus ejecutores existentes", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain('executeReminderTool(name, args, reminderManager, remoteJid)');
    expect(bot).toContain('executeAlarmTool(name, args, alarmManager, remoteJid)');
    expect(bot).toContain('name === "create_reminder" || name === "create_alarm"');
  });

  it("los subagentes de investigación solo reciben herramientas web", () => {
    const research = source("src/research-agent.ts");
    expect(research).toContain("WEB_SEARCH_TOOL");
    expect(research).toContain("READ_URL_TOOL");
    expect(research).not.toContain("WHATSAPP_TOOLS");
    expect(research).not.toContain("REMINDER_TOOLS");
    expect(research).not.toContain("ALARM_TOOLS");
  });

  it("incluye cancelación, PDF, gitzip y envío de artefactos", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("parallel_research_report");
    expect(bot).toContain("taskRuntime.cancel");
    expect(bot).toContain("executeArtifactTool");
    expect(bot).toContain("executeWhatsAppTool");
    expect(source("src/artifacts/artifact-tools.ts")).toContain('name: "gitzip"');
    const orchestrator = source("src/orchestration/parallel-research.ts");
    expect(orchestrator).toContain("evidence.jsonl");
    expect(orchestrator).toContain("synthesis/result.json");
  });

  it("responde el contenido de artefactos desde su fuente exacta antes del LLM", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("buildArtifactContentReply(workspaceManager, remoteJid, userText)");
    expect(bot).toContain("splitArtifactReply(exactArtifactReply)");
    expect(source("src/workspace/workspace-manager.ts")).toContain("readArtifactText");
    expect(source("src/workspace/workspace-manager.ts")).toContain("sourcePath");
  });

});
