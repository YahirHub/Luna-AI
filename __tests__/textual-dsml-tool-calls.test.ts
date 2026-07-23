import { afterEach, describe, expect, it } from "bun:test";
import { chatCompletionWithTools, type ToolDefinition } from "../src/ai.ts";
import type { LlmConfig } from "../src/llm-config.ts";

const originalFetch = globalThis.fetch;
const config: LlmConfig = {
  chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
  modelsUrl: "https://api.example.com/v1/models",
  defaultModel: "deepseek-test",
  apiKey: "test",
  requestTimeoutMs: 5_000,
};

const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "workspace_delete",
      description: "Elimina un archivo del workdir.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_exec",
      description: "Ejecuta un comando.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "number" },
          shell: { type: "boolean" },
        },
      },
    },
  },
];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("recuperación de tool calls DSML textuales", () => {
  it("ejecuta el DSML observado en DeepSeek en vez de enviarlo al usuario", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: "stop",
            message: {
              content: '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="workspace_delete">\n<｜｜DSML｜｜parameter name="path" string="true">landing-dr-william-hernandez.html</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "✅ Archivo corregido." } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await chatCompletionWithTools(
      [{ role: "user", content: "Corrige la landing" }],
      "deepseek-test",
      config,
      tools,
      async (name, args) => {
        executed.push({ name, args });
        return "OK";
      },
      1,
    );

    expect(executed).toEqual([{
      name: "workspace_delete",
      args: { path: "landing-dr-william-hernandez.html" },
    }]);
    expect(result.toolsCalled).toEqual(["workspace_delete"]);
    expect(result.content).toBe("✅ Archivo corregido.");
    expect(result.content).not.toContain("DSML");
  });

  it("soporta el DSML oficial y conserva tipos JSON cuando string=false", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: [
            "Voy a ejecutar la validación.",
            '<｜DSML｜tool_calls>',
            '<｜DSML｜invoke name="workspace_exec">',
            '<｜DSML｜parameter name="command" string="true">npm test</｜DSML｜parameter>',
            '<｜DSML｜parameter name="timeout_ms" string="false">120000</｜DSML｜parameter>',
            '<｜DSML｜parameter name="shell" string="false">false</｜DSML｜parameter>',
            '</｜DSML｜invoke>',
            '</｜DSML｜tool_calls>',
          ].join("\n") } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Pruebas terminadas." } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const executed: Array<Record<string, unknown>> = [];
    const result = await chatCompletionWithTools(
      [{ role: "user", content: "Ejecuta las pruebas" }],
      "deepseek-test",
      config,
      tools,
      async (_name, args) => {
        executed.push(args);
        return "tests ok";
      },
      1,
    );

    expect(executed).toEqual([{ command: "npm test", timeout_ms: 120000, shell: false }]);
    expect(result.content).toBe("Pruebas terminadas.");
    expect(result.content).not.toContain("<｜DSML｜");
  });

  it("no ejecuta herramientas DSML que no fueron expuestas al modelo", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'No tengo permiso.<｜DSML｜tool_calls><｜DSML｜invoke name="admin_secret"><｜DSML｜parameter name="x" string="true">1</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>' } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    let executed = false;
    const result = await chatCompletionWithTools(
      [{ role: "user", content: "haz algo" }],
      "deepseek-test",
      config,
      tools,
      async () => {
        executed = true;
        return "NO";
      },
      1,
    );

    expect(executed).toBe(false);
    expect(result.content).toBe("No tengo permiso.");
    expect(result.content).not.toContain("DSML");
  });
});
