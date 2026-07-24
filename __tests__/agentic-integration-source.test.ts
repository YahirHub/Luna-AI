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

  it("el investigador web aislado recibe búsqueda y archivos limitados a su carpeta", () => {
    const definition = source("src/agents/definitions/researcher-web.ts");
    expect(definition).toContain('"web_search"');
    expect(definition).toContain('"read_url"');
    expect(definition).toContain('"agent_workspace_write_text"');
    expect(definition).toContain("includeMessageHistory: false");
    expect(definition).toContain('outputMode: "last_message"');
    expect(definition).not.toContain("WHATSAPP_TOOLS");
    expect(definition).not.toContain("REMINDER_TOOLS");
    expect(definition).not.toContain("ALARM_TOOLS");
  });

  it("el agente principal desacopla los lanzadores background y conserva herramientas de artefactos", () => {
    const bot = source("src/bot.ts");
    const agentsModule = source("src/modules/agents/module.ts");
    expect(bot).toContain('name === "spawn_agents"');
    expect(bot).toContain('name === "researcher_web"');
    expect(bot).toContain('terminalTools: [');
    for (const toolName of ["spawn_agents", "researcher_web", "browser_agent"]) {
      expect(bot).toContain(`"${toolName}"`);
    }
    expect(bot).toContain("parseDetachedBackgroundTaskResult(result.content, result.toolsCalled)");
    expect(bot).toContain("chat_lock_released_after_background_registration");
    expect(bot).not.toContain('name === "parallel_research_report"');
    expect(bot).toContain("executeArtifactTool");
    expect(bot).toContain("executeMessagingTool");
    expect(agentsModule).toContain("registrar un subagente NO termina el turno principal");
    expect(source("src/artifacts/artifact-tools.ts")).toContain('name: "gitzip"');
  });

  it("hace autoritativa la solicitud de datos humanos dentro de browser-web", () => {
    const runtime = source("src/agents/agent-runtime.ts");
    const browserRuntime = source("src/browser/browser-runtime.ts");
    const browserTools = source("src/browser/browser-tools.ts");
    const browserDefinition = source("src/agents/definitions/browser-web.ts");
    const bot = source("src/bot.ts");
    expect(runtime).toContain("automatic_user_input_guard");
    expect(runtime).toContain("isWaitingForUser()");
    expect(runtime).toContain('executeBoundTool("browser_request_user_input"');
    expect(browserRuntime).toContain("resolveAutomaticInputRequest");
    expect(browserRuntime).toContain("extractBrowserLoginIntent(this.options.resumePrompt");
    expect(browserRuntime).toContain("normalizeBrowserRequestedInputKind");
    expect(browserRuntime).toContain("browserLoginRequiresIdentityConfirmation");
    expect(browserRuntime).toContain('reason: "login_identity_required"');
    expect(browserRuntime).toContain("initialCredentialRef");
    expect(browserRuntime).not.toContain("if (profiles.length === 1) username = profiles[0]!.username");
    expect(browserTools).toContain('["username", "password", "otp", "secret", "text"]');
    expect(bot).toContain('pendingBrowserInput.kind === "secret"');
    expect(browserDefinition).toContain("browser_request_user_input");
    expect(browserDefinition).toContain("nunca cierres limitándote a decir que necesitas el dato");
    expect(browserDefinition).toContain("Nunca infieras la identidad");
    expect(browserDefinition).toContain("única guardada");
    expect(source("src/agents/spawn-agents-tool.ts")).toContain("initialCredentialRef: credentialRef || undefined");
    expect(source("src/modules/browser/module.ts")).toContain("no elijas una cuenta aunque browser_credentials_list devuelva una sola");
  });

  it("integra un browser-web aislado sin exponer contraseñas al LLM", () => {
    const definition = source("src/agents/definitions/browser-web.ts");
    const runtime = source("src/browser/browser-runtime.ts");
    const bot = source("src/bot.ts");
    expect(definition).toContain('id: "browser-web"');
    expect(definition).toContain('"browser_auth_login"');
    expect(definition).toContain("trabajas sin visión");
    expect(runtime).toContain('"--password-stdin"');
    expect(runtime).toContain("AGENT_BROWSER_ENCRYPTION_KEY");
    expect(bot).toContain("🔐 MENSAJE DEL SISTEMA");
    expect(bot).toContain("browser_request_credential");
    expect(bot).toContain("browserCredentialStore");
  });

  it("deja la selección de browser_agent al orquestador y usa detección local solo para proteger secretos", () => {
    const bot = source("src/bot.ts");
    const browserModule = source("src/modules/browser/module.ts");
    const pendingCalls = bot.match(/browserCredentialStore\.setPendingInput\(/g) ?? [];
    expect(pendingCalls.length).toBe(1); // únicamente el agente/sistema inicia una espera explícita; detectar una URL no lo hace
    expect(bot).toContain("const activeTools = getAvailableTools(remoteJid, userText, loadedCapabilities)");
    expect(bot).toContain("resolveTools: () => getAvailableTools(remoteJid, userText, loadedCapabilities)");
    expect(bot).not.toContain("secureBrowserTask");
    expect(bot).toContain("inlineBrowserCredential.password");
    expect(browserModule).toContain("navegación/scraping interactivo");
    expect(browserModule).toContain("prioriza primero la capacidad public-web");
    expect(source("src/agents/spawn-agents-tool.ts")).toContain("shouldUseBrowserAgentForPrompt");
    expect(browserModule).toContain("No pidas contraseñas por adelantado");
    expect(browserModule).toContain("solicita datos humanos");
    expect(browserModule).toContain("referencias opacas");
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
    expect(spawn).toContain("parentSignal: tracked.signal");
    expect(spawn).toContain("registerAgentTerminator");
    expect(bot).toContain("taskRuntime.buildContextSummary(remoteJid)");
  });
});

