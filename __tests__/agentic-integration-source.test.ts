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

  it("el investigador web aislado solo recibe web_search y read_url", () => {
    const definition = source("src/agents/definitions/researcher-web.ts");
    expect(definition).toContain('["web_search", "read_url"]');
    expect(definition).toContain("includeMessageHistory: false");
    expect(definition).toContain('outputMode: "last_message"');
    expect(definition).not.toContain("WHATSAPP_TOOLS");
    expect(definition).not.toContain("REMINDER_TOOLS");
    expect(definition).not.toContain("ALARM_TOOLS");
  });

  it("el agente principal usa spawn_agents no terminal y conserva herramientas de artefactos", () => {
    const bot = source("src/bot.ts");
    const context = source("src/context.ts");
    expect(bot).toContain('name === "spawn_agents"');
    expect(bot).toContain('name === "researcher_web"');
    expect(bot).not.toContain('name === "parallel_research_report"');
    expect(bot).toContain("executeArtifactTool");
    expect(bot).toContain("executeWhatsAppTool");
    expect(context).toContain("spawn_agents NO genera informes ni PDFs y NO es terminal");
    expect(source("src/artifacts/artifact-tools.ts")).toContain('name: "gitzip"');
  });

  it("incluye cancelación jerárquica y persistencia de resultados de subagentes", () => {
    const bot = source("src/bot.ts");
    const spawn = source("src/agents/spawn-agents-tool.ts");
    expect(bot).toContain("taskRuntime.cancel");
    expect(spawn).toContain("Promise.allSettled");
    expect(spawn).toContain("events.jsonl");
    expect(spawn).toContain("result.md");
    expect(spawn).toContain("parentSignal: task.signal");
  });
});
