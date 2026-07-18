import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";
import { TaskRuntime } from "../src/orchestration/task-runtime.ts";
import { runParallelResearch } from "../src/orchestration/parallel-research.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/agent-config.ts";

const roots: string[] = [];
function createWorkspace(): { root: string; workspace: WorkspaceManager } {
  const root = join(tmpdir(), `luna-workspace-${Date.now()}-${crypto.randomUUID()}`);
  roots.push(root);
  return { root, workspace: new WorkspaceManager(root) };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceManager", () => {
  it("aísla archivos y artefactos por JID", () => {
    const { workspace } = createWorkspace();
    workspace.writeText("uno@s.whatsapp.net", "exports/reporte.md", "usuario uno");
    workspace.writeText("dos@s.whatsapp.net", "exports/reporte.md", "usuario dos");

    expect(workspace.readText("uno@s.whatsapp.net", "exports/reporte.md")).toBe("usuario uno");
    expect(workspace.readText("dos@s.whatsapp.net", "exports/reporte.md")).toBe("usuario dos");

    const artifact = workspace.registerArtifact("uno@s.whatsapp.net", "exports/reporte.md", "test");
    expect(artifact.path).toBe("exports/reporte.md");
    expect(workspace.listArtifacts("uno@s.whatsapp.net")).toHaveLength(1);
    expect(workspace.listArtifacts("dos@s.whatsapp.net")).toHaveLength(0);
  });

  it("impide rutas absolutas y traversal", () => {
    const { workspace } = createWorkspace();
    expect(() => workspace.writeText("user", "../escape.txt", "x")).toThrow();
    expect(() => workspace.writeText("user", "/tmp/escape.txt", "x")).toThrow();
  });

  it("detecta enlaces simbólicos que salen del workdir", () => {
    const { root, workspace } = createWorkspace();
    const external = join(root, "external.txt");
    writeFileSync(external, "secreto");
    const workdir = workspace.getWorkdir("user");
    symlinkSync(external, join(workdir, "escape-link"));
    expect(() => workspace.resolvePath("user", "escape-link", { mustExist: true })).toThrow(/enlace simbólico/i);
  });
});

describe("TaskRuntime", () => {
  it("persiste progreso, artefactos y cancelación", () => {
    const { workspace } = createWorkspace();
    const runtime = new TaskRuntime(workspace);
    const created = runtime.create("user", "comparar APIs", 4);
    expect(created.record.status).toBe("running");
    expect(existsSync(workspace.resolvePath("user", created.record.taskPath, { mustExist: true, allowDirectory: true }))).toBe(true);

    runtime.update("user", created.record.id, { completedWorkers: 2, status: "synthesizing" });
    expect(runtime.get("user", created.record.id)?.completedWorkers).toBe(2);
    expect(runtime.cancel("user", created.record.id)).toBe(true);
    expect(runtime.get("user", created.record.id)?.status).toBe("cancelled");
  });
});


describe("calidad de informes paralelos", () => {
  const llmConfig = {
    chatCompletionsUrl: "https://api.example.com/chat",
    modelsUrl: "https://api.example.com/models",
    defaultModel: "model",
    apiKey: "",
    requestTimeoutMs: 30_000,
  };

  it("no genera ni entrega un PDF de precios vacío", async () => {
    const { workspace } = createWorkspace();
    const tasks = new TaskRuntime(workspace);
    let deliveries = 0;
    const result = await runParallelResearch({
      jid: "user",
      title: "Comparativa de precios de APIs",
      topics: [
        { name: "Proveedor A", query: "Proveedor A API pricing" },
        { name: "Proveedor B", query: "Proveedor B API pricing" },
      ],
      depth: "standard",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      workspace,
      tasks,
      deliverResult: true,
      deliver: async () => { deliveries += 1; },
      researchRunner: async (options) => ({
        status: "partial",
        content: `# ${options.requirements?.subject ?? "Proveedor"}\n\nSin importes.`,
        toolsCalled: ["web_search", "read_url"],
        searchResults: [],
        verifiedSources: [{ url: "https://official.example/pricing", content: "Pricing page without numeric values" }],
        pricing: {
          provider: options.requirements?.subject ?? "Proveedor",
          items: [],
          notes: [],
          sources: [],
        },
        issues: ["Sin precios verificables"],
      }),
    });

    expect(result).toContain("No generé ni envié un PDF vacío");
    expect(deliveries).toBe(0);
    expect(workspace.listArtifacts("user").some((artifact) => artifact.path.endsWith(".pdf"))).toBe(false);
    expect(tasks.list("user")[0]?.status).toBe("failed");
  });

  it("genera y entrega el PDF cuando los trabajadores sí extraen precios", async () => {
    const { workspace } = createWorkspace();
    const tasks = new TaskRuntime(workspace);
    const delivered: string[] = [];
    const result = await runParallelResearch({
      jid: "user-prices",
      title: "Comparativa de precios de APIs",
      topics: [
        { name: "Proveedor A", query: "Proveedor A API pricing" },
        { name: "Proveedor B", query: "Proveedor B API pricing" },
      ],
      depth: "standard",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      workspace,
      tasks,
      deliverResult: true,
      deliver: async (path) => { delivered.push(path); },
      researchRunner: async (options) => {
        const provider = options.requirements?.subject ?? "Proveedor";
        return {
          status: "complete",
          content: `# ${provider}`,
          toolsCalled: ["web_search", "read_url"],
          searchResults: [],
          verifiedSources: [{ url: `https://${provider.toLowerCase().replace(/\s+/g, "")}.example/pricing`, content: "Input $1 per 1M tokens; output $4 per 1M tokens" }],
          pricing: {
            provider,
            items: [{
              model: `${provider}-Model`,
              inputUsdPerMillion: "1.00",
              cachedInputUsdPerMillion: null,
              outputUsdPerMillion: "4.00",
              contextWindow: null,
              conditions: null,
              sourceUrls: [`https://${provider.toLowerCase().replace(/\s+/g, "")}.example/pricing`],
            }],
            notes: [],
            sources: [`https://${provider.toLowerCase().replace(/\s+/g, "")}.example/pricing`],
          },
          issues: [],
        };
      },
    });

    expect(result).toContain("El PDF ya fue enviado por WhatsApp");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.endsWith(".pdf")).toBe(true);
    expect(workspace.listArtifacts("user-prices").some((artifact) => artifact.path.endsWith(".pdf"))).toBe(true);
  });
});

import { buildArtifactContentReply, isArtifactContentRequest } from "../src/workspace/artifact-followup.ts";

describe("seguimiento exacto de artefactos", () => {
  it("lee el Markdown asociado al PDF en lugar de reconstruirlo", () => {
    const { workspace } = createWorkspace();
    const md = "tasks/t/artifacts/informe.md";
    const pdf = "tasks/t/artifacts/informe.pdf";
    workspace.writeText("user-artifact", md, "# Informe\n\n| Modelo | Precio |\n|---|---:|\n| exacto | 4.00 |");
    workspace.writeBuffer("user-artifact", pdf, new Uint8Array([37, 80, 68, 70]));
    workspace.registerArtifact("user-artifact", md, "test", { taskId: "t" });
    workspace.registerArtifact("user-artifact", pdf, "test", { taskId: "t", sourcePath: md });

    expect(isArtifactContentRequest("Dame el contenido del PDF completo")).toBe(true);
    const reply = buildArtifactContentReply(workspace, "user-artifact", "Dame el contenido del PDF completo");
    expect(reply).toContain("Fuente utilizada para generar el artefacto");
    expect(reply).toContain("| exacto | 4.00 |");
  });
});
