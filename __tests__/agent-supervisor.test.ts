import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_CONFIG } from "../src/agent-config.ts";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";
import { TaskRuntime } from "../src/orchestration/task-runtime.ts";
import { executeAgentTaskTool, executeSpawnAgentsTool } from "../src/agents/spawn-agents-tool.ts";

const roots: string[] = [];
function setup() {
  const root = join(tmpdir(), `luna-agent-supervisor-${Date.now()}-${crypto.randomUUID()}`);
  roots.push(root);
  const workspace = new WorkspaceManager(root);
  return { workspace, tasks: new TaskRuntime(workspace) };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const llmConfig = {
  chatCompletionsUrl: "https://api.example.com/chat/completions",
  modelsUrl: "https://api.example.com/models",
  defaultModel: "model",
  apiKey: "",
  requestTimeoutMs: 30_000,
};

describe("Agent supervisor", () => {
  it("registra agentes con nombre, estado y revisión independiente", () => {
    const { tasks } = setup();
    const task = tasks.create("user", "Revisar Cloudflare", 1);
    const agent = tasks.createAgent("user", task.record.id, {
      name: "Comprobar DNS",
      agentType: "browser-web",
      runId: "run-1",
      agentPath: `${task.record.taskPath}/agents/01-browser-web`,
      prompt: "Comprueba los DNS",
    });
    tasks.updateAgent("user", agent.record.id, { status: "completed", resultPath: `${agent.record.agentPath}/result.md` });
    tasks.update("user", task.record.id, { status: "completed", completedWorkers: 1 });

    expect(tasks.getAgent("user", agent.record.id)?.reviewStatus).toBe("pending");
    expect(tasks.buildContextSummary("user")).toContain("Terminados pendientes de revisión");
    tasks.reviewAgent("user", agent.record.id);
    expect(tasks.getAgent("user", agent.record.id)?.reviewStatus).toBe("reviewed");
  });

  it("cancela un agente concreto y ejecuta su terminador sin cancelar otros", async () => {
    const { tasks } = setup();
    const task = tasks.create("user", "Tarea múltiple", 2);
    const first = tasks.createAgent("user", task.record.id, { name: "Agente uno", agentType: "browser-web", runId: "r1", agentPath: "tasks/a", prompt: "uno" });
    const second = tasks.createAgent("user", task.record.id, { name: "Agente dos", agentType: "researcher-web", runId: "r2", agentPath: "tasks/b", prompt: "dos" });
    tasks.updateAgent("user", first.record.id, { status: "running" });
    tasks.updateAgent("user", second.record.id, { status: "running" });
    let terminated = false;
    tasks.registerAgentTerminator("user", first.record.id, async () => { terminated = true; });

    expect(tasks.cancelAgent("user", first.record.id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminated).toBe(true);
    expect(tasks.getAgent("user", first.record.id)?.status).toBe("cancelled");
    expect(tasks.getAgent("user", second.record.id)?.status).toBe("running");
  });

  it("registra background como queued y solo confirma inicio cuando el runner emite agent_started", async () => {
    const { workspace, tasks } = setup();
    const progress: string[] = [];
    const raw = await executeSpawnAgentsTool({
      title: "Investigar proveedor",
      background: true,
      agents: [{ agent_type: "researcher-web", name: "Investigar API", prompt: "Consulta la API" }],
    }, {
      jid: "background-user",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      workspace,
      tasks,
      onProgress: async (event) => { progress.push(event.type); },
      agentRunner: async (options) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await options.onEvent?.({
          type: "agent_started",
          backend: options.definition.backend,
          runId: options.runId,
          agentId: options.definition.id,
          displayName: options.definition.displayName,
          prompt: options.prompt,
          timeoutMs: options.timeoutMs ?? options.definition.timeoutMs,
        });
        return {
          agentType: options.definition.id,
          agentName: options.definition.displayName,
          prompt: options.prompt,
          runId: options.runId,
          status: "completed" as const,
          result: "Resultado final del agente",
          toolsCalled: [],
        };
      },
    });
    const started = JSON.parse(raw) as { task_id: string; background: boolean };
    expect(started.background).toBe(true);
    expect(tasks.get("background-user", started.task_id)?.status).toBe("queued");
    expect(progress).toEqual(["task_registered"]);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tasks.get("background-user", started.task_id)?.status).toBe("completed");
    expect(tasks.get("background-user", started.task_id)?.reviewStatus).toBe("pending");
    expect(progress).toContain("agent_started");
    expect(progress).toContain("task_completed");

    const reviewed = executeAgentTaskTool("task_review", { task_id: started.task_id }, { jid: "background-user", tasks, workspace });
    expect(reviewed).toContain("Resultado final del agente");
    expect(tasks.get("background-user", started.task_id)?.reviewStatus).toBe("reviewed");
  });
});

it("task_inspect devuelve la carpeta, resultados y artefactos reales", () => {
  const { workspace, tasks } = setup();
  const task = tasks.create("inspect-user", "Capturar dashboard", 1);
  const agent = tasks.createAgent("inspect-user", task.record.id, {
    name: "Abrir dashboard",
    agentType: "browser-web",
    runId: "inspect-run",
    agentPath: `${task.record.taskPath}/agents/01-browser-web`,
    prompt: "abre el panel",
  });
  const resultPath = `${agent.record.agentPath}/result.md`;
  const screenshotPath = `${agent.record.agentPath}/browser/screenshots/dashboard.png`;
  workspace.writeText("inspect-user", resultPath, "Dashboard abierto correctamente");
  workspace.writeText("inspect-user", screenshotPath, "png-simulado");
  workspace.registerArtifact("inspect-user", screenshotPath, "browser-web", { taskId: task.record.id });
  tasks.updateAgent("inspect-user", agent.record.id, {
    status: "completed",
    resultPath,
    activity: "Captura final guardada",
  });
  tasks.update("inspect-user", task.record.id, { status: "completed", completedWorkers: 1 });

  const inspected = executeAgentTaskTool("task_inspect", { task_id: task.record.id }, {
    jid: "inspect-user",
    tasks,
    workspace,
  });
  expect(inspected).toContain("Dashboard abierto correctamente");
  expect(inspected).toContain("dashboard.png");
  expect(inspected).toContain("Captura final guardada");
});
