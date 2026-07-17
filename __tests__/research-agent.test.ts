import { describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_CONFIG } from "../src/agent-config.ts";
import { runResearchSubagent } from "../src/research-agent.ts";

const llmConfig = {
  chatCompletionsUrl: "https://api.example.com/chat",
  modelsUrl: "https://api.example.com/models",
  defaultModel: "model",
  apiKey: "",
  requestTimeoutMs: 30_000,
};

describe("research subagent guards", () => {
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
