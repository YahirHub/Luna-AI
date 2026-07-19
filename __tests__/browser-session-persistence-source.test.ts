import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const browserRuntime = readFileSync(join(root, "src/browser/browser-runtime.ts"), "utf8");
const spawnRuntime = readFileSync(join(root, "src/agents/spawn-agents-tool.ts"), "utf8");
const bot = readFileSync(join(root, "src/bot.ts"), "utf8");

describe("persistencia de navegador y cancelación jerárquica", () => {
  it("guarda cookies y datos del perfil bajo persistent/browser por usuario", () => {
    expect(browserRuntime).toContain('"persistent", "browser", "users"');
    expect(browserRuntime).toContain("AGENT_BROWSER_PROFILE: this.profileDir");
    expect(browserRuntime).toContain("AGENT_BROWSER_SESSION_NAME: this.restoreName");
    expect(browserRuntime).toContain("AGENT_BROWSER_STATE");
    expect(browserRuntime).toContain('["state", "save", this.stateFile, "--json"]');
  });

  it("finaliza browser-web guardando estado antes de cerrar la instancia", () => {
    expect(spawnRuntime).toContain("if (browserExecution) await browserExecution.finalize()");
    expect(browserRuntime).toContain("persistent_state_saved");
    expect(browserRuntime).toContain('await this.run(["close"]');
  });

  it("!cancelar aborta también el orquestador principal y evita seguimientos", () => {
    expect(bot).toContain("const activeAiRuns = new Map<string, AbortController>()");
    expect(bot).toContain("taskRuntime.cancelAll(jid)");
    expect(bot).toContain('activeRun.abort(new Error("user-cancelled-current-operation"))');
    expect(bot).toContain("signal: runController.signal");
    expect(bot).toContain("No reanudar, reintentar ni lanzar tareas de seguimiento");
  });
});
