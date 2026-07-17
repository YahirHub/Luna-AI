import type { ToolDefinition } from "../ai.ts";
import type { SearchDepth } from "../agent-config.ts";
import { loadWebSearchAuth, loadWebSearchSettings } from "./search-storage.ts";
import { runWebSearchWithFallback } from "./search-runtime.ts";

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

export async function executeWebSearchTool(
  args: Record<string, unknown>,
  defaultDepth: SearchDepth,
  signal?: AbortSignal,
): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return "Error: la consulta de búsqueda es obligatoria.";
  const depth = args.depth === "deep" || args.depth === "standard"
    ? args.depth
    : defaultDepth;

  try {
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
    );
    return result.text;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
