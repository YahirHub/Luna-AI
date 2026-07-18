import { describe, expect, it } from "bun:test";
import {
  buildPricingRecoveryQuery,
  extractPricingDataDeterministically,
  getPricingCandidateUrls,
  pricingDataHasVerifiedPrices,
} from "../src/research/pricing-extractor.ts";

describe("extractor determinista de precios", () => {
  it("extrae tablas oficiales y distingue caché de entrada normal", () => {
    const content = [
      "| Model | INPUT PRICE (CACHE HIT) | INPUT PRICE (CACHE MISS) | OUTPUT PRICE | Context |",
      "|---|---|---|---|---|",
      "| deepseek-chat | $0.07 / 1M tokens | $0.27 / 1M tokens | $1.10 / 1M tokens | 64K |",
    ].join("\n");
    const data = extractPricingDataDeterministically("DeepSeek", [{
      url: "https://api-docs.deepseek.com/quick_start/pricing-details-usd",
      content,
    }]);

    expect(pricingDataHasVerifiedPrices(data)).toBe(true);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]?.model).toBe("deepseek-chat");
    expect(data.items[0]?.inputUsdPerMillion).toBe("0.27");
    expect(data.items[0]?.cachedInputUsdPerMillion).toBe("0.07");
    expect(data.items[0]?.outputUsdPerMillion).toBe("1.10");
  });

  it("no usa fragmentos del buscador como evidencia de precios", () => {
    const data = extractPricingDataDeterministically("OpenAI", [], [{
      title: "Pricing | OpenAI API",
      url: "https://openai.com/api/pricing/",
      snippet: "GPT-4o pricing is $2.50 per million input tokens and $10.00 per million output tokens. GPT-4o-mini pricing is $0.15 per million input tokens and $0.60 per million output tokens.",
    }]);

    expect(data.items).toEqual([]);
    expect(data.notes.join(" ")).toContain("ignoraron");
  });

  it("no acepta fragmentos secundarios como sustituto de una fuente oficial", () => {
    const data = extractPricingDataDeterministically("OpenAI", [], [{
      title: "Blog de precios",
      url: "https://example.net/openai-pricing",
      snippet: "GPT-X input $1 per 1M tokens and output $4 per 1M tokens.",
    }]);
    expect(data.items).toEqual([]);
  });

  it("normaliza precios expresados por mil tokens", () => {
    const data = extractPricingDataDeterministically("Proveedor", [{
      url: "https://proveedor.example/pricing",
      content: "Modelo Alpha: input $0.002 per 1K tokens; output $0.006 per 1K tokens.",
    }]);
    expect(data.items[0]?.inputUsdPerMillion).toBe("2.00");
    expect(data.items[0]?.outputUsdPerMillion).toBe("6.00");
  });



  it("extrae filas compactas de las páginas oficiales aunque no tengan separadores Markdown", () => {
    const openai = extractPricingDataDeterministically("OpenAI", [{
      url: "https://developers.openai.com/api/docs/pricing",
      content: "Prices per 1M tokens. Model Input Cached input Cache writes Output gpt-5.6-sol$5.00$0.50$6.25$30.00 gpt-5.6-terra$2.50$0.25$3.125$15.00",
    }]);
    expect(openai.items[0]).toMatchObject({
      model: "gpt-5.6-sol",
      inputUsdPerMillion: "5.00",
      cachedInputUsdPerMillion: "0.50",
      outputUsdPerMillion: "30.00",
    });

    const claude = extractPricingDataDeterministically("Claude", [{
      url: "https://platform.claude.com/docs/en/about-claude/pricing",
      content: "MTok = Million tokens. Claude Opus 4.5$5 / MTok$6.25 / MTok$10 / MTok$0.50 / MTok$25 / MTok Claude Haiku 4.5$1 / MTok$1.25 / MTok$2 / MTok$0.10 / MTok$5 / MTok",
    }]);
    expect(claude.items[0]).toMatchObject({
      model: "Claude Opus 4.5",
      inputUsdPerMillion: "5.00",
      cachedInputUsdPerMillion: "0.50",
      outputUsdPerMillion: "25.00",
    });
  });

  it("elige el precio MiniMax descontado y no el importe tachado", () => {
    const data = extractPricingDataDeterministically("MiniMax", [{
      url: "https://platform.minimax.io/docs/guides/pricing-paygo",
      content: "MiniMax-M3 <= 512k input tokens Permanent 50% off ~~$0.60~~ $0.30 / M tokens ~~$2.40~~ $1.20 / M tokens ~~$0.12~~ $0.06 / M tokens",
    }]);
    expect(data.items[0]).toMatchObject({
      model: "MiniMax-M3",
      inputUsdPerMillion: "0.30",
      outputUsdPerMillion: "1.20",
      cachedInputUsdPerMillion: "0.06",
    });
  });

  it("interpreta el orden oficial de caché hit, caché miss y salida de DeepSeek", () => {
    const data = extractPricingDataDeterministically("DeepSeek", [{
      url: "https://api-docs.deepseek.com/quick_start/pricing-details-usd",
      content: "Prices per 1M tokens. deepseek-chat $0.028 / 1M tokens $0.28 / 1M tokens $0.42 / 1M tokens",
    }]);
    expect(data.items[0]).toMatchObject({
      model: "deepseek-chat",
      cachedInputUsdPerMillion: "0.028",
      inputUsdPerMillion: "0.28",
      outputUsdPerMillion: "0.42",
    });
  });

  it("prioriza la tabla estructurada y no multiplica filas con texto repetido", () => {
    const content = [
      "# API pricing",
      "Input pricing and output pricing are shown below.",
      "The pricing page repeats input $99 per 1M tokens and output $199 per 1M tokens in accessibility metadata.",
      "| Model | Input | Cached input | Output |",
      "|---|---:|---:|---:|",
      "| gpt-5-test | $1.00 / 1M tokens | $0.10 / 1M tokens | $4.00 / 1M tokens |",
      "Pricing input $88 per 1M tokens output $188 per 1M tokens.",
    ].join("\n");
    const data = extractPricingDataDeterministically("OpenAI", [{
      url: "https://developers.openai.com/api/docs/pricing",
      content,
    }]);

    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      model: "gpt-5-test",
      inputUsdPerMillion: "1.00",
      cachedInputUsdPerMillion: "0.10",
      outputUsdPerMillion: "4.00",
    });
  });

  it("descarta filas cuyo nombre no corresponde al proveedor", () => {
    const data = extractPricingDataDeterministically("DeepSeek", [{
      url: "https://api-docs.deepseek.com/quick_start/pricing",
      content: [
        "| Model | Input | Output |",
        "|---|---:|---:|",
        "| deepseek-chat | $0.20 / 1M tokens | $0.80 / 1M tokens |",
        "| Generic pricing heading | $50 / 1M tokens | $90 / 1M tokens |",
      ].join("\n"),
    }]);

    expect(data.items.map((item) => item.model)).toEqual(["deepseek-chat"]);
  });


  it("descarta filas basura y precios desalineados del HTML accesible", () => {
    const data = extractPricingDataDeterministically("OpenAI", [{
      url: "https://developers.openai.com/api/docs/pricing",
      content: [
        "Prices per 1M tokens.",
        "For more information, contact OpenAI sales. $5.60 $5.60",
        "Input: 20,000 / 1,000,000 x 125 = 2.5 credits. $80000",
        "gpt-5-test$1.00$0.10$1.25$4.00",
      ].join("\n"),
    }]);

    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      model: "gpt-5-test",
      inputUsdPerMillion: "1.00",
      cachedInputUsdPerMillion: "0.10",
      outputUsdPerMillion: "4.00",
    });
  });

  it("requiere entrada y salida positivas para considerar un precio verificado", () => {
    const data = extractPricingDataDeterministically("Anthropic", [{
      url: "https://platform.claude.com/docs/en/about-claude/pricing",
      content: "Claude Haiku 4.5$1 / MTok$0.01 / MTok",
    }]);
    expect(pricingDataHasVerifiedPrices(data)).toBe(true);

    const invalid = extractPricingDataDeterministically("OpenAI", [{
      url: "https://developers.openai.com/api/docs/pricing",
      content: "gpt-5-test$0.00$0.10$1.25$4.00",
    }]);
    expect(invalid.items).toEqual([]);
    expect(pricingDataHasVerifiedPrices(invalid)).toBe(false);
  });

  it("define consultas y URLs de recuperación por proveedor sin fijar precios", () => {
    expect(buildPricingRecoveryQuery("MiniMax API", "precios")).toContain("platform.minimax.io");
    const genericOpenAi = buildPricingRecoveryQuery("OpenAI", "OpenAI GPT-4o pricing heredado");
    expect(genericOpenAi).toContain("current active API models");
    expect(genericOpenAi).not.toContain("GPT-4o pricing heredado");
    expect(buildPricingRecoveryQuery("GPT-4o", "precio específico de GPT-4o")).toContain("precio específico de GPT-4o");
    expect(getPricingCandidateUrls("Claude Anthropic")).toContain("https://platform.claude.com/docs/en/about-claude/pricing");
  });

  it("interpreta la tabla columnar actual de DeepSeek sin crear modelos desde encabezados", () => {
    const data = extractPricingDataDeterministically("DeepSeek", [{
      url: "https://api-docs.deepseek.com/quick_start/pricing",
      content: [
        "# Models & Pricing",
        "The prices listed below are in units of per 1M tokens.",
        "## Model Details",
        "MODEL deepseek-v4-flash(1)deepseek-v4-pro",
        "BASE URL https://api.deepseek.com",
        "MODEL VERSION DeepSeek-V4-Flash DeepSeek-V4-Pro",
        "CONTEXT LENGTH 1M",
        "PRICING 1M INPUT TOKENS (CACHE HIT)$0.0028$0.003625",
        "1M INPUT TOKENS (CACHE MISS)$0.14$0.435",
        "1M OUTPUT TOKENS$0.28$0.87",
        "Concurrency Limit 2500 500",
        "## Deduction Rules",
      ].join("\n"),
    }]);

    expect(data.items).toEqual([
      expect.objectContaining({ model: "deepseek-v4-flash", inputUsdPerMillion: "0.14", cachedInputUsdPerMillion: "0.0028", outputUsdPerMillion: "0.28", contextWindow: "1M" }),
      expect.objectContaining({ model: "deepseek-v4-pro", inputUsdPerMillion: "0.435", cachedInputUsdPerMillion: "0.003625", outputUsdPerMillion: "0.87", contextWindow: "1M" }),
    ]);
  });

  it("limita OpenAI a la tabla Standard de modelos flagship y respeta columnas vacías", () => {
    const data = extractPricingDataDeterministically("OpenAI", [{
      url: "https://developers.openai.com/api/docs/pricing",
      content: [
        "# Pricing",
        "Flagship models",
        "Our latest models",
        "Prices per 1M tokens.",
        "Standard",
        "Short context Long context",
        "Model Input Cached input Cache writes Output Input Cached input Cache writes Output",
        "gpt-5.6-sol$5.00$0.50$6.25$30.00$10.00$1.00$12.50$45.00",
        "gpt-5.5$5.00$0.50-$30.00$10.00$1.00-$45.00",
        "gpt-5.5-pro$30.00--$180.00$60.00--$270.00",
        "Regional processing endpoints are charged a 10% uplift.",
        "All models Batch",
        "gpt-5.6-sol$2.50$0.25$3.125$15.00",
        "Multimodal models",
        "gpt-realtime-2.1 Audio$32.00$0.40$64.00",
      ].join("\n"),
    }]);

    expect(data.items).toEqual([
      expect.objectContaining({ model: "gpt-5.6-sol", inputUsdPerMillion: "5.00", cachedInputUsdPerMillion: "0.50", outputUsdPerMillion: "30.00", conditions: "Standard" }),
      expect.objectContaining({ model: "gpt-5.5", inputUsdPerMillion: "5.00", cachedInputUsdPerMillion: "0.50", outputUsdPerMillion: "30.00" }),
      expect.objectContaining({ model: "gpt-5.5-pro", inputUsdPerMillion: "30.00", cachedInputUsdPerMillion: null, outputUsdPerMillion: "180.00" }),
    ]);
  });

  it("interpreta las cinco columnas de Claude y excluye modelos retirados o precios futuros duplicados", () => {
    const data = extractPricingDataDeterministically("Anthropic", [{
      url: "https://platform.claude.com/docs/en/about-claude/pricing",
      content: [
        "# Pricing",
        "Model pricing",
        "Model Base Input Tokens 5m Cache Writes 1h Cache Writes Cache Hits & Refreshes Output Tokens",
        "Claude Opus 4.8$5 / MTok$6.25 / MTok$10 / MTok$0.50 / MTok$25 / MTok",
        "Claude Opus 4.1 (deprecated)$15 / MTok$18.75 / MTok$30 / MTok$1.50 / MTok$75 / MTok",
        "Claude Sonnet 5 through August 31, 2026 $2 / MTok$2.50 / MTok$4 / MTok$0.20 / MTok$10 / MTok",
        "Claude Sonnet 5 starting September 1, 2026$3 / MTok$3.75 / MTok$6 / MTok$0.30 / MTok$15 / MTok",
        "Claude Haiku 4.5$1 / MTok$1.25 / MTok$2 / MTok$0.10 / MTok$5 / MTok",
        "Introductory pricing of $2/$10 per million input/output tokens.",
        "Cloud platform pricing",
      ].join("\n"),
    }]);

    expect(data.items.map((item) => item.model)).toEqual(["Claude Opus 4.8", "Claude Sonnet 5", "Claude Haiku 4.5"]);
    expect(data.items.find((item) => item.model === "Claude Opus 4.8")).toMatchObject({ inputUsdPerMillion: "5.00", cachedInputUsdPerMillion: "0.50", outputUsdPerMillion: "25.00" });
    expect(data.items.find((item) => item.model === "Claude Haiku 4.5")).toMatchObject({ inputUsdPerMillion: "1.00", cachedInputUsdPerMillion: "0.10", outputUsdPerMillion: "5.00" });
    expect(data.items.find((item) => item.model === "Claude Sonnet 5")?.conditions).toContain("through August 31, 2026");
  });

  it("limita MiniMax a LLM activos y conserva los cuatro niveles de M3", () => {
    const data = extractPricingDataDeterministically("MiniMax", [{
      url: "https://platform.minimax.io/docs/guides/pricing-paygo",
      content: [
        "# Pay as You Go",
        "## LLM",
        "Standard Priority",
        "Model Input Output Prompt caching Read",
        "MiniMax-M3 <= 512k input tokens Permanent 50% off~~$0.60~~ $0.30 / M tokens~~$2.40~~ $1.20 / M tokens~~$0.12~~ $0.06 / M tokens",
        "MiniMax-M3 > 512k input tokens Permanent 50% off~~$1.20~~ $0.60 / M tokens~~$4.80~~ $2.40 / M tokens~~$0.24~~ $0.12 / M tokens",
        "MiniMax-M3 <= 512k input tokens Permanent 50% off~~$0.90~~ $0.45 / M tokens~~$3.60~~ $1.80 / M tokens~~$0.18~~ $0.09 / M tokens",
        "MiniMax-M3 > 512k input tokens Permanent 50% off~~$1.80~~ $0.90 / M tokens~~$7.20~~ $3.60 / M tokens~~$0.36~~ $0.18 / M tokens",
        "MiniMax-M2.7$0.3 / M tokens$1.2 / M tokens$0.06 / M tokens$0.375 / M tokens",
        "MiniMax-M2.7-highspeed$0.6 / M tokens$2.4 / M tokens$0.06 / M tokens$0.375 / M tokens",
        "Legacy Models",
        "MiniMax-M2.5$0.3 / M tokens$1.2 / M tokens$0.03 / M tokens",
        "## Audio",
        "T2A speech-2.8-turbo$60/M characters",
      ].join("\n"),
    }]);

    expect(data.items).toHaveLength(6);
    expect(data.items.some((item) => item.model === "MiniMax-M2.5")).toBe(false);
    expect(data.items.filter((item) => item.model === "MiniMax-M3").map((item) => item.conditions)).toEqual([
      expect.stringContaining("Standard"),
      expect.stringContaining("Standard"),
      expect.stringContaining("Priority"),
      expect.stringContaining("Priority"),
    ]);
    expect(data.items.find((item) => item.model === "MiniMax-M2.7")).toMatchObject({ inputUsdPerMillion: "0.30", outputUsdPerMillion: "1.20", cachedInputUsdPerMillion: "0.06" });
  });

});
