import { afterEach, describe, expect, it } from "bun:test";
import { discoverModels, fetchModels } from "../src/ai.ts";
import type { LlmConfig } from "../src/llm-config.ts";

const originalFetch = globalThis.fetch;

const config: LlmConfig = {
  chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
  modelsUrl: "https://api.example.com/v1/models",
  defaultModel: "default-model",
  apiKey: "test-key",
  requestTimeoutMs: 5_000,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchModels", () => {
  it("usa el endpoint configurado sin filtrar nombres ni sufijos", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          data: [
            { id: "paid-model" },
            { id: "free-model" },
            { id: "paid-model" },
            { id: "  another/model  " },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await expect(fetchModels(config)).resolves.toEqual([
      "another/model",
      "free-model",
      "paid-model",
    ]);
    expect(requestedUrl).toBe(config.modelsUrl);
  });
});

describe("discoverModels", () => {
  it("mantiene el modelo predeterminado como primera opción", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: [{ id: "other-model" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    await expect(discoverModels(config)).resolves.toEqual({
      models: ["default-model", "other-model"],
      usedFallback: false,
    });
  });

  it("usa el modelo predeterminado si falla el endpoint", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await discoverModels(config);
    expect(result.models).toEqual(["default-model"]);
    expect(result.usedFallback).toBe(true);
    expect(result.error?.message).toContain("network down");
  });

  it("usa fallback cuando el endpoint devuelve una lista vacía", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(discoverModels(config)).resolves.toEqual({
      models: ["default-model"],
      usedFallback: true,
    });
  });
});
