import { afterEach, describe, expect, it } from "bun:test";
import { discoverModels, discoverProviderModels, fetchModels } from "../src/ai.ts";
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

  it("acepta catálogos con models[] y nombres alternativos", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ models: [{ name: "model-z" }, { model: "model-y" }, "model-x"] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    await expect(fetchModels(config)).resolves.toEqual([
      "model-x",
      "model-y",
      "model-z",
    ]);
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


describe("discoverProviderModels", () => {
  it("prueba automáticamente /v1/models y devuelve los endpoints derivados", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      if (String(input) === "https://provider.example/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "model-main" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      discoverProviderModels(
        ["https://provider.example/v1", "https://provider.example"],
        "key",
        5_000,
      ),
    ).resolves.toEqual({
      baseUrl: "https://provider.example/v1",
      chatCompletionsUrl: "https://provider.example/v1/chat/completions",
      modelsUrl: "https://provider.example/v1/models",
      models: ["model-main"],
    });
    expect(requested).toEqual(["https://provider.example/v1/models"]);
  });

  it("usa la siguiente base candidata cuando el primer catálogo falla", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input) === "https://provider.example/v1/models") {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ data: [{ id: "root-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await discoverProviderModels(
      ["https://provider.example/v1", "https://provider.example"],
      "",
      5_000,
    );
    expect(result.baseUrl).toBe("https://provider.example");
    expect(result.models).toEqual(["root-model"]);
  });
});
