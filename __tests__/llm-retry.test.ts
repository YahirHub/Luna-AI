import { afterEach, describe, expect, it } from "bun:test";
import { chatCompletion, chatCompletionWithTools, LlmRetriesExhaustedError } from "../src/ai.ts";
import type { LlmConfig } from "../src/llm-config.ts";

const originalFetch = globalThis.fetch;
const originalAttempts = process.env.LUNA_LLM_RETRY_ATTEMPTS;
const originalBase = process.env.LUNA_LLM_RETRY_BASE_MS;

const config: LlmConfig = {
  chatCompletionsUrl: "https://provider.example/v1/chat/completions",
  modelsUrl: "https://provider.example/v1/models",
  defaultModel: "test-model",
  apiKey: "test-key",
  requestTimeoutMs: 2_000,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAttempts === undefined) delete process.env.LUNA_LLM_RETRY_ATTEMPTS;
  else process.env.LUNA_LLM_RETRY_ATTEMPTS = originalAttempts;
  if (originalBase === undefined) delete process.env.LUNA_LLM_RETRY_BASE_MS;
  else process.env.LUNA_LLM_RETRY_BASE_MS = originalBase;
});

describe("LLM retries", () => {
  it("reintenta un 400 transitorio de upstream y recupera la respuesta", async () => {
    process.env.LUNA_LLM_RETRY_ATTEMPTS = "3";
    process.env.LUNA_LLM_RETRY_BASE_MS = "10";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          error: {
            message: "Error from provider (Console): Upstream request failed",
            type: "invalid_request_error",
          },
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "recuperado" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await expect(chatCompletion(
      [{ role: "user", content: "hola" }],
      "test-model",
      config,
    )).resolves.toBe("recuperado");
    expect(calls).toBe(2);
  });

  it("aborta después de agotar los intentos configurados", async () => {
    process.env.LUNA_LLM_RETRY_ATTEMPTS = "3";
    process.env.LUNA_LLM_RETRY_BASE_MS = "10";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        error: { message: "Upstream request failed" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      await chatCompletion(
        [{ role: "user", content: "hola" }],
        "test-model",
        config,
      );
      throw new Error("Se esperaba error");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmRetriesExhaustedError);
    }
    expect(calls).toBe(3);
  });
  it("reintenta respuestas HTTP 200 vacías del proveedor", async () => {
    process.env.LUNA_LLM_RETRY_ATTEMPTS = "3";
    process.env.LUNA_LLM_RETRY_BASE_MS = "10";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "respuesta real" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await expect(chatCompletion(
      [{ role: "user", content: "hola" }],
      "test-model",
      config,
    )).resolves.toBe("respuesta real");
    expect(calls).toBe(2);
  });

  it("recupera la continuación después de una tool exitosa si el upstream falla con el historial completo", async () => {
    process.env.LUNA_LLM_RETRY_ATTEMPTS = "2";
    process.env.LUNA_LLM_RETRY_BASE_MS = "10";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{
                id: "spawn-1",
                type: "function",
                function: { name: "spawn_agents", arguments: "{}" },
              }],
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (calls === 2 || calls === 3) {
        return new Response(JSON.stringify({ error: { message: "Upstream request failed" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "continuación recuperada" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const result = await chatCompletionWithTools(
      [{ role: "system", content: "sistema" }, { role: "user", content: "haz la tarea" }],
      "test-model",
      config,
      [{
        type: "function",
        function: { name: "spawn_agents", description: "test", parameters: { type: "object" } },
      }],
      async () => JSON.stringify({ reports: [{ result: "dato útil" }] }),
      2,
      undefined,
      { maxRounds: 4, maxTokens: 4096 },
    );

    expect(result.content).toBe("continuación recuperada");
    expect(result.toolsCalled).toEqual(["spawn_agents"]);
    expect(calls).toBe(4);
  });

  it("rehace de forma compacta una respuesta final truncada por finish_reason length", async () => {
    process.env.LUNA_LLM_RETRY_ATTEMPTS = "2";
    process.env.LUNA_LLM_RETRY_BASE_MS = "10";
    let calls = 0;
    const maxTokensSeen: number[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { max_tokens?: number };
      maxTokensSeen.push(body.max_tokens ?? 0);
      if (calls === 1) {
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "length", message: { content: "respuesta cortada a mitad de una tabla |" } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "respuesta completa y compacta" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const result = await chatCompletionWithTools(
      [{ role: "user", content: "investiga" }],
      "test-model",
      config,
      [],
      async () => "",
      2,
      undefined,
      { maxTokens: 8192, truncationRecoveryAttempts: 1 },
    );

    expect(result.content).toBe("respuesta completa y compacta");
    expect(calls).toBe(2);
    expect(maxTokensSeen).toEqual([8192, 8192]);
  });

});
