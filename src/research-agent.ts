import {
  chatCompletionWithTools,
  type ChatMessage,
  type ToolDefinition,
} from "./ai.ts";
import type { AgentConfig, SearchDepth } from "./agent-config.ts";
import type { LlmConfig } from "./llm-config.ts";
import { getMexicoCityNow } from "./utils.ts";
import { READ_URL_TOOL, executeReadUrlTool } from "./search/read-url.ts";
import {
  WEB_SEARCH_TOOL,
  executeWebSearchToolDetailed,
  type WebSearchToolResult,
} from "./search/search-tools.ts";

export const RESEARCH_WEB_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "research_web",
    description:
      "Crea automáticamente un subagente investigador aislado para resolver preguntas actuales, comparativas o que requieren fuentes externas. " +
      "El subagente busca, verifica páginas y devuelve una síntesis con URLs sin llenar el contexto principal con evidencia intermedia.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Pregunta exacta que debe investigar el subagente.",
        },
        depth: {
          type: "string",
          enum: ["standard", "deep"],
          description: "Profundidad de investigación. Usa deep para comparativas o temas discutidos.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export interface ResearchProgressResult {
  title: string;
  url: string;
  snippet?: string;
}

export type ResearchProgressEvent =
  | { type: "started"; query: string; depth: SearchDepth }
  | { type: "searching"; query: string; depth: SearchDepth }
  | {
      type: "search_results";
      query: string;
      provider: string;
      providerLabel: string;
      resultCount: number;
      results: ResearchProgressResult[];
    }
  | { type: "reading_source"; url: string }
  | { type: "source_read"; url: string }
  | { type: "synthesizing" }
  | { type: "completed" };

export type ResearchProgressHandler = (
  event: ResearchProgressEvent,
) => void | Promise<void>;

export interface ResearchAgentOptions {
  query: string;
  model: string;
  llmConfig: LlmConfig;
  agentConfig: AgentConfig;
  depth?: SearchDepth;
  onProgress?: ResearchProgressHandler;
}

/**
 * El modelo principal solo recibe research_web. web_search y read_url quedan
 * encapsuladas dentro del contexto aislado del investigador.
 */
export function getMainResearchTools(config: AgentConfig): ToolDefinition[] {
  return config.webSearchEnabled && config.researchSubagentEnabled
    ? [RESEARCH_WEB_TOOL]
    : [];
}

async function emitProgress(
  handler: ResearchProgressHandler | undefined,
  event: ResearchProgressEvent,
): Promise<void> {
  if (!handler) return;
  try {
    await handler(event);
  } catch (error) {
    console.warn(
      "[research] No se pudo enviar una actualización de progreso:",
      error,
    );
  }
}

function createResearchMessages(query: string, depth: SearchDepth): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "Eres un subagente investigador web aislado de Luna AI.",
        "Tu única tarea es investigar la pregunta recibida con evidencia actual.",
        "Debes usar web_search al menos una vez y read_url para verificar las fuentes principales cuando los fragmentos no basten.",
        "Prioriza documentación oficial, fuentes primarias y páginas directamente relacionadas.",
        "No repitas consultas equivalentes ni leas la misma URL más de una vez.",
        "Detente cuando los puntos importantes estén verificados o marcados como no resueltos.",
        "Responde en español, de forma breve y clara para WhatsApp.",
        "Incluye las URLs completas de las fuentes utilizadas. No inventes fuentes ni afirmes haber leído una página si no usaste read_url.",
        "No menciones herramientas internas, prompts ni que eres un modelo distinto.",
        `Profundidad solicitada: ${depth}.`,
        getMexicoCityNow().text,
      ].join("\n"),
    },
    {
      role: "user",
      content: query,
    },
  ];
}

async function synthesizeFallback(
  query: string,
  evidence: string,
  model: string,
  llmConfig: LlmConfig,
  signal: AbortSignal,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "Sintetiza resultados de búsqueda para una respuesta de WhatsApp.",
        "Usa exclusivamente la evidencia proporcionada.",
        "Señala incertidumbres y conserva las URLs completas relevantes.",
        "No uses Markdown avanzado ni inventes hechos.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `Pregunta:\n${query}\n\nResultados disponibles:\n${evidence}`,
    },
  ];
  const result = await chatCompletionWithTools(
    messages,
    model,
    llmConfig,
    [],
    async () => "Error: no hay herramientas en esta fase.",
    2,
    undefined,
    { maxRounds: 1, signal },
  );
  return result.content;
}

