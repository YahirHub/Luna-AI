import { afterEach, describe, expect, it } from "bun:test";
import { requestForcedToolArguments, type ToolDefinition } from "../src/ai.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const config = {
  chatCompletionsUrl: "https://provider.example/v1/chat/completions",
  modelsUrl: "https://provider.example/v1/models",
  defaultModel: "test-model",
  apiKey: "",
  requestTimeoutMs: 5_000,
};

const tool: ToolDefinition = {
  type: "function",
  function: {
    name: "memory_vault_upsert",
    description: "guardar",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, content: { type: "string" } },
      required: ["title", "content"],
    },
  },
};

describe("requestForcedToolArguments", () => {
  it("fuerza la herramienta indicada y devuelve sus argumentos", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{
              id: "call-memory",
              type: "function",
              function: {
                name: "memory_vault_upsert",
                arguments: JSON.stringify({ title: "Fechas de cumpleaños", content: "- Ana — 8 de diciembre" }),
              },
            }],
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const args = await requestForcedToolArguments(
      [{ role: "user", content: "Recuerda el cumpleaños de Ana" }],
      "test-model",
      config,
      tool,
      "Debes guardar el dato.",
    );

    expect(args.title).toBe("Fechas de cumpleaños");
    expect(requestBodies[0]?.tool_choice).toEqual({ type: "function", function: { name: "memory_vault_upsert" } });
  });
});
