import { describe, expect, it } from "bun:test";
import { ModelCatalog } from "../src/models.ts";
import {
  OPENCODE_FREE_CHAT_COMPLETIONS_URL,
  OPENCODE_FREE_DEFAULT_MODEL,
  OPENCODE_FREE_MODELS_URL,
  createOpenCodeFreeConfig,
  filterOpenCodeFreeModels,
  findOpenCodeFreeModelLimit,
  getOpenCodeFreeFallbackModels,
  isOpenCodeFreeModel,
} from "../src/providers/opencode-free.ts";

describe("OpenCode Free", () => {
  it("incluye una configuración integrada sin API key", () => {
    expect(createOpenCodeFreeConfig()).toEqual({
      chatCompletionsUrl: OPENCODE_FREE_CHAT_COMPLETIONS_URL,
      modelsUrl: OPENCODE_FREE_MODELS_URL,
      defaultModel: OPENCODE_FREE_DEFAULT_MODEL,
      apiKey: "",
      requestTimeoutMs: 60_000,
    });
  });

  it("conserva solo IDs terminados en -free", () => {
    expect(
      filterOpenCodeFreeModels([
        "gpt-5.6-sol",
        "mimo-v2.5-free",
        "deepseek-v4-flash-free",
        "mimo-v2.5-free",
        "  north-mini-code-free  ",
      ]),
    ).toEqual([
      "deepseek-v4-flash-free",
      "mimo-v2.5-free",
      "north-mini-code-free",
    ]);
    expect(isOpenCodeFreeModel("MODEL-FREE")).toBe(true);
    expect(isOpenCodeFreeModel("paid-model")).toBe(false);
  });

  it("mantiene un catálogo local si el endpoint no responde", () => {
    const fallback = getOpenCodeFreeFallbackModels();
    expect(fallback[0]).toBe(OPENCODE_FREE_DEFAULT_MODEL);
    expect(fallback.every(isOpenCodeFreeModel)).toBe(true);
  });

  it("resuelve límites por coincidencia y usa un valor conservador si no conoce el modelo", () => {
    expect(findOpenCodeFreeModelLimit("opencode/nemotron-3-ultra-free")).toMatchObject({
      maxContextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });

    const catalog = new ModelCatalog();
    expect(catalog.getModelInfo("vendor/north-mini-code-free")).toMatchObject({
      maxContextTokens: 256_000,
      maxOutputTokens: 64_000,
    });
    expect(catalog.getModelInfo("unknown-model")).toMatchObject({
      maxContextTokens: 120_000,
      maxOutputTokens: 8_000,
    });
  });

  it("calcula el presupuesto con los límites del modelo coincidente", () => {
    const catalog = new ModelCatalog();
    expect(catalog.getEffectiveBudget("north-mini-code-free", 4_000)).toBe(
      256_000 - 64_000 - 4_000 - 12_800,
    );
  });
});
