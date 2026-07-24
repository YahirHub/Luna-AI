import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_CONFIG } from "../src/agent-config.ts";
import { runAgent } from "../src/agents/agent-runtime.ts";
import { RESEARCHER_WEB_AGENT } from "../src/agents/definitions/researcher-web.ts";
import { BROWSER_WEB_AGENT } from "../src/agents/definitions/browser-web.ts";
import type { BrowserAgentExecution } from "../src/browser/browser-runtime.ts";
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

  it("browser-web intercepta un cierre por credenciales y solicita el dato sin depender del orquestador", async () => {
    let llmCalls = 0;
    globalThis.fetch = (async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "No puedo continuar porque necesito las credenciales de acceso." } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Listo: continué en la misma sesión y verifiqué el dashboard." } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const requested: Array<{ name: string; args: Record<string, unknown> }> = [];
    const browserExecution = {
      isWaitingForUser: () => false,
      resolveAutomaticInputRequest: async (output: string) => output.includes("necesito las credenciales")
        ? { kind: "username", field_name: "usuario o correo", message: "Dato requerido" }
        : null,
      executeTool: async (name: string, args: Record<string, unknown>) => {
        requested.push({ name, args });
        return JSON.stringify({ status: "received", kind: "username", value: "cuenta@example.com" });
      },
    } as unknown as BrowserAgentExecution;

    const report = await runAgent({
      definition: BROWSER_WEB_AGENT,
      prompt: "Entra al panel y revisa el estado.",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      runId: "browser-human-input-guard",
      browserExecution,
    });

    expect(report.status).toBe("completed");
    expect(report.result).toContain("verifiqué el dashboard");
    expect(report.toolsCalled).toContain("browser_request_user_input");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.name).toBe("browser_request_user_input");
    expect(llmCalls).toBe(2);
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
  it("carga grupos de tools del subagente solo cuando se necesitan", async () => {
    let llmCalls = 0;
    const toolNamesByRequest: string[][] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      llmCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: Array<{ function?: { name?: string } }> };
      toolNamesByRequest.push((body.tools ?? []).flatMap((entry) =>
        typeof entry.function?.name === "string" ? [entry.function.name] : []
      ));
      if (llmCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [
            { id: "load-workspace", type: "function", function: { name: "agent_capability_load", arguments: JSON.stringify({ group: "workspace" }) } },
          ] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Workspace disponible solo después de solicitarlo." } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const report = await runAgent({
      definition: RESEARCHER_WEB_AGENT,
      prompt: "Investiga y decide si necesitas guardar una nota.",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      runId: "research-lazy-tools",
    });

    expect(report.status).toBe("completed");
    expect(report.toolsCalled).toEqual(["agent_capability_load"]);
    expect(llmCalls).toBe(2);
    expect(toolNamesByRequest[0]).toContain("web_search");
    expect(toolNamesByRequest[0]).toContain("read_url");
    expect(toolNamesByRequest[0]).not.toContain("api-search.read-url");
    expect(toolNamesByRequest[0]).toContain("agent_capability_load");
    expect(toolNamesByRequest[0]).not.toContain("agent_workspace_write_text");
    expect(toolNamesByRequest[1]).toContain("agent_workspace_write_text");
  });

});
