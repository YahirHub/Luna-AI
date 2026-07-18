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
import { getWebSearchAvailability, type SearchResultItem } from "./search/search-runtime.ts";
import { runSearchWithRetry } from "./search/search-coordinator.ts";
import { debugError, debugInfo, debugLog, debugWarn } from "./debug.ts";
import {
  buildPricingRecoveryQuery,
  extractPricingDataDeterministically,
  getPricingCandidateUrls,
  isOfficialPricingUrl,
  isTrustedPricingSourceUrl,
  pricingDataHasVerifiedPrices,
  type PricingResearchData,
} from "./research/pricing-extractor.ts";

export { pricingDataHasVerifiedPrices } from "./research/pricing-extractor.ts";
export type { PricingFact, PricingResearchData } from "./research/pricing-extractor.ts";

export const RESEARCH_WEB_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "research_web",
    description:
      "Crea automáticamente un subagente investigador aislado para resolver preguntas actuales, comparativas o que requieren fuentes externas. " +
      "El subagente busca, abre y verifica páginas reales antes de responder, y devuelve una síntesis con URLs sin llenar el contexto principal con evidencia intermedia.",
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

export type ResearchKind = "general" | "pricing";

export interface ResearchRequirements {
  kind?: ResearchKind;
  subject?: string;
  minimumVerifiedSources?: number;
}

export interface ResearchAgentOptions {
  query: string;
  model: string;
  llmConfig: LlmConfig;
  agentConfig: AgentConfig;
  depth?: SearchDepth;
  onProgress?: ResearchProgressHandler;
  signal?: AbortSignal;
  requirements?: ResearchRequirements;
  searchExecutor?: typeof executeWebSearchToolDetailed;
  readExecutor?: typeof executeReadUrlTool;
}

export interface ResearchVerifiedSource {
  url: string;
  title?: string;
  snippet?: string;
  content?: string;
  error?: string;
}

export type ResearchDiscoveryMode = "search_and_fetch" | "direct_official" | "search_only" | "none";