it("la revisión background continúa la intención original fuera del lock y se integra en FIFO", () => {
  const bot = source("src/bot.ts");
  const reviewStart = bot.indexOf("async function reviewBackgroundTask");
  const reviewEnd = bot.indexOf("function formatAgentEventAge", reviewStart);
  const review = bot.slice(reviewStart, reviewEnd);
  const snapshotLock = review.indexOf("await cm.withLock");
  const llmReview = review.indexOf("summary = (await chatCompletion");
  const persistLock = review.indexOf("await cm.withLock", llmReview);
  expect(review).toContain("backgroundCompletionQueue.enqueue");
  expect(review).toContain("SOLICITUD ORIGINAL");
  expect(review).toContain("CONTEXTO CONGELADO AL DELEGAR");
  expect(review).toContain("CONTEXTO POST-DELEGACIÓN YA CONFIRMADO");
  expect(review).toContain("buildTaskPostDelegationContext");
  expect(review).toContain("Si el usuario pidió comparar");
  expect(snapshotLock).toBeGreaterThanOrEqual(0);
  expect(llmReview).toBeGreaterThan(snapshotLock);
  expect(persistLock).toBeGreaterThan(llmReview);
});

it("los subagentes background ya no son terminales y conservan deduplicación durante todo el turno", () => {
  const bot = source("src/bot.ts");
  const terminalTools = /terminalTools:\s*\[([^\]]+)\]/s.exec(bot)?.[1] ?? "";
  expect(terminalTools).not.toContain('"spawn_agents"');
  expect(terminalTools).not.toContain('"researcher_web"');
  expect(terminalTools).not.toContain('"browser_agent"');
  const detachedParser = bot.slice(bot.indexOf("function parseDetachedBackgroundTaskResult"), bot.indexOf("async function handleAiChat"));
  expect(detachedParser).not.toContain("agentStarted");
  expect(detachedParser).toContain('toolsCalled.includes("goal_start")');
  expect(bot).not.toContain("spawnDeduper.reset()");
  expect(bot).toContain("resumeContext: backgroundResumeContext");
});
