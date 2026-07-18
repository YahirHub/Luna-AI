import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_CONFIG } from "../src/agent-config.ts";
import {
  getMainResearchTools,
  pricingDataHasVerifiedPrices,
  rankResearchSources,
  renderPricingResearchMarkdown,
  runResearchSubagent,
  runResearchSubagentDetailed,
} from "../src/research-agent.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const llmConfig = {
  chatCompletionsUrl: "https://api.example.com/chat",
  modelsUrl: "https://api.example.com/models",
  defaultModel: "model",
  apiKey: "",
  requestTimeoutMs: 30_000,
};

describe("research subagent guards", () => {

  it("expone solo el subagente al contexto principal", () => {
    const tools = getMainResearchTools(DEFAULT_AGENT_CONFIG);
    expect(tools.map((tool) => tool.function.name)).toEqual(["research_web"]);
    expect(tools.some((tool) => tool.function.name === "web_search")).toBe(false);
    expect(tools.some((tool) => tool.function.name === "read_url")).toBe(false);
  });

  it("no expone herramientas web si el investigador está desactivado", () => {
    expect(getMainResearchTools({
      ...DEFAULT_AGENT_CONFIG,
      researchSubagentEnabled: false,
    })).toEqual([]);
  });
  it("rechaza consultas vacías sin llamar al proveedor", async () => {
    expect(await runResearchSubagent({
      query: "   ",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
    })).toContain("vacía");
  });

  it("respeta la desactivación desde /config", async () => {
    expect(await runResearchSubagent({
      query: "tema actual",
      model: "model",
      llmConfig,
      agentConfig: { ...DEFAULT_AGENT_CONFIG, researchSubagentEnabled: false },
    })).toContain("desactivado");
  });

  it("propaga la cancelación externa sin convertirla en timeout parcial", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelación solicitada"));
    let thrown: unknown;
    try {
      await runResearchSubagent({
        query: "tema actual",
        model: "model",
        llmConfig,
        agentConfig: DEFAULT_AGENT_CONFIG,
        signal: controller.signal,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("cancelación solicitada");
  });
});

describe("research subagent partial timeout", () => {
  it("devuelve evidencia parcial en lugar de un error vacío", async () => {
    const { buildPartialResearchResponse } = await import("../src/research-agent.ts");
    const result = buildPartialResearchResponse(
      "tema reciente",
      {
        results: [
          {
            title: "Fuente oficial",
            url: "https://example.com/oficial",
            snippet: "Dato preliminar verificado durante la búsqueda.",
          },
        ],
        verifiedUrls: ["https://example.com/oficial"],
      },
      120,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("resultados son parciales");
    expect(result).toContain("https://example.com/oficial");
    expect(result).not.toStartWith("Error:");
  });

  it("mantiene el error cuando no alcanzó a obtener evidencia", async () => {
    const { buildPartialResearchResponse } = await import("../src/research-agent.ts");
    expect(buildPartialResearchResponse(
      "tema",
      { results: [], verifiedUrls: [] },
      60,
    )).toBeNull();
  });
});


describe("research subagent verified fetch", () => {
  it("abre automáticamente una fuente y valida precios antes de marcar completo", async () => {
    let chatCalls = 0;
    globalThis.fetch = (async () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: "search-1",
            type: "function",
            function: { name: "web_search", arguments: JSON.stringify({ query: "OpenAI API pricing" }) },
          }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (chatCalls === 2) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Encontré una página oficial." } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          provider: "OpenAI",
          items: [{
            model: "GPT-Test",
            inputUsdPerMillion: "1.00",
            cachedInputUsdPerMillion: "0.25",
            outputUsdPerMillion: "4.00",
            contextWindow: "128K",
            conditions: null,
            sourceUrls: ["https://openai.com/api/pricing"],
          }],
          notes: [],
          sources: ["https://openai.com/api/pricing"],
        }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    let reads = 0;
    const result = await runResearchSubagentDetailed({
      query: "OpenAI API pricing",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      requirements: { kind: "pricing", subject: "OpenAI", minimumVerifiedSources: 1 },
      searchExecutor: async () => ({
        text: "1. Pricing | https://openai.com/api/pricing",
        query: "OpenAI API pricing",
        depth: "standard",
        provider: "tavily",
        providerLabel: "Tavily",
        resultCount: 1,
        results: [{ title: "Pricing", url: "https://openai.com/api/pricing", snippet: "Official prices" }],
      }),
      readExecutor: async () => {
        reads += 1;
        return "URL final: https://openai.com/api/pricing\nGPT-Test input $1.00 per 1M tokens and output $4.00 per 1M tokens.";
      },
    });

    expect(reads).toBe(1);
    expect(result.toolsCalled).toContain("read_url");
    expect(result.status).toBe("complete");
    expect(result.verifiedSources).toHaveLength(1);
    expect(result.pricing && pricingDataHasVerifiedPrices(result.pricing)).toBe(true);
    expect(result.content).toContain("| GPT-Test | 1.00 | 4.00 |");
  });

  it("no convierte fragmentos del buscador en precios cuando la página oficial no entrega contenido", async () => {
    let readAttempts = 0;
    const result = await runResearchSubagentDetailed({
      query: "Precios actuales de OpenAI API",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      requirements: { kind: "pricing", subject: "OpenAI", minimumVerifiedSources: 1 },
      searchExecutor: async () => ({
        text: "Pricing | OpenAI API",
        query: "OpenAI API pricing",
        depth: "deep",
        provider: "tavily",
        providerLabel: "Tavily",
        resultCount: 1,
        results: [{
          title: "Pricing | OpenAI API",
          url: "https://developers.openai.com/api/docs/pricing",
          snippet: "Prices per 1M tokens. Model Input Cached input Cache writes Output gpt-5.6-sol$5.00$0.50$6.25$30.00",
        }],
      }),
      readExecutor: async () => {
        readAttempts += 1;
        return "Error: la página requiere JavaScript y no expuso el contenido.";
      },
    });

    expect(readAttempts).toBeLessThanOrEqual(2);
    expect(result.status).toBe("partial");
    expect(result.pricing && pricingDataHasVerifiedPrices(result.pricing)).toBe(false);
    expect(result.content).not.toContain("| gpt-5.6-sol | 5.00 | 30.00 | 0.50 |");
    expect(result.issues.join(" ")).toContain("fuentes mínimas");
  });

  it("continúa con URLs oficiales aunque el buscador falle", async () => {
    let searches = 0;
    const reads: string[] = [];
    const result = await runResearchSubagentDetailed({
      query: "Precios actuales de DeepSeek API",
      model: "model",
      llmConfig,
      agentConfig: DEFAULT_AGENT_CONFIG,
      requirements: { kind: "pricing", subject: "DeepSeek", minimumVerifiedSources: 1 },
      searchExecutor: async () => {
        searches += 1;
        throw new Error("Tavily alcanzó temporalmente su límite de solicitudes (HTTP 429).");
      },
      readExecutor: async (args) => {
        const url = String(args.url ?? "");
        reads.push(url);
        if (url.includes("api-docs.deepseek.com")) {
          return [
            "URL final: https://api-docs.deepseek.com/quick_start/pricing-details-usd",
            "DeepSeek-V3 input $0.27 per 1M tokens output $1.10 per 1M tokens cached input $0.07 per 1M tokens",
          ].join("\n");
        }
        return "Error: no disponible";
      },
    });

    expect(searches).toBeGreaterThanOrEqual(1);
    expect(reads.some((url) => url.includes("api-docs.deepseek.com"))).toBe(true);
    expect(result.status).toBe("complete");
    expect(result.pricing && pricingDataHasVerifiedPrices(result.pricing)).toBe(true);
    expect(result.issues.join(" ")).toContain("La búsqueda web falló");
  });

  it("prioriza dominios oficiales y genera Markdown tabular válido", () => {
    const ranked = rankResearchSources([
      { title: "Blog", url: "https://pricepertoken.com/openai", snippet: "x" },
      { title: "Official pricing", url: "https://openai.com/api/pricing", snippet: "x" },
    ], "OpenAI API pricing");
    expect(ranked[0]?.url).toBe("https://openai.com/api/pricing");

    const markdown = renderPricingResearchMarkdown({
      provider: "OpenAI",
      items: [{
        model: "GPT-X",
        inputUsdPerMillion: "1",
        cachedInputUsdPerMillion: null,
        outputUsdPerMillion: "4",
        contextWindow: "128K",
        conditions: "Sin descuento | estándar",
        sourceUrls: ["https://openai.com/api/pricing"],
      }],
      notes: [],
      sources: ["https://openai.com/api/pricing"],
    });
    expect(markdown).toContain("| Modelo | Entrada USD / 1M tokens |");
    expect(markdown).toContain("Sin descuento / estándar");
  });
});
