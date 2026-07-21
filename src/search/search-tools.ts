import type { ToolDefinition } from "../ai.ts";
import type { AgentExecutionLogContext } from "../agents/agent-types.ts";
import type { SearchDepth } from "../agent-config.ts";
import { SEARCH_PROVIDER_LABELS } from "./search-config.ts";
import { loadWebSearchAuth, loadWebSearchSettings } from "./search-storage.ts";
import {
  runWebSearchWithFallback,
  type SearchResultItem,
} from "./search-runtime.ts";

export const WEB_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Busca información actual en internet usando el motor configurado y sus respaldos. " +
      "Devuelve títulos, URLs, fechas, autores y fragmentos normalizados. Usa read_url para verificar las fuentes importantes.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Consulta concreta que debe buscarse en internet.",
        },
        depth: {
          type: "string",
          enum: ["standard", "deep"],
          description: "standard para una búsqueda rápida; deep para una investigación más amplia.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export interface WebSearchToolResult {
  text: string;
  query: string;
  depth: SearchDepth;
  provider: string;
  providerLabel: string;
  resultCount: number;
  results: SearchResultItem[];
}

export async function executeWebSearchToolDetailed(
  args: Record<string, unknown>,
  defaultDepth: SearchDepth,
  signal?: AbortSignal,
  executionContext?: AgentExecutionLogContext,
): Promise<WebSearchToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("La consulta de búsqueda es obligatoria.");
  const depth = args.depth === "deep" || args.depth === "standard"
    ? args.depth
    : defaultDepth;

  const result = await runWebSearchWithFallback(
    {
      query,
      numResults: depth === "deep" ? 15 : 8,
      type: depth === "deep" ? "deep" : "fast",
      livecrawl: depth === "deep" ? "preferred" : "fallback",
    },
    {
      settings: loadWebSearchSettings(),
      auth: loadWebSearchAuth(),
    },
    signal,
    fetch,
    executionContext,
  );

  return {
    text: result.text,
    query,
    depth,
    provider: result.provider,
    providerLabel: SEARCH_PROVIDER_LABELS[result.provider],
    resultCount: result.resultCount,
    results: result.results,
  };
}

export async function executeWebSearchTool(
  args: Record<string, unknown>,
  defaultDepth: SearchDepth,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return (await executeWebSearchToolDetailed(args, defaultDepth, signal)).text;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
