import { describe, expect, it } from "bun:test";
import {
  normalizeWebSearchRequest,
  runWebSearchWithFallback,
} from "../src/search/search-runtime.ts";
import { normalizeWebSearchAuth, normalizeWebSearchSettings } from "../src/search/search-config.ts";

function config() {
  return {
    settings: normalizeWebSearchSettings({
      version: 1,
      defaultProvider: "tavily",
      fallbackOrder: ["tavily", "exa"],
      providers: { tavily: { enabled: true }, exa: { enabled: true } },
    }),
    auth: normalizeWebSearchAuth({
      version: 1,
      apiKeys: { tavily: "tvly-key", exa: "exa-key" },
    }),
  };
}

describe("search runtime", () => {
  it("normaliza consulta y límites", () => {
    expect(normalizeWebSearchRequest({
      query: "  bun typescript  ",
      numResults: 500,
      contextMaxCharacters: 10,
      type: "deep",
      livecrawl: "preferred",
    })).toEqual({
      query: "bun typescript",
      numResults: 50,
      contextMaxCharacters: 1_000,
      type: "deep",
      livecrawl: "preferred",
    });
  });

  it("usa el siguiente motor cuando el predeterminado falla", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("tavily")) {
        return new Response(JSON.stringify({ error: "temporal" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("exa.ai")) {
        return new Response(JSON.stringify({
          results: [
            {
              title: "Documentación oficial",
              url: "https://example.com/docs",
              text: "Contenido verificado",
              publishedDate: "2026-07-16",
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`URL inesperada: ${url}`);
    };

    const result = await runWebSearchWithFallback(
      { query: "documentación actual", numResults: 3 },
      config(),
      undefined,
      fetchMock,
    );

    expect(result.provider).toBe("exa");
    expect(result.text).toContain("https://example.com/docs");
    expect(result.attempts.map((item) => item.status)).toEqual(["failed", "success"]);
    expect(calls.length).toBe(2);
  });

  it("explica cómo configurar motores cuando no hay claves", async () => {
    await expect(runWebSearchWithFallback(
      { query: "algo" },
      {
        settings: normalizeWebSearchSettings(undefined),
        auth: normalizeWebSearchAuth(undefined),
      },
      undefined,
      async () => new Response(),
    )).rejects.toThrow("/setup-search");
  });
});
