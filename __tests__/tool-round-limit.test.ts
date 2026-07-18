import { afterEach, describe, expect, it } from "bun:test";
import { chatCompletionWithTools, type ToolDefinition } from "../src/ai.ts";
import type { LlmConfig } from "../src/llm-config.ts";

const originalFetch = globalThis.fetch;
const config: LlmConfig = {
  chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
  modelsUrl: "https://api.example.com/v1/models",
  defaultModel: "test-model",
  apiKey: "test",
  requestTimeoutMs: 5_000,
};
const tools: ToolDefinition[] = [{
  type: "function",
  function: {
    name: "whatsapp_send",
    description: "Envía un artefacto.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
}];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("límite de rondas de herramientas", () => {
  it("genera un cierre sin tools después de ejecutar la última ronda", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "whatsapp_send", arguments: "{}" } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "✅ El PDF se envió correctamente." } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const result = await chatCompletionWithTools(
      [{ role: "user", content: "Envíame el PDF" }],
      "test-model",
      config,
      tools,
      async () => "✅ archivo.pdf enviado por WhatsApp como documento.",
      1,
      undefined,
      { maxRounds: 1 },
    );

    expect(result.content).toBe("✅ El PDF se envió correctamente.");
    expect(result.toolsCalled).toEqual(["whatsapp_send"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.tools).toBeDefined();
    expect(bodies[1]?.tools).toBeUndefined();
  });

  it("usa el último resultado exitoso si el cierre final falla", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "whatsapp_send", arguments: "{}" } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error("gateway offline");
    }) as unknown as typeof fetch;

    const result = await chatCompletionWithTools(
      [{ role: "user", content: "Envíame el PDF" }],
      "test-model",
      config,
      tools,
      async () => "✅ archivo.pdf enviado por WhatsApp como documento.",
      1,
      undefined,
      { maxRounds: 1 },
    );

    expect(result.content).toBe("✅ archivo.pdf enviado por WhatsApp como documento.");
    expect(result.content).not.toContain("excedió");
  });
});


it("detiene herramientas adicionales después de una investigación paralela terminal", async () => {
  const terminalTools: ToolDefinition[] = [
    {
      type: "function",
      function: { name: "research_web", description: "Investiga", parameters: { type: "object", properties: {} } },
    },
    {
      type: "function",
      function: { name: "parallel_research_report", description: "Informe", parameters: { type: "object", properties: {} } },
    },
  ];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [
          { id: "research", type: "function", function: { name: "research_web", arguments: "{}" } },
          { id: "parallel", type: "function", function: { name: "parallel_research_report", arguments: "{}" } },
        ] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "✅ Informe entregado." } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const executed: string[] = [];
  const result = await chatCompletionWithTools(
    [{ role: "user", content: "Compara proveedores" }],
    "test-model",
    config,
    terminalTools,
    async (name) => {
      executed.push(name);
      return name === "parallel_research_report" ? "✅ PDF creado y enviado." : "investigación adicional";
    },
    1,
    undefined,
    { maxRounds: 8, terminalTools: ["parallel_research_report"] },
  );

  expect(executed).toEqual(["parallel_research_report"]);
  expect(result.toolsCalled).toEqual(["parallel_research_report"]);
  expect(result.content).toBe("✅ PDF creado y enviado.");
  expect(calls).toBe(1);
});