export interface ResearchSubagentDetailedResult {
  status: "complete" | "partial" | "failed";
  content: string;
  toolsCalled: string[];
  searchResults: ResearchProgressResult[];
  verifiedSources: ResearchVerifiedSource[];
  pricing?: PricingResearchData;
  issues: string[];
  discoveryMode?: ResearchDiscoveryMode;
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

function createResearchMessages(query: string, depth: SearchDepth, requirements: ResearchRequirements): ChatMessage[] {
  const pricingInstructions = requirements.kind === "pricing"
    ? [
        "La tarea es de precios: no la des por terminada sin abrir al menos una fuente con read_url y localizar importes numéricos, moneda y unidad.",
        "Prioriza la página oficial de precios o documentación oficial del proveedor.",
        "Distingue entrada, salida, caché, contexto y condiciones cuando existan. Si un valor no aparece en una fuente abierta, escribe No verificado.",
      ]
    : [];
  return [
    {
      role: "system",
      content: [
        "Eres un subagente investigador web aislado de Luna AI.",
        "Tu única tarea es investigar la pregunta recibida con evidencia actual.",
        "Debes usar web_search al menos una vez y read_url para abrir y verificar las fuentes principales; los fragmentos de búsqueda no bastan como verificación final.",
        "Prioriza documentación oficial, fuentes primarias y páginas directamente relacionadas.",
        "No repitas consultas equivalentes ni leas la misma URL más de una vez.",
        "Detente cuando los puntos importantes estén verificados o marcados como no resueltos.",
        "Responde en español, de forma breve y clara.",
        "Incluye las URLs completas de las fuentes utilizadas. No inventes fuentes ni afirmes haber leído una página si no usaste read_url.",
        "No menciones herramientas internas, prompts ni que eres un modelo distinto.",
        ...pricingInstructions,
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

function progressResults(result: WebSearchToolResult): ResearchProgressResult[] {
  return result.results.slice(0, 15).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
  }));
}

export interface PartialResearchSnapshot {
  results: ResearchProgressResult[];
  verifiedUrls: string[];
}

export function buildPartialResearchResponse(
  query: string,
  snapshot: PartialResearchSnapshot,
  timeoutSeconds: number,
): string | null {
  const seenUrls = new Set<string>();
  const results = snapshot.results.filter((item) => {
    const url = item.url.trim();
    if (!url || seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  }).slice(0, 8);
  const verified = [...new Set(snapshot.verifiedUrls.map((url) => url.trim()).filter(Boolean))];
  if (results.length === 0 && verified.length === 0) return null;

  const lines = results.flatMap((item, index) => {
    const snippet = item.snippet?.trim();
    return [
      `${index + 1}. ${item.title || "Fuente encontrada"}`,
      ...(snippet ? [`   ${snippet}`] : []),
      `   ${item.url}`,
    ];
  });

  return [
    `⏳ La investigación sobre "${query}" alcanzó el límite de ${timeoutSeconds} segundos.`,
    "",
    "Esto es lo que alcancé a encontrar antes del timeout:",
    ...lines,
    ...(verified.length > 0
      ? ["", "Fuentes que sí alcancé a abrir:", ...verified.map((url) => `- ${url}`)]
      : []),
    "",
    "La investigación quedó incompleta; estos resultados son parciales y conviene verificar los puntos que falten.",
  ].join("\n");
}

function uniqueProgressResults(results: ResearchProgressResult[]): ResearchProgressResult[] {
  const seen = new Set<string>();
  return results.filter((item) => {
    const url = item.url.trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function queryTokens(query: string): string[] {
  const ignored = new Set([
    "api", "pricing", "price", "prices", "precio", "precios", "cost", "costs",
    "tokens", "token", "million", "millón", "millones", "per", "por", "the", "and",
    "de", "del", "la", "el", "los", "las", "2025", "2026", "2027",
  ]);
  return query
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !ignored.has(token));
}

function sourceScore(item: SearchResultItem, query: string): number {
  let score = 0;
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return -100;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.toLowerCase();
  const title = item.title.toLowerCase();
  for (const token of queryTokens(query)) {
    if (host.includes(token)) score += 10;
    if (title.includes(token)) score += 2;
  }
  if (/\b(pricing|price|precios?|cost|billing)\b/.test(path)) score += 9;
  if (/\b(api|docs?|developers?|platform)\b/.test(`${host}${path}`)) score += 5;
  if (/\b(blog|medium|reddit|youtube|facebook|linkedin|pricepertoken|aifreeapi|guru)\b/.test(host)) score -= 8;
  if (url.protocol === "https:") score += 1;
  return score;
}

export function rankResearchSources(results: SearchResultItem[], query: string): SearchResultItem[] {
  return [...results].sort((left, right) => sourceScore(right, query) - sourceScore(left, query));
}

function getResultMetadata(results: ResearchProgressResult[], url: string): Pick<ResearchVerifiedSource, "title" | "snippet"> {
  const item = results.find((entry) => entry.url === url);
  return item ? { title: item.title, snippet: item.snippet } : {};
}

function evidenceBundle(sources: ResearchVerifiedSource[], maxTotalChars = 70_000): string {
  let used = 0;
  const sections: string[] = [];
  for (const source of sources) {
    if (!source.content) continue;
    const remaining = maxTotalChars - used;
    if (remaining <= 0) break;
    const content = source.content.slice(0, Math.min(24_000, remaining));
    used += content.length;
    sections.push([
      `FUENTE: ${source.url}`,
      source.title ? `TÍTULO: ${source.title}` : "",
      "CONTENIDO ABIERTO:",
      content,
    ].filter(Boolean).join("\n"));
  }
  return sections.join("\n\n---\n\n");
}

function safeCell(value: string | null): string {
  return (value ?? "No verificado").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

export function renderPricingResearchMarkdown(data: PricingResearchData, issues: string[] = []): string {
  const rows = data.items.length > 0
    ? data.items.map((item) => [
        safeCell(item.model),
        safeCell(item.inputUsdPerMillion),
        safeCell(item.outputUsdPerMillion),
        safeCell(item.cachedInputUsdPerMillion),
        safeCell(item.contextWindow),
        safeCell(item.conditions),
      ])
    : [["No verificado", "No verificado", "No verificado", "No verificado", "No verificado", "No se localizaron precios verificables en las páginas abiertas."]];
  return [
    `# ${data.provider}`,
    "",
    "## Precios verificados",
    "",
    "| Modelo | Entrada USD / 1M tokens | Salida USD / 1M tokens | Caché USD / 1M tokens | Contexto | Condiciones |",
    "|---|---:|---:|---:|---|---|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    ...(data.notes.length > 0 ? ["", "## Notas", "", ...data.notes.map((note) => `- ${note}`)] : []),
    ...(issues.length > 0 ? ["", "## Advertencias", "", ...issues.map((issue) => `- ${issue}`)] : []),
    "",
    "## Fuentes abiertas y verificadas",
    "",
    ...(data.sources.length > 0 ? data.sources.map((url) => `- ${url}`) : ["- No se pudo verificar una fuente con contenido legible."]),
  ].join("\n");
}

async function synthesizeVerifiedEvidence(
  query: string,
  sources: ResearchVerifiedSource[],
  model: string,
  llmConfig: LlmConfig,
  signal: AbortSignal,
): Promise<string> {
  const evidence = evidenceBundle(sources);
  if (!evidence) return "";
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "Sintetiza una investigación usando exclusivamente el contenido de páginas abiertas que se proporciona.",
        "No uses memoria, fragmentos no abiertos ni conocimientos externos.",
        "Responde en español y marca como No verificado cualquier dato ausente.",
        "Incluye al final las URLs completas realmente utilizadas.",
      ].join("\n"),
    },
    { role: "user", content: `Pregunta:\n${query}\n\nEvidencia verificada:\n${evidence}` },
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
  return result.content.trim();
}

function researchStatus(
  requirements: ResearchRequirements,
  verifiedSources: ResearchVerifiedSource[],
  content: string,
  pricing: PricingResearchData | undefined,
  searchResults: ResearchProgressResult[],
): { status: ResearchSubagentDetailedResult["status"]; issues: string[] } {
  const issues: string[] = [];
  const readableSources = verifiedSources.filter((source) => Boolean(source.content));
  const minimum = Math.max(1, requirements.minimumVerifiedSources ?? (requirements.kind === "pricing" ? 2 : 1));
  if (readableSources.length < minimum) {
    issues.push(`Solo se pudieron abrir ${readableSources.length} de ${minimum} fuentes mínimas.`);
  }
  if (requirements.kind === "pricing" && (!pricing || !pricingDataHasVerifiedPrices(pricing))) {
    issues.push("No se localizaron importes numéricos verificables en las páginas abiertas.");
  }
  if (!content.trim()) issues.push("El investigador no produjo una síntesis utilizable.");

  if (requirements.kind === "pricing") {
    if (pricing && pricingDataHasVerifiedPrices(pricing) && readableSources.length >= minimum) {
      return { status: "complete", issues };
    }
    if (readableSources.length > 0 || searchResults.length > 0) return { status: "partial", issues };
    return { status: "failed", issues };
  }

  if (content.trim() && readableSources.length >= minimum) return { status: "complete", issues };
  if (content.trim() || readableSources.length > 0 || searchResults.length > 0) return { status: "partial", issues };
  return { status: "failed", issues };
}

export async function runResearchSubagentDetailed(
  options: ResearchAgentOptions,
): Promise<ResearchSubagentDetailedResult> {
  const query = options.query.trim();
  if (!query) {
    return { status: "failed", content: "", toolsCalled: [], searchResults: [], verifiedSources: [], issues: ["La pregunta de investigación está vacía."] };
  }
  if (!options.agentConfig.webSearchEnabled) {
    return { status: "failed", content: "", toolsCalled: [], searchResults: [], verifiedSources: [], issues: ["La búsqueda web está desactivada en /config."] };
  }
  if (!options.agentConfig.researchSubagentEnabled) {
    return { status: "failed", content: "", toolsCalled: [], searchResults: [], verifiedSources: [], issues: ["El subagente investigador está desactivado en /config."] };
  }

  const requirements: ResearchRequirements = {
    kind: options.requirements?.kind ?? "general",
    subject: options.requirements?.subject ?? query,
    minimumVerifiedSources: options.requirements?.minimumVerifiedSources,
  };
  const depth = options.depth ?? options.agentConfig.defaultSearchDepth;
  const searchExecutor = options.searchExecutor ?? executeWebSearchToolDetailed;
  const readExecutor = options.readExecutor ?? executeReadUrlTool;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => {
    controller.abort(options.signal?.reason ?? new Error("research-cancelled"));
  };
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("research-timeout"));
  }, options.agentConfig.researcherTimeoutMs);

  await emitProgress(options.onProgress, { type: "started", query, depth });

  const allSearchResults: ResearchProgressResult[] = [];
  const rawSearchItems: SearchResultItem[] = [];
  const verifiedSources = new Map<string, ResearchVerifiedSource>();
  const operationalIssues: string[] = [];
  let initialContent = "";
  let toolsCalled: string[] = [];
  let searchAttempted = false;
  let searchSucceeded = false;

  debugInfo("research.worker", "started", {
    query,
    subject: requirements.subject,
    kind: requirements.kind,
    depth,
    timeoutMs: options.agentConfig.researcherTimeoutMs,
  });

  const recordSearch = async (args: Record<string, unknown>): Promise<string> => {
    searchAttempted = true;
    const searchQuery = typeof args.query === "string" && args.query.trim() ? args.query.trim() : query;
    const requestedDepth: SearchDepth = args.depth === "deep" || args.depth === "standard" ? args.depth : depth;
    await emitProgress(options.onProgress, { type: "searching", query: searchQuery, depth: requestedDepth });
    debugLog("research.search", "requested", {
      subject: requirements.subject,
      query: searchQuery,
      depth: requestedDepth,
      existingResults: rawSearchItems.length,
    });
    const startedAt = Date.now();
    const executeSearch = () => searchExecutor(
      { ...args, query: searchQuery, depth: requestedDepth },
      requestedDepth,
      controller.signal,
    );
    const searchResult = options.searchExecutor
      ? await executeSearch()
      : await runSearchWithRetry(
          `${requirements.subject ?? query}:${searchQuery}`,
          executeSearch,
          controller.signal,
        );
    searchSucceeded = true;
    rawSearchItems.push(...searchResult.results);
    allSearchResults.push(...progressResults(searchResult));
    debugInfo("research.search", "completed", {
      subject: requirements.subject,
      query: searchQuery,
      depth: requestedDepth,
      provider: searchResult.provider,
      providerLabel: searchResult.providerLabel,
      resultCount: searchResult.resultCount,
      durationMs: Date.now() - startedAt,
    });
    await emitProgress(options.onProgress, {
      type: "search_results",
      query: searchResult.query,
      provider: searchResult.provider,
      providerLabel: searchResult.providerLabel,
      resultCount: searchResult.resultCount,
      results: progressResults(searchResult).slice(0, 8),
    });
    return searchResult.text;
  };

  const tryRecordSearch = async (args: Record<string, unknown>, phase: string): Promise<boolean> => {
    try {
      await recordSearch(args);
      toolsCalled.push("web_search");
      return true;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      operationalIssues.push(`La búsqueda web falló durante ${phase}: ${reason}`);
      debugError("research.search", "failed_but_recoverable", error, {
        subject: requirements.subject,
        query: args.query,
        phase,
      });
      return false;
    }
  };

  const recordRead = async (args: Record<string, unknown>): Promise<string> => {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) return "Error: la URL es obligatoria.";
    const existing = verifiedSources.get(url);
    if (existing?.content) return existing.content;
    await emitProgress(options.onProgress, { type: "reading_source", url });
    const startedAt = Date.now();
    debugLog("research.fetch", "requested", {
      subject: requirements.subject,
      url,
      maxChars: args.max_chars ?? 30_000,
    });
    const readResult = await readExecutor({ ...args, max_chars: args.max_chars ?? 30_000 }, controller.signal);
    const metadata = getResultMetadata(uniqueProgressResults(allSearchResults), url);
    if (readResult.startsWith("Error:")) {
      const reason = readResult.slice(6).trim();
      verifiedSources.set(url, { url, ...metadata, error: reason });
      debugWarn("research.fetch", "failed", {
        subject: requirements.subject,
        url,
        durationMs: Date.now() - startedAt,
        error: reason,
      });
    } else {
      verifiedSources.set(url, { url, ...metadata, content: readResult });
      debugInfo("research.fetch", "completed", {
        subject: requirements.subject,
        url,
        durationMs: Date.now() - startedAt,
        contentChars: readResult.length,
      });
      await emitProgress(options.onProgress, { type: "source_read", url });
    }
    return readResult;
  };

