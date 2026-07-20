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
    expect(definition).not.toContain("MESSAGING_TOOLS");
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
    expect(bot).toContain("executeMessagingTool");
    expect(context).toContain("spawn_agents NO genera informes ni PDFs y NO es terminal");
    expect(source("src/artifacts/artifact-tools.ts")).toContain('name: "gitzip"');
  });

  it("integra un browser-web aislado sin exponer contraseñas al LLM", () => {
    const definition = source("src/agents/definitions/browser-web.ts");
    const runtime = source("src/browser/browser-runtime.ts");
    const bot = source("src/bot.ts");
    expect(definition).toContain('id: "browser-web"');
    expect(definition).toContain('"browser_auth_login"');
    expect(definition).toContain("Trabajas sin visión");
    expect(runtime).toContain('"--password-stdin"');
    expect(runtime).toContain("AGENT_BROWSER_ENCRYPTION_KEY");
    expect(bot).toContain("🔐 MENSAJE DEL SISTEMA");
    expect(bot).toContain("browser_request_credential");
    expect(bot).toContain("browserCredentialStore");
  });

  it("deja la selección de browser_agent al orquestador y usa detección local solo para proteger secretos", () => {
    const bot = source("src/bot.ts");
    const context = source("src/context.ts");
    const pendingCalls = bot.match(/browserCredentialStore\.setPendingInput\(/g) ?? [];
    expect(pendingCalls.length).toBe(1); // únicamente el agente/sistema inicia una espera explícita; detectar una URL no lo hace
    expect(bot).toContain("const activeTools = getAvailableTools(remoteJid)");
    expect(bot).not.toContain("secureBrowserTask");
    expect(bot).toContain("inlineBrowserCredential.password");
    expect(context).toContain("NO implica usar browser_agent automáticamente");
    expect(context).toContain("No pidas una contraseña por adelantado");
    expect(context).toContain("pausa la misma ejecución");
    expect(context).toContain("browser_auth_profiles");
    expect(context).toContain("browser_request_user_input");
  });

  it("mantiene validaciones autoritativas para controles de cuenta sin usarlas como router del navegador", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("containsProtectedBrowserCredential");
    expect(bot).toContain("userExplicitlyRequestsOwnPasswordChange");
    expect(bot).toContain("userExplicitlyRequestsConversationClear");
    expect(bot).toContain("conversation_clear requiere que el usuario pida explícitamente");
    expect(bot).toContain("account_password_change_start solo puede usarse cuando el usuario pide explícitamente");
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