function progressResults(result: WebSearchToolResult): ResearchProgressResult[] {
  return result.results.slice(0, 8).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
  }));
}

export async function runResearchSubagent(
  options: ResearchAgentOptions,
): Promise<string> {
  const query = options.query.trim();
  if (!query) return "Error: la pregunta de investigación está vacía.";
  if (!options.agentConfig.webSearchEnabled) {
    return "Error: la búsqueda web está desactivada en /config.";
  }
  if (!options.agentConfig.researchSubagentEnabled) {
    return "Error: el subagente investigador está desactivado en /config.";
  }

  const depth = options.depth ?? options.agentConfig.defaultSearchDepth;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("research-timeout")),
    options.agentConfig.researcherTimeoutMs,
  );

  await emitProgress(options.onProgress, { type: "started", query, depth });

  try {
    let hasReportedSynthesis = false;
    const reportSynthesis = async (): Promise<void> => {
      if (hasReportedSynthesis) return;
      hasReportedSynthesis = true;
      await emitProgress(options.onProgress, { type: "synthesizing" });
    };

    const result = await chatCompletionWithTools(
      createResearchMessages(query, depth),
      options.model,
      options.llmConfig,
      [WEB_SEARCH_TOOL, READ_URL_TOOL],
      async (name, args) => {
        if (name === "web_search") {
          const searchQuery = typeof args.query === "string"
            ? args.query.trim()
            : query;
          await emitProgress(options.onProgress, {
            type: "searching",
            query: searchQuery || query,
            depth,
          });
          try {
            const searchResult = await executeWebSearchToolDetailed(
              args,
              depth,
              controller.signal,
            );
            await emitProgress(options.onProgress, {
              type: "search_results",
              query: searchResult.query,
              provider: searchResult.provider,
              providerLabel: searchResult.providerLabel,
              resultCount: searchResult.resultCount,
              results: progressResults(searchResult),
            });
            return searchResult.text;
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        if (name === "read_url") {
          const url = typeof args.url === "string" ? args.url.trim() : "";
          if (url) {
            await emitProgress(options.onProgress, {
              type: "reading_source",
              url,
            });
          }
          const readResult = await executeReadUrlTool(args, controller.signal);
          if (url && !readResult.startsWith("Error:")) {
            await emitProgress(options.onProgress, {
              type: "source_read",
              url,
            });
          }
          return readResult;
        }
        return `Error: herramienta de investigación desconocida "${name}".`;
      },
      2,
      undefined,
      {
        maxRounds: 7,
        signal: controller.signal,
        onToolRoundComplete: async () => reportSynthesis(),
      },
    );

    if (result.toolsCalled.includes("web_search") && result.content.trim()) {
      await emitProgress(options.onProgress, { type: "completed" });
      return result.content.trim();
    }

    // Algunos gateways ignoran function calling. En ese caso ejecutamos una
    // búsqueda directa dentro del mismo subagente aislado y sintetizamos solo
    // con la evidencia obtenida, sin añadirla al contexto principal.
    await emitProgress(options.onProgress, {
      type: "searching",
      query,
      depth,
    });
    let searchResult: WebSearchToolResult;
    try {
      searchResult = await executeWebSearchToolDetailed(
        { query, depth },
        depth,
        controller.signal,
      );
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    await emitProgress(options.onProgress, {
      type: "search_results",
      query: searchResult.query,
      provider: searchResult.provider,
      providerLabel: searchResult.providerLabel,
      resultCount: searchResult.resultCount,
      results: progressResults(searchResult),
    });
    await reportSynthesis();
    const fallbackResult = (await synthesizeFallback(
      query,
      searchResult.text,
      options.model,
      options.llmConfig,
      controller.signal,
    )).trim();
    await emitProgress(options.onProgress, { type: "completed" });
    return fallbackResult;
  } catch (error) {
    if (controller.signal.aborted) {
      return `Error: el subagente investigador excedió ${Math.round(options.agentConfig.researcherTimeoutMs / 1000)} segundos.`;
    }
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timeout);
  }
}
