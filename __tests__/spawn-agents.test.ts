import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_CONFIG } from "../src/agent-config.ts";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";
import { TaskRuntime } from "../src/orchestration/task-runtime.ts";
import {
  executeSpawnAgentsTool,
  getMainAgentTools,
} from "../src/agents/spawn-agents-tool.ts";
import { deduplicateSpawnAgentRequests } from "../src/agents/spawn-deduper.ts";
import type { RunAgentOptions } from "../src/agents/agent-runtime.ts";

const roots: string[] = [];

function setup() {
  const root = join(tmpdir(), `luna-spawn-agents-${Date.now()}-${crypto.randomUUID()}`);
  roots.push(root);
  const workspace = new WorkspaceManager(root);
  return { workspace, tasks: new TaskRuntime(workspace) };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const llmConfig = {
  chatCompletionsUrl: "https://api.example.com/chat",
  modelsUrl: "https://api.example.com/models",
  defaultModel: "model",
  apiKey: "",
  requestTimeoutMs: 30_000,
};

describe("spawn_agents", () => {
  it("deduplica solicitudes semánticamente idénticas", () => {
    const result = deduplicateSpawnAgentRequests([
      { agent_type: "researcher-web", prompt: "  Investiga   DeepSeek  " },
      { agent_type: "researcher_web", prompt: "Investiga DeepSeek" },
      { agent_type: "researcher-web", prompt: "Investiga MiniMax" },
    ]);
    expect(result.uniqueAgents).toHaveLength(2);
    expect(result.originalToUniqueIndex).toEqual([0, 0, 1]);
  });

  it("ejecuta subagentes únicos en paralelo y devuelve sus resultados al padre", async () => {
    const { workspace, tasks } = setup();
    let active = 0;
    let maxActive = 0;
    const prompts: string[] = [];
    const runner = async (options: RunAgentOptions) => {
      prompts.push(options.prompt);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        agentType: options.definition.id,
        agentName: options.definition.displayName,
        prompt: options.prompt,
        runId: options.runId,
        status: "completed" as const,
        result: `Resultado para ${options.prompt}`,
        toolsCalled: ["web_search", "read_url"],
      };
    };

    const raw = await executeSpawnAgentsTool({
      title: "Comparar proveedores",
      background: false,
      agents: [
        { agent_type: "researcher-web", prompt: "Investiga DeepSeek" },
        { agent_type: "researcher-web", prompt: "Investiga MiniMax" },
        { agent_type: "researcher_web", prompt: "  Investiga   DeepSeek  " },
      ],
    }, {
      jid: "user",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      workspace,
      tasks,
      agentRunner: runner,
    });

    const parsed = JSON.parse(raw) as {
      status: string;
      reports: Array<{ status: string; result: string }>;
      task_id: string;
    };
    expect(parsed.status).toBe("completed");
    expect(parsed.reports).toHaveLength(3);
    expect(parsed.reports[0]?.result).toContain("DeepSeek");
    expect(parsed.reports[2]?.result).toContain("DeepSeek");
    expect(prompts).toHaveLength(2);
    expect(maxActive).toBe(2);

    const task = tasks.get("user", parsed.task_id);
    expect(task?.status).toBe("completed");
    expect(workspace.list("user", `${task?.taskPath}/agents`).length).toBe(2);
  });

  it("mantiene resultados parciales cuando un subagente falla", async () => {
    const { workspace, tasks } = setup();
    const raw = await executeSpawnAgentsTool({
      background: false,
      agents: [
        { agent_type: "researcher-web", prompt: "Tema bueno" },
        { agent_type: "researcher-web", prompt: "Tema malo" },
      ],
    }, {
      jid: "partial-user",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      workspace,
      tasks,
      agentRunner: async (options) => ({
        agentType: options.definition.id,
        agentName: options.definition.displayName,
        prompt: options.prompt,
        runId: options.runId,
        status: options.prompt.includes("malo") ? "failed" as const : "completed" as const,
        result: options.prompt.includes("malo") ? undefined : "Dato útil",
        error: options.prompt.includes("malo") ? "fallo simulado" : undefined,
        toolsCalled: [],
      }),
    });
    const parsed = JSON.parse(raw) as { status: string; reports: Array<{ status: string }> };
    expect(parsed.status).toBe("partial");
    expect(parsed.reports.map((item) => item.status)).toEqual(["completed", "failed"]);
  });

  it("mantiene el agente de navegador aunque la investigación pública esté deshabilitada", () => {
    const enabled = getMainAgentTools(DEFAULT_AGENT_CONFIG).map((tool) => tool.function.name);
    expect(enabled).toContain("spawn_agents");
    expect(enabled).toContain("researcher_web");
    const disabled = getMainAgentTools({
      ...DEFAULT_AGENT_CONFIG,
      researchSubagentEnabled: false,
    }).map((tool) => tool.function.name);
    expect(disabled).toContain("spawn_agents");
    expect(disabled).toContain("browser_agent");
    expect(disabled).toContain("browser_request_credential");
    expect(disabled).not.toContain("researcher_web");
    expect(disabled).toContain("task_list");

    const withoutApi = getMainAgentTools(DEFAULT_AGENT_CONFIG, false);
    expect(withoutApi.map((tool) => tool.function.name)).not.toContain("researcher_web");
    const spawnTool = withoutApi.find((tool) => tool.function.name === "spawn_agents");
    const parameters = spawnTool?.function.parameters as Record<string, any>;
    expect(parameters.properties.agents.items.properties.agent_type.enum).toEqual(["browser-web"]);
  });

  it("redirige researcher-web a browser-web con Dogpile cuando api-search no está disponible", async () => {
    const { workspace, tasks } = setup();
    const observed: Array<{ type: string; prompt: string }> = [];
    const raw = await executeSpawnAgentsTool({
      background: false,
      agents: [{ agent_type: "researcher-web", prompt: "Busca el precio actual de un producto" }],
    }, {
      jid: "fallback-browser-user",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      apiSearchAvailable: false,
      workspace,
      tasks,
      agentRunner: async (options) => {
        observed.push({ type: options.definition.id, prompt: options.prompt });
        return {
          agentType: options.definition.id,
          agentName: options.definition.displayName,
          prompt: options.prompt,
          runId: options.runId,
          status: "completed" as const,
          result: "resultado por navegador",
          toolsCalled: ["browser_open"],
        };
      },
    });

    const parsed = JSON.parse(raw) as { status: string };
    expect(parsed.status).toBe("completed");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.type).toBe("browser-web");
    expect(observed[0]?.prompt).toContain("https://www.dogpile.com/");
    expect(observed[0]?.prompt).toContain("fuentes originales");
  });

  it("limita el handoff total al agente padre sin truncar los archivos completos del workdir", async () => {
    const { workspace, tasks } = setup();
    const longResult = (label: string) => `${label}\n${"dato-".repeat(2500)}\nFUENTES: https://example.com/${label}`;
    const raw = await executeSpawnAgentsTool({
      background: false,
      agents: [
        { agent_type: "researcher-web", prompt: "Proveedor A" },
        { agent_type: "researcher-web", prompt: "Proveedor B" },
        { agent_type: "researcher-web", prompt: "Proveedor C" },
        { agent_type: "researcher-web", prompt: "Proveedor D" },
      ],
    }, {
      jid: "compact-user",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      workspace,
      tasks,
      agentRunner: async (options) => ({
        agentType: options.definition.id,
        agentName: options.definition.displayName,
        prompt: options.prompt,
        runId: options.runId,
        status: "completed" as const,
        result: longResult(options.prompt),
        toolsCalled: ["web_search", "read_url"],
      }),
    });

    expect(raw.length).toBeLessThan(30_000);
    const parsed = JSON.parse(raw) as { task_id: string; reports: Array<{ result?: string }> };
    expect(parsed.reports).toHaveLength(4);
    expect(parsed.reports.every((report) => report.result?.includes("versión completa quedó guardada en el workdir"))).toBe(true);
    const task = tasks.get("compact-user", parsed.task_id);
    const stored = workspace.readText("compact-user", `${task?.taskPath}/agents/01-researcher-web/result.md`);
    expect(stored.length).toBeGreaterThan(10_000);
    expect(stored).toContain("FUENTES:");
  });

  it("ejecuta api-search en segundo plano por defecto y permite cancelarlo sin esperar", async () => {
    const { workspace, tasks } = setup();
    let started = false;
    const raw = await executeSpawnAgentsTool({
      title: "Investigación cancelable",
      agents: [{ agent_type: "researcher-web", prompt: "Investiga algo lentamente" }],
    }, {
      jid: "background-user",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      workspace,
      tasks,
      agentRunner: async (options) => {
        started = true;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10_000);
          options.parentSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(options.parentSignal?.reason ?? new Error("cancelled"));
          }, { once: true });
        });
        return {
          agentType: options.definition.id,
          agentName: options.definition.displayName,
          prompt: options.prompt,
          runId: options.runId,
          status: "completed" as const,
          result: "no debería completar",
          toolsCalled: [],
        };
      },
    });

    const parsed = JSON.parse(raw) as { task_id: string; background: boolean; status: string };
    expect(parsed.background).toBe(true);
    expect(parsed.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(true);
    expect(tasks.cancelAll("background-user")).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tasks.get("background-user", parsed.task_id)?.status).toBe("cancelled");
  });

});
