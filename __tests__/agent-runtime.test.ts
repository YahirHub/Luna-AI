import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_CONFIG } from "../src/agent-config.ts";
import { runAgent } from "../src/agents/agent-runtime.ts";
import { RESEARCHER_WEB_AGENT } from "../src/agents/definitions/researcher-web.ts";
import type { AgentEvent } from "../src/agents/agent-types.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const llmConfig = {
  chatCompletionsUrl: "https://api.example.com/chat",
  modelsUrl: "https://api.example.com/models",
  defaultModel: "model",
  apiKey: "",
  requestTimeoutMs: 5_000,
};

describe("AgentRuntime", () => {
  it("ejecuta un investigador con contexto propio y devuelve solo su mensaje final", async () => {
    let llmCalls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      llmCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string | null }> };
      if (llmCalls === 1) {
        expect(body.messages?.some((message) => message.content?.includes("secreto del padre"))).toBe(false);
        return new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [
            { id: "search", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "precio oficial DeepSeek" }) } },
          ] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (llmCalls === 2) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [
            { id: "read", type: "function", function: { name: "read_url", arguments: JSON.stringify({ url: "https://example.com/pricing" }) } },
          ] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "DeepSeek cuesta X. Fuente: https://example.com/pricing" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const events: AgentEvent[] = [];
    const report = await runAgent({
      definition: RESEARCHER_WEB_AGENT,
      prompt: "Investiga DeepSeek",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      runId: "research-1",
      onEvent: (event) => { events.push(event); },
      webSearchExecutor: async () => ({
        text: "1. Pricing — https://example.com/pricing",
        query: "precio oficial DeepSeek",
        depth: "standard",
        provider: "tavily",
        providerLabel: "Tavily",
        resultCount: 1,
        results: [{ title: "Pricing", url: "https://example.com/pricing", snippet: "precio" }],
      }),
      readUrlExecutor: async () => "Input $1 / 1M tokens; Output $2 / 1M tokens",
    });

    expect(report.status).toBe("completed");
    expect(report.result).toContain("DeepSeek cuesta X");
    expect(report.toolsCalled).toEqual(["web_search", "read_url"]);
    expect(events.some((event) => event.type === "agent_started")).toBe(true);
    expect(events.some((event) => event.type === "agent_finished")).toBe(true);
  });

  it("el timeout del subagente es independiente y produce fallo controlado", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch;
    const report = await runAgent({
      definition: { ...RESEARCHER_WEB_AGENT, maxSteps: 2 },
      prompt: "Investiga algo",
      model: "model",
      llmConfig: { ...llmConfig, requestTimeoutMs: 10_000 },
      agentConfig: DEFAULT_AGENT_CONFIG,
      runId: "timeout-agent",
      timeoutMs: 20,
    });
    expect(report.status).toBe("failed");
    expect(report.error).toContain("timeout de seguridad");
  });
});
