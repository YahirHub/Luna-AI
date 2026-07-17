import {
  chatCompletionWithTools,
  type ChatMessage,
  type ToolDefinition,
} from "./ai.ts";
import type { AgentConfig, SearchDepth } from "./agent-config.ts";
import type { LlmConfig } from "./llm-config.ts";
import { getMexicoCityNow } from "./utils.ts";
import { READ_URL_TOOL, executeReadUrlTool } from "./search/read-url.ts";
import { WEB_SEARCH_TOOL, executeWebSearchTool } from "./search/search-tools.ts";

export const RESEARCH_WEB_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "research_web",
    description:
      "Crea automáticamente un subagente investigador aislado para resolver preguntas actuales, comparativas o que requieren varias fuentes. " +
      "El subagente usa web_search y read_url, verifica fuentes y devuelve una síntesis con URLs.",
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

export interface ResearchAgentOptions {
  query: string;
  model: string;
  llmConfig: LlmConfig;
  agentConfig: AgentConfig;
  depth?: SearchDepth;
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

  try {
    const result = await chatCompletionWithTools(
      createResearchMessages(query, depth),
      options.model,
      options.llmConfig,
      [WEB_SEARCH_TOOL, READ_URL_TOOL],
      async (name, args) => {
        if (name === "web_search") {
          return executeWebSearchTool(args, depth, controller.signal);
        }
        if (name === "read_url") {
          return executeReadUrlTool(args, controller.signal);
        }
        return `Error: herramienta de investigación desconocida "${name}".`;
      },
      2,
      undefined,
      { maxRounds: 7, signal: controller.signal },
    );

    if (result.toolsCalled.includes("web_search") && result.content.trim()) {
      return result.content.trim();
    }

    // Algunos gateways ignoran function calling. En ese caso ejecutamos una
    // búsqueda directa y pedimos una síntesis aislada con la evidencia real.
    const evidence = await executeWebSearchTool(
      { query, depth },
      depth,
      controller.signal,
    );
    if (evidence.startsWith("Error:")) return evidence;
    return (await synthesizeFallback(
      query,
      evidence,
      options.model,
      options.llmConfig,
      controller.signal,
    )).trim();
  } catch (error) {
    if (controller.signal.aborted) {
      return `Error: el subagente investigador excedió ${Math.round(options.agentConfig.researcherTimeoutMs / 1000)} segundos.`;
    }
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timeout);
  }
}