  try {
    let hasReportedSynthesis = false;
    const reportSynthesis = async (): Promise<void> => {
      if (hasReportedSynthesis) return;
      hasReportedSynthesis = true;
      await emitProgress(options.onProgress, { type: "synthesizing" });
    };

    if (requirements.kind === "pricing") {
      // Las investigaciones de precios usan un pipeline especializado. No se
      // deja la búsqueda/lectura a criterio del modelo porque una respuesta
      // verbal vacía no demuestra que se hayan extraído importes.
      const subject = requirements.subject ?? query;
      const recoveryQuery = buildPricingRecoveryQuery(subject, query);
      const availability = options.searchExecutor ? undefined : getWebSearchAvailability();
      if (options.searchExecutor || availability?.available) {
        await tryRecordSearch({ query: recoveryQuery, depth: "deep" }, "búsqueda inicial de precios");
      } else {
        const reason = "No hay motores de búsqueda habilitados con API key; se usará lectura directa de documentación oficial.";
        operationalIssues.push(reason);
        debugWarn("research.search", "skipped_no_provider", {
          subject,
          query: recoveryQuery,
          providerOrder: availability?.providerOrder ?? [],
          fallbackUrls: getPricingCandidateUrls(subject),
        });
      }
    } else {
      try {
        const result = await chatCompletionWithTools(
          createResearchMessages(query, depth, requirements),
          options.model,
          options.llmConfig,
          [WEB_SEARCH_TOOL, READ_URL_TOOL],
          async (name, args) => {
            try {
              if (name === "web_search") return await recordSearch(args);
              if (name === "read_url") return await recordRead(args);
              return `Error: herramienta de investigación desconocida "${name}".`;
            } catch (error) {
              if (controller.signal.aborted) throw error;
              return `Error: ${error instanceof Error ? error.message : String(error)}`;
            }
          },
          2,
          undefined,
          {
            maxRounds: 7,
            signal: controller.signal,
            onToolRoundComplete: async () => reportSynthesis(),
          },
        );
        initialContent = result.content.trim();
        toolsCalled = result.toolsCalled;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        console.warn("[research] El ciclo guiado por tools falló; se intentará recuperación directa:", error);
      }
    }

    if (requirements.kind !== "pricing" && !toolsCalled.includes("web_search") && rawSearchItems.length === 0) {
      await tryRecordSearch({ query, depth }, "búsqueda de recuperación");
    }

    const minimumSources = Math.max(1, requirements.minimumVerifiedSources ?? 1);
    const targetSources = requirements.kind === "pricing"
      ? minimumSources
      : Math.max(minimumSources, depth === "deep" ? 2 : 1);
    const alreadyReadable = () => [...verifiedSources.values()].filter((source) => Boolean(source.content)).length;
    // Cuatro lecturas mantienen la investigación dentro del timeout global aun
    // cuando cada página agote los 20 s de fetch.
    const maximumReads = requirements.kind === "pricing" ? 4 : depth === "deep" ? 5 : 3;

    const readCandidates = async (urls: string[]): Promise<void> => {
      let attemptedReads = 0;
      for (const url of urls) {
        if (requirements.kind !== "pricing" && alreadyReadable() >= targetSources) break;
        if (verifiedSources.has(url)) continue;
        if (verifiedSources.size >= maximumReads) break;

        if (requirements.kind === "pricing") {
          const pricesAlreadyIndexed = pricingDataHasVerifiedPrices(extractPricingDataDeterministically(
            requirements.subject ?? query,
            [...verifiedSources.values()],
            rawSearchItems,
          ));
          // Si el motor ya devolvió importes desde una URL oficial, se intenta
          // abrir un máximo de dos páginas para elevar la evidencia a completa.
          // No se consumen los 120 s del trabajador recorriendo diez páginas
          // dinámicas que responden sin contenido o agotan su timeout.
          if (pricesAlreadyIndexed && attemptedReads >= 2) break;
        }

        await recordRead({ url, max_chars: requirements.kind === "pricing" ? 50_000 : 30_000 });
        attemptedReads += 1;
        toolsCalled.push("read_url");
        if (requirements.kind === "pricing") {
          const deterministic = extractPricingDataDeterministically(
            requirements.subject ?? query,
            [...verifiedSources.values()],
            rawSearchItems,
          );
          if (
            pricingDataHasVerifiedPrices(deterministic) &&
            (alreadyReadable() >= targetSources || attemptedReads >= 2)
          ) break;
        }
      }
    };

    const ranked = rankResearchSources(rawSearchItems, query);
    if (requirements.kind === "pricing") {
      const subject = requirements.subject ?? query;
      const trustedRanked = ranked.filter((candidate) => isTrustedPricingSourceUrl(subject, candidate.url));
      await readCandidates([
        ...getPricingCandidateUrls(subject),
        ...trustedRanked.map((candidate) => candidate.url),
      ]);

      let deterministic = extractPricingDataDeterministically(subject, [...verifiedSources.values()], rawSearchItems);
      debugLog("research.pricing", "first_extraction", {
        subject,
        items: deterministic.items.length,
        sources: deterministic.sources.length,
        searchResults: rawSearchItems.length,
        readableSources: alreadyReadable(),
      });
      debugLog("research.pricing", "extracted_rows", {
        subject,
        discoveryMode: searchSucceeded ? "search_and_fetch" : "direct_official",
        rows: deterministic.items.map((item) => ({
          model: item.model,
          inputUsdPerMillion: item.inputUsdPerMillion,
          cachedInputUsdPerMillion: item.cachedInputUsdPerMillion,
          outputUsdPerMillion: item.outputUsdPerMillion,
          contextWindow: item.contextWindow,
          conditions: item.conditions,
          sourceUrls: item.sourceUrls,
        })),
      });
      if (!pricingDataHasVerifiedPrices(deterministic)) {
        const availability = options.searchExecutor ? undefined : getWebSearchAvailability();
        if (options.searchExecutor || availability?.available) {
          await tryRecordSearch({
            query: `${buildPricingRecoveryQuery(subject, query)} model price table cached input output`,
            depth: "deep",
          }, "segunda búsqueda de precios");
        }
        const retryRanked = rankResearchSources(rawSearchItems, query);
        await readCandidates([
          ...retryRanked.filter((candidate) => isOfficialPricingUrl(subject, candidate.url)).map((candidate) => candidate.url),
          ...retryRanked.filter((candidate) => !isOfficialPricingUrl(subject, candidate.url)).map((candidate) => candidate.url),
        ]);
        deterministic = extractPricingDataDeterministically(subject, [...verifiedSources.values()], rawSearchItems);
      }
    } else {
      await readCandidates(ranked.map((candidate) => candidate.url));
    }

    await reportSynthesis();
    const readableSources = [...verifiedSources.values()].filter((source) => Boolean(source.content));
    let pricing: PricingResearchData | undefined;
    let content = initialContent;

    if (requirements.kind === "pricing") {
      const subject = requirements.subject ?? query;
      pricing = extractPricingDataDeterministically(subject, [...verifiedSources.values()], rawSearchItems);
      const preliminaryIssues: string[] = [];
      if (!pricingDataHasVerifiedPrices(pricing)) {
        preliminaryIssues.push("No se localizaron precios verificables ni en las páginas abiertas ni en fragmentos oficiales indexados.");
      }
      content = renderPricingResearchMarkdown(pricing, preliminaryIssues);
    } else if (readableSources.length > 0) {
      try {
        content = await synthesizeVerifiedEvidence(
          query,
          readableSources,
          options.model,
          options.llmConfig,
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (!content) console.warn("[research] No se pudo sintetizar la evidencia abierta:", error);
      }
    }

    const searchResults = uniqueProgressResults(allSearchResults);
    const quality = researchStatus(requirements, readableSources, content, pricing, searchResults);
    const combinedIssues = [...new Set([...operationalIssues, ...quality.issues])];
    if (requirements.kind === "pricing" && pricing) {
      content = renderPricingResearchMarkdown(pricing, combinedIssues);
    }
    debugInfo("research.worker", "completed", {
      subject: requirements.subject,
      status: quality.status,
      toolsCalled: [...new Set(toolsCalled)],
      searchResults: searchResults.length,
      verifiedSources: verifiedSources.size,
      readableSources: readableSources.length,
      pricingItems: pricing?.items.length ?? 0,
      pricingSources: pricing?.sources.length ?? 0,
      issues: combinedIssues,
      discoveryMode: searchSucceeded
        ? "search_and_fetch"
        : readableSources.length > 0
          ? "direct_official"
          : searchAttempted
            ? "search_only"
            : "none",
    });
    await emitProgress(options.onProgress, { type: "completed" });
    return {
      status: quality.status,
      content,
      toolsCalled: [...new Set(toolsCalled)],
      searchResults,
      verifiedSources: [...verifiedSources.values()],
      pricing,
      issues: combinedIssues,
      discoveryMode: searchSucceeded
        ? "search_and_fetch"
        : readableSources.length > 0
          ? "direct_official"
          : searchAttempted
            ? "search_only"
            : "none",
    };
  } catch (error) {
    if (controller.signal.aborted) {
      if (timedOut) {
        const partial = buildPartialResearchResponse(
          query,
          {
            results: uniqueProgressResults(allSearchResults),
            verifiedUrls: [...verifiedSources.values()].filter((source) => Boolean(source.content)).map((source) => source.url),
          },
          Math.round(options.agentConfig.researcherTimeoutMs / 1000),
        );
        if (partial) {
          return {
            status: "partial",
            content: partial,
            toolsCalled: [...new Set(toolsCalled)],
            searchResults: uniqueProgressResults(allSearchResults),
            verifiedSources: [...verifiedSources.values()],
            issues: ["La investigación alcanzó su timeout."],
          };
        }
      }
      throw options.signal?.aborted
        ? options.signal.reason ?? error
        : error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    debugError("research.worker", "failed", error, {
      query,
      subject: requirements.subject,
      kind: requirements.kind,
      toolsCalled: [...new Set(toolsCalled)],
      searchResults: rawSearchItems.length,
      verifiedSources: verifiedSources.size,
      operationalIssues,
    });
    return {
      status: rawSearchItems.length > 0 || verifiedSources.size > 0 ? "partial" : "failed",
      content: initialContent,
      toolsCalled: [...new Set(toolsCalled)],
      searchResults: uniqueProgressResults(allSearchResults),
      verifiedSources: [...verifiedSources.values()],
      issues: [reason],
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

export async function runResearchSubagent(
  options: ResearchAgentOptions,
): Promise<string> {
  const result = await runResearchSubagentDetailed(options);
  if (result.status === "failed") {
    return `Error: ${result.issues.join(" ") || "la investigación no obtuvo evidencia utilizable."}`;
  }
  if (result.status === "partial") {
    const warning = result.issues.length > 0
      ? `⚠️ Investigación parcial: ${result.issues.join(" ")}`
      : "⚠️ Investigación parcial.";
    return [warning, result.content].filter(Boolean).join("\n\n");
  }
  return result.content;
}
