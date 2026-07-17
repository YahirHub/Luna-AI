import { describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_CONFIG } from "../src/agent-config.ts";
import {
  getMainResearchTools,
  runResearchSubagent,
} from "../src/research-agent.ts";

const llmConfig = {
  chatCompletionsUrl: "https://api.example.com/chat",
  modelsUrl: "https://api.example.com/models",
  defaultModel: "model",
  apiKey: "",
  requestTimeoutMs: 30_000,
};

describe("research subagent guards", () => {

  it("expone solo el subagente al contexto principal", () => {
    const tools = getMainResearchTools(DEFAULT_AGENT_CONFIG);
    expect(tools.map((tool) => tool.function.name)).toEqual(["research_web"]);
    expect(tools.some((tool) => tool.function.name === "web_search")).toBe(false);
    expect(tools.some((tool) => tool.function.name === "read_url")).toBe(false);
  });

  it("no expone herramientas web si el investigador está desactivado", () => {
    expect(getMainResearchTools({
      ...DEFAULT_AGENT_CONFIG,
      researchSubagentEnabled: false,
    })).toEqual([]);
  });
  it("rechaza consultas vacías sin llamar al proveedor", async () => {
    expect(await runResearchSubagent({
      query: "   ",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
    })).toContain("vacía");
  });

  it("respeta la desactivación desde /config", async () => {
    expect(await runResearchSubagent({
      query: "tema actual",
      model: "model",
      llmConfig,
      agentConfig: { ...DEFAULT_AGENT_CONFIG, researchSubagentEnabled: false },
    })).toContain("desactivado");
  });
});

describe("research subagent partial timeout", () => {
  it("devuelve evidencia parcial en lugar de un error vacío", async () => {
    const { buildPartialResearchResponse } = await import("../src/research-agent.ts");
    const result = buildPartialResearchResponse(
      "tema reciente",
      {
        results: [
          {
            title: "Fuente oficial",
            url: "https://example.com/oficial",
            snippet: "Dato preliminar verificado durante la búsqueda.",
          },
        ],
        verifiedUrls: ["https://example.com/oficial"],
      },
      120,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("resultados son parciales");
    expect(result).toContain("https://example.com/oficial");
    expect(result).not.toStartWith("Error:");
  });

  it("mantiene el error cuando no alcanzó a obtener evidencia", async () => {
    const { buildPartialResearchResponse } = await import("../src/research-agent.ts");
    expect(buildPartialResearchResponse(
      "tema",
      { results: [], verifiedUrls: [] },
      60,
    )).toBeNull();
  });
});
