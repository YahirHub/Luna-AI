import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const browserRuntime = readFileSync(join(root, "src/browser/browser-runtime.ts"), "utf8");
const spawnRuntime = readFileSync(join(root, "src/agents/spawn-agents-tool.ts"), "utf8");
const bot = readFileSync(join(root, "src/bot.ts"), "utf8");

describe("persistencia de navegador y cancelación jerárquica", () => {
  it("aísla el perfil por ejecución y fusiona el estado persistente por usuario", () => {
    expect(browserRuntime).toContain('"persistent", "browser", "users"');
    expect(browserRuntime).toContain('"session-state.json"');
    expect(browserRuntime).toContain("AGENT_BROWSER_PROFILE: this.profileDir");
    expect(browserRuntime).toContain("AGENT_BROWSER_SESSION_NAME: this.restoreName");
    expect(browserRuntime).toContain("AGENT_BROWSER_STATE");
    expect(browserRuntime).toContain('["state", "save", this.runStateFile, "--json"]');
    expect(browserRuntime).toContain("mergeBrowserStorageStates(base, incoming)");
    expect(browserRuntime).toContain('this.profileLeaseKey = `${userState}:state-save`');
  });

  it("finaliza browser-web guardando estado y cerrando su daemon aislado", () => {
    expect(spawnRuntime).toContain("if (browserExecution) await browserExecution.finalize()");
    expect(browserRuntime).toContain("persistent_state_saved");
    expect(browserRuntime).toContain('await this.run(["close"]');
    expect(browserRuntime).toContain('["close", "--all"]');
    expect(browserRuntime).toContain("AGENT_BROWSER_IDLE_TIMEOUT_MS");
    expect(browserRuntime).toContain("luna-run-");
    expect(browserRuntime).toContain("this.runRuntimeDir");
  });

  it("!cancelar aborta también el orquestador principal y evita seguimientos", () => {
    expect(bot).toContain("const activeAiRuns = new Map<string, AbortController>()");
    expect(bot).toContain("taskRuntime.cancelAll(jid)");
    expect(bot).toContain('activeRun.abort(new Error("user-cancelled-current-operation"))');
    expect(bot).toContain("signal: runController.signal");
    expect(bot).toContain("No reanudar, reintentar ni lanzar tareas de seguimiento");
  });
});
