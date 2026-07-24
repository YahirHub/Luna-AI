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
    name: "message_send",
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
          choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "message_send", arguments: "{}" } }] } }],
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
    expect(result.toolsCalled).toEqual(["message_send"]);
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
          choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "message_send", arguments: "{}" } }] } }],
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


it("detiene herramientas adicionales después de una herramienta terminal", async () => {
  const terminalTools: ToolDefinition[] = [
    {
      type: "function",
      function: { name: "secondary_tool", description: "Herramienta secundaria", parameters: { type: "object", properties: {} } },
    },
    {
      type: "function",
      function: { name: "terminal_job", description: "Trabajo terminal", parameters: { type: "object", properties: {} } },
    },
  ];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [
          { id: "secondary", type: "function", function: { name: "secondary_tool", arguments: "{}" } },
          { id: "terminal", type: "function", function: { name: "terminal_job", arguments: "{}" } },
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
      return name === "terminal_job" ? "✅ Trabajo terminal completado." : "resultado secundario";
    },
    1,
    undefined,
    { maxRounds: 8, terminalTools: ["terminal_job"] },
  );

  expect(executed).toEqual(["terminal_job"]);
  expect(result.toolsCalled).toEqual(["terminal_job"]);
  expect(result.content).toBe("✅ Trabajo terminal completado.");
  expect(calls).toBe(1);
});

it("un subagente background no terminal permite continuar el trabajo del mismo turno", async () => {
  const backgroundTools: ToolDefinition[] = [{
    type: "function",
    function: {
      name: "browser_agent",
      description: "Lanza navegador background",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    },
  }];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [
          { id: "bg-1", type: "function", function: { name: "browser_agent", arguments: JSON.stringify({ prompt: "Investiga el clima" }) } },
        ] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Mientras el navegador trabaja, completé la parte independiente del turno." } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const result = await chatCompletionWithTools(
    [{ role: "user", content: "Investiga el clima y además haz una tarea independiente" }],
    "test-model",
    config,
    backgroundTools,
    async () => JSON.stringify({ task_id: "T-123", status: "queued", background: true }),
    1,
    undefined,
    { maxRounds: 8, terminalTools: [] },
  );

  expect(calls).toBe(2);
  expect(result.toolsCalled).toEqual(["browser_agent"]);
  expect(result.content).toContain("parte independiente");
});

it("actualiza el toolset entre rondas con resolveTools", async () => {
  const capabilityTool: ToolDefinition = {
    type: "function",
    function: {
      name: "capability_load",
      description: "Carga workspace",
      parameters: { type: "object", properties: { capability: { type: "string" } }, required: ["capability"] },
    },
  };
  const workspaceTool: ToolDefinition = {
    type: "function",
    function: {
      name: "workspace_read_text",
      description: "Lee texto",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  };
  let loaded = false;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
        { id: "load-1", type: "function", function: { name: "capability_load", arguments: JSON.stringify({ capability: "workspace" }) } },
      ] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (bodies.length === 2) {
      const names = ((body.tools ?? []) as Array<{ function?: { name?: string } }>).map((entry) => entry.function?.name);
      expect(names).toContain("workspace_read_text");
      expect(names.slice(0, 2)).toEqual(["capability_load", "workspace_read_text"]);
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
        { id: "read-1", type: "function", function: { name: "workspace_read_text", arguments: JSON.stringify({ path: "README.md" }) } },
      ] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "Listo" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const executed: string[] = [];
  const result = await chatCompletionWithTools(
    [{ role: "user", content: "Lee el proyecto" }],
    "test-model",
    config,
    [capabilityTool],
    async (name) => {
      executed.push(name);
      if (name === "capability_load") {
        loaded = true;
        return "Capacidad workspace cargada";
      }
      return "contenido del readme";
    },
    1,
    undefined,
    // El resolver devuelve deliberadamente la nueva tool antes de la antigua;
    // el runtime debe conservar el prefijo previo y anexar la capacidad nueva.
    { resolveTools: () => loaded ? [workspaceTool, capabilityTool] : [capabilityTool] },
  );

  expect(result.content).toBe("Listo");
  expect(executed).toEqual(["capability_load", "workspace_read_text"]);
  expect(bodies).toHaveLength(3);
});

it("virtualiza resultados grandes y permite leerlos por chunks", async () => {
  const bigTool: ToolDefinition = {
    type: "function",
    function: { name: "big_tool", description: "Devuelve mucho texto", parameters: { type: "object", properties: {} } },
  };
  const huge = `inicio-${"x".repeat(25_000)}-final`;
  const bodies: Array<Record<string, unknown>> = [];
  let capturedRef = "";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
        { id: "big-1", type: "function", function: { name: "big_tool", arguments: "{}" } },
      ] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (bodies.length === 2) {
      const messages = body.messages as Array<{ role?: string; content?: string }>;
      const toolMessage = messages.findLast((message) => message.role === "tool");
      expect(toolMessage?.content).toContain("RESULTADO GRANDE VIRTUALIZADO");
      expect((toolMessage?.content ?? "").length).toBeLessThan(10_000);
      capturedRef = toolMessage?.content?.match(/result_ref=(tool-result-[a-z0-9]+)/i)?.[1] ?? "";
      expect(capturedRef).not.toBe("");
      const names = ((body.tools ?? []) as Array<{ function?: { name?: string } }>).map((entry) => entry.function?.name);
      expect(names).toContain("tool_result_read");
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
        { id: "chunk-1", type: "function", function: { name: "tool_result_read", arguments: JSON.stringify({ result_ref: capturedRef, offset: 0, max_chars: 1000 }) } },
      ] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const messages = body.messages as Array<{ role?: string; content?: string }>;
    const chunk = messages.findLast((message) => message.role === "tool")?.content ?? "";
    expect(chunk).toContain(`[${capturedRef}] chars 0-1000`);
    expect(chunk).toContain("inicio-");
    return new Response(JSON.stringify({ choices: [{ message: { content: "Ya leí el fragmento necesario" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const executed: string[] = [];
  const result = await chatCompletionWithTools(
    [{ role: "user", content: "Obtén el resultado grande" }],
    "test-model",
    config,
    [bigTool],
    async (name) => {
      executed.push(name);
      return huge;
    },
    1,
    undefined,
    { maxInlineToolResultChars: 20_000 },
  );

  expect(result.content).toBe("Ya leí el fragmento necesario");
  expect(executed).toEqual(["big_tool"]); // tool_result_read se resuelve internamente
  expect(result.toolsCalled).toEqual(["big_tool", "tool_result_read"]);
});

it("una tool terminal bloqueada por política puede recuperarse con texto en la siguiente ronda", async () => {
  const voiceTool: ToolDefinition[] = [{
    type: "function",
    function: {
      name: "tts_speak",
      description: "Envía voz",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  }];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
        { id: "voice-1", type: "function", function: { name: "tts_speak", arguments: JSON.stringify({ text: "hola" }) } },
      ] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "Entendido. Te respondo solo por texto." } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const result = await chatCompletionWithTools(
    [{ role: "user", content: "No quiero audios, respóndeme por texto" }],
    "test-model",
    config,
    voiceTool,
    async () => "Error: la política autoritativa de este turno exige texto.",
    1,
    undefined,
    { maxRounds: 4, terminalTools: ["tts_speak"] },
  );

  expect(calls).toBe(2);
  expect(result.toolsCalled).toEqual(["tts_speak"]);
  expect(result.content).toContain("solo por texto");
});
