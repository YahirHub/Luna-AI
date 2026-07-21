import {
  getSearchProviderOrder,
  resolveSearchProviderState,
  SEARCH_PROVIDER_LABELS,
  type SearchProviderId,
  type WebSearchAuth,
  type WebSearchSettings,
} from "./search-config.ts"
import { loadWebSearchAuth, loadWebSearchSettings } from "./search-storage.ts"
import { debugError, debugInfo, debugLog, debugWarn } from "../debug.ts"

export const DEFAULT_SEARCH_TIMEOUT_MS = 20_000

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

const SEARCH_PROVIDER_MIN_INTERVAL_MS: Record<SearchProviderId, number> = {
  // Tavily Free limita especialmente las ráfagas. La cola por proveedor evita
  // que cuatro subagentes paralelos consuman la primera búsqueda a la vez.
  tavily: 1_250,
  brave: 1_100,
  exa: 0,
  linkup: 0,
  firecrawl: 0,
  serpapi: 0,
  zenserp: 0,
}

const MAX_RATE_LIMIT_RETRY_DELAY_MS = 2_500

const providerRequestChains = new Map<SearchProviderId, Promise<void>>()
const providerNextAllowedAt = new Map<SearchProviderId, number>()

class SearchHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'SearchHttpError'
  }
}

export type WebSearchType = 'auto' | 'fast' | 'deep'
export type WebSearchLivecrawlMode = 'fallback' | 'preferred'

export interface WebSearchRequest {
  query: string
  numResults?: number
  livecrawl?: WebSearchLivecrawlMode
  type?: WebSearchType
  contextMaxCharacters?: number
}

export interface NormalizedWebSearchRequest {
  query: string
  numResults: number
  livecrawl: WebSearchLivecrawlMode
  type: WebSearchType
  contextMaxCharacters?: number
}

export interface SearchAttempt {
  provider: SearchProviderId
  status: 'success' | 'failed' | 'skipped'
  message?: string
}

export interface WebSearchRuntimeResult {
  provider: SearchProviderId
  endpoint: string
  request: NormalizedWebSearchRequest
  resultCount: number
  text: string
  results: SearchResultItem[]
  attempts: SearchAttempt[]
}

export interface SearchResultItem {
  title: string
  url: string
  snippet?: string
  publishedDate?: string
  author?: string
}

interface TavilySearchResponse {
  results?: Array<{
    title?: unknown
    url?: unknown
    content?: unknown
    published_date?: unknown
  }>
  answer?: unknown
}

interface ExaSearchResponse {
  results?: Array<{
    title?: unknown
    url?: unknown
    publishedDate?: unknown
    author?: unknown
    text?: unknown
    summary?: unknown
    highlights?: unknown
  }>
}

interface LinkupSearchResponse {
  results?: Array<{
    name?: unknown
    title?: unknown
    url?: unknown
    content?: unknown
    date?: unknown
    type?: unknown
  }>
}

interface FirecrawlSearchResponse {
  success?: unknown
  error?: unknown
  warning?: unknown
  data?: {
    web?: Array<{
      title?: unknown
      description?: unknown
      url?: unknown
      markdown?: unknown
      metadata?: {
        title?: unknown
        description?: unknown
        sourceURL?: unknown
        url?: unknown
        publishedTime?: unknown
        author?: unknown
      }
    }>
  }
}

interface SerpApiSearchResponse {
  error?: unknown
  organic_results?: Array<{
    title?: unknown
    link?: unknown
    snippet?: unknown
    date?: unknown
    source?: unknown
  }>
}

interface ZenserpSearchResponse {
  error?: unknown
  message?: unknown
  organic?: Array<{
    title?: unknown
    url?: unknown
    link?: unknown
    destination?: unknown
    description?: unknown
    date?: unknown
    source?: unknown
  }>
}

interface BraveWebSearchResponse {
  web?: {
    results?: Array<{
      title?: unknown
      url?: unknown
      description?: unknown
      age?: unknown
      page_age?: unknown
      extra_snippets?: unknown
    }>
  }
}

interface BraveContextItem {
  name?: unknown
  title?: unknown
  url?: unknown
  snippets?: unknown
}

interface BraveLlmContextResponse {
  grounding?: {
    generic?: BraveContextItem[]
    map?: BraveContextItem[]
    poi?: BraveContextItem | null
  }
  sources?: Record<
    string,
    {
      title?: unknown
      hostname?: unknown
      age?: unknown
    }
  >
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value as number)))
}

export function normalizeWebSearchRequest(
  input: WebSearchRequest,
): NormalizedWebSearchRequest {
  const query = input.query.trim()
  if (!query) throw new Error('La consulta de búsqueda no puede estar vacía.')

  const normalized: NormalizedWebSearchRequest = {
    query,
    numResults: clampInteger(input.numResults, 8, 1, 50),
    livecrawl: input.livecrawl === 'preferred' ? 'preferred' : 'fallback',
    type: input.type === 'fast' || input.type === 'deep' ? input.type : 'auto',
  }
  if (input.contextMaxCharacters !== undefined) {
    normalized.contextMaxCharacters = clampInteger(
      input.contextMaxCharacters,
      15_000,
      1_000,
      100_000,
    )
  }
  return normalized
}

function createAttemptAbortContext(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController()
  let timeoutTriggered = false
  const timer = setTimeout(() => {
    timeoutTriggered = true
    controller.abort(new Error('timeout'))
  }, timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

function compactErrorBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 280)
}

function extractProviderErrorDetail(body: string): string | undefined {
  try {
    const payload = JSON.parse(body) as {
      detail?: unknown
      error?: unknown | { detail?: unknown; message?: unknown }
      message?: unknown
    }
    const nested =
      typeof payload.error === 'object' && payload.error !== null
        ? (payload.error as { detail?: unknown; message?: unknown })
        : undefined
    for (const value of [
      nested?.detail,
      nested?.message,
      payload.detail,
      payload.message,
      payload.error,
    ]) {
      const text = cleanText(value)
      if (text) return text
    }
  } catch {
    // The fallback below handles non-JSON error pages.
  }
  return compactErrorBody(body) || undefined
}

function formatProviderHttpError(
  provider: SearchProviderId,
  status: number,
  body: string,
): string {
  if (status === 429) {
    return `${SEARCH_PROVIDER_LABELS[provider]} alcanzó temporalmente su límite de solicitudes (HTTP 429).`
  }
  const detail = extractProviderErrorDetail(body)
  return `${SEARCH_PROVIDER_LABELS[provider]} respondió HTTP ${status}${detail ? `: ${detail}` : '.'}`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('Operación cancelada'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1_000)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.max(0, timestamp - Date.now())
}

async function runWithProviderSpacing<T>(
  provider: SearchProviderId,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = providerRequestChains.get(provider) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => undefined).then(() => current)
  providerRequestChains.set(provider, queued)

  await previous.catch(() => undefined)
  try {
    const nextAllowedAt = providerNextAllowedAt.get(provider) ?? 0
    const waitMs = Math.max(0, nextAllowedAt - Date.now())
    debugLog("api-search.provider-queue", "ready", {
      provider,
      waitMs,
      minimumIntervalMs: SEARCH_PROVIDER_MIN_INTERVAL_MS[provider],
    })
    await sleep(waitMs, signal)
    providerNextAllowedAt.set(
      provider,
      Date.now() + SEARCH_PROVIDER_MIN_INTERVAL_MS[provider],
    )
    return await operation()
  } finally {
    release()
    if (providerRequestChains.get(provider) === queued)
      providerRequestChains.delete(provider)
  }
}

async function fetchJson(
  endpoint: string,
  init: RequestInit,
  provider: SearchProviderId,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await runWithProviderSpacing(provider, signal, async () => {
        const abortContext = createAttemptAbortContext(
          signal,
          DEFAULT_SEARCH_TIMEOUT_MS,
        )
        try {
          const response = await fetchImpl(endpoint, {
            ...init,
            signal: abortContext.signal,
          })
          const body = await response.text()
          if (!response.ok) {
            throw new SearchHttpError(
              formatProviderHttpError(provider, response.status, body),
              response.status,
              parseRetryAfterMs(response.headers.get('retry-after')),
            )
          }
          try {
            return JSON.parse(body) as unknown
          } catch {
            throw new Error(
              `${SEARCH_PROVIDER_LABELS[provider]} devolvió JSON inválido.`,
            )
          }
        } catch (error) {
          if (signal?.aborted) throw new Error('Operación cancelada')
          if (abortContext.timedOut()) {
            throw new Error(
              `${SEARCH_PROVIDER_LABELS[provider]} excedió el límite de ${DEFAULT_SEARCH_TIMEOUT_MS / 1000}s.`,
            )
          }
          throw error
        } finally {
          abortContext.cleanup()
        }
      })
    } catch (error) {
      if (
        !(error instanceof SearchHttpError) ||
        error.status !== 429 ||
        attempt > 0
      )
        throw error
      const retryDelay = Math.max(
        error.retryAfterMs ?? 0,
        SEARCH_PROVIDER_MIN_INTERVAL_MS[provider],
        1_000,
      )
      debugWarn("api-search.provider", "rate_limited", {
        provider,
        attempt: attempt + 1,
        retryDelay,
        retryAfterMs: error.retryAfterMs,
        message: error.message,
      })
      // Long provider cooldowns should trigger the next configured engine rather
      // than making the user wait for a minute inside a single tool call.
      if (retryDelay > MAX_RATE_LIMIT_RETRY_DELAY_MS) throw error
      providerNextAllowedAt.set(
        provider,
        Math.max(
          providerNextAllowedAt.get(provider) ?? 0,
          Date.now() + retryDelay,
        ),
      )
    }
  }
  throw new Error(
    `${SEARCH_PROVIDER_LABELS[provider]} no pudo completar la solicitud.`,
  )
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized || undefined
}

function safeUrl(value: unknown): string | undefined {
  const url = cleanText(value)
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

function limitSnippet(
  value: string | undefined,
  maxCharacters: number,
): string | undefined {
  if (!value) return undefined
  if (value.length <= maxCharacters) return value
  return `${value.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`
}

function payloadErrorMessage(value: unknown): string | undefined {
  const direct = cleanText(value)
  if (direct) return direct
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  return (
    cleanText(record.detail) ??
    cleanText(record.message) ??
    cleanText(record.error) ??
    cleanText(record.description)
  )
}

function deduplicateSearchResults(
  results: SearchResultItem[],
  limit: number,
): SearchResultItem[] {
  const normalized: SearchResultItem[] = []
  const seen = new Set<string>()
  for (const result of results) {
    const url = safeUrl(result.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    normalized.push({
      title: cleanText(result.title) ?? url,
      url,
      snippet: limitSnippet(cleanText(result.snippet), 4_000),
      publishedDate: cleanText(result.publishedDate),
      author: cleanText(result.author),
    })
    if (normalized.length >= limit) break
  }
  return normalized
}

function formatSearchResults(
  provider: SearchProviderId,
  query: string,
  results: SearchResultItem[],
): string {
  const lines = [
    `Motor: ${SEARCH_PROVIDER_LABELS[provider]}`,
    `Consulta: ${query}`,
    '',
  ]
  results.forEach((result, index) => {
    lines.push(`${index + 1}. [${result.title}](${result.url})`)
    const metadata = [result.publishedDate, result.author]
      .filter(Boolean)
      .join(' · ')
    if (metadata) lines.push(`   ${metadata}`)
    if (result.snippet) lines.push(`   ${result.snippet}`)
    lines.push('')
  })
  return lines.join('\n').trim()
}

async function searchTavily(
  request: NormalizedWebSearchRequest,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; results: SearchResultItem[] }> {
  const endpoint = 'https://api.tavily.com/search'
  const payload = (await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: request.query,
        search_depth: request.type === 'deep' ? 'advanced' : 'basic',
        max_results: Math.min(request.numResults, 20),
        topic: 'general',
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        safe_search: true,
      }),
    },
    'tavily',
    signal,
    fetchImpl,
  )) as TavilySearchResponse

  const results: SearchResultItem[] = []
  for (const item of payload.results ?? []) {
    const url = safeUrl(item.url)
    if (!url) continue
    results.push({
      title: cleanText(item.title) ?? url,
      url,
      snippet: limitSnippet(cleanText(item.content), 1_800),
      publishedDate: cleanText(item.published_date),
    })
  }
  return { endpoint, results }
}

async function searchExa(
  request: NormalizedWebSearchRequest,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; results: SearchResultItem[] }> {
  const endpoint = 'https://api.exa.ai/search'
  const payload = (await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query: request.query,
        numResults: request.numResults,
        type: request.type,
        moderation: true,
        contents: { highlights: true },
      }),
    },
    'exa',
    signal,
    fetchImpl,
  )) as ExaSearchResponse

  const maxSnippet = Math.min(
    4_000,
    Math.max(
      500,
      Math.floor((request.contextMaxCharacters ?? 15_000) / request.numResults),
    ),
  )
  const results: SearchResultItem[] = []
  for (const item of payload.results ?? []) {
    const url = safeUrl(item.url)
    if (!url) continue
    const highlights = Array.isArray(item.highlights)
      ? item.highlights
          .map(cleanText)
          .filter((entry): entry is string => Boolean(entry))
          .join(' ')
      : undefined
    results.push({
      title: cleanText(item.title) ?? url,
      url,
      snippet: limitSnippet(
        cleanText(item.summary) ?? highlights ?? cleanText(item.text),
        maxSnippet,
      ),
      publishedDate: cleanText(item.publishedDate),
      author: cleanText(item.author),
    })
  }
  return { endpoint, results }
}

async function searchLinkup(
  request: NormalizedWebSearchRequest,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; results: SearchResultItem[] }> {
  const endpoint = 'https://api.linkup.so/v1/search'
  const payload = (await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        q: request.query,
        depth:
          request.type === 'deep'
            ? 'deep'
            : request.type === 'fast'
              ? 'fast'
              : 'standard',
        outputType: 'searchResults',
        includeImages: false,
        maxResults: request.numResults,
      }),
    },
    'linkup',
    signal,
    fetchImpl,
  )) as LinkupSearchResponse

  const results: SearchResultItem[] = []
  for (const item of payload.results ?? []) {
    if (cleanText(item.type)?.toLowerCase() === 'image') continue
    const url = safeUrl(item.url)
    if (!url) continue
    results.push({
      title: cleanText(item.name) ?? cleanText(item.title) ?? url,
      url,
      snippet: limitSnippet(cleanText(item.content), 2_500),
      publishedDate: cleanText(item.date),
    })
  }
  return { endpoint, results }
}

async function searchFirecrawl(
  request: NormalizedWebSearchRequest,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; results: SearchResultItem[] }> {
  const endpoint = 'https://api.firecrawl.dev/v2/search'
  const payload = (await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: request.query,
        limit: Math.min(request.numResults, 100),
        sources: ['web'],
        timeout: DEFAULT_SEARCH_TIMEOUT_MS,
        ignoreInvalidURLs: true,
      }),
    },
    'firecrawl',
    signal,
    fetchImpl,
  )) as FirecrawlSearchResponse

  if (payload.success === false) {
    throw new Error(
      payloadErrorMessage(payload.error) ??
        'Firecrawl devolvió una respuesta de error.',
    )
  }
  const results: SearchResultItem[] = []
  for (const item of payload.data?.web ?? []) {
    const url =
      safeUrl(item.url) ??
      safeUrl(item.metadata?.sourceURL) ??
      safeUrl(item.metadata?.url)
    if (!url) continue
    results.push({
      title: cleanText(item.title) ?? cleanText(item.metadata?.title) ?? url,
      url,
      snippet: limitSnippet(
        cleanText(item.description) ??
          cleanText(item.metadata?.description) ??
          cleanText(item.markdown),
        2_500,
      ),
      publishedDate: cleanText(item.metadata?.publishedTime),
      author: cleanText(item.metadata?.author),
    })
  }
  return { endpoint, results }
}

async function searchSerpApi(
  request: NormalizedWebSearchRequest,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; results: SearchResultItem[] }> {
  const endpointUrl = new URL('https://serpapi.com/search.json')
  endpointUrl.searchParams.set('engine', 'google')
  endpointUrl.searchParams.set('q', request.query)
  endpointUrl.searchParams.set('api_key', apiKey)
  endpointUrl.searchParams.set('num', String(Math.min(request.numResults, 100)))
  endpointUrl.searchParams.set('safe', 'active')
  const endpoint = endpointUrl.origin + endpointUrl.pathname
  const payload = (await fetchJson(
    endpointUrl.toString(),
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'luna-ai-web-search/1.0.0',
      },
    },
    'serpapi',
    signal,
    fetchImpl,
  )) as SerpApiSearchResponse

  const error = payloadErrorMessage(payload.error)
  if (error) throw new Error(`SerpApi respondió con error: ${error}`)
  const results: SearchResultItem[] = []
  for (const item of payload.organic_results ?? []) {
    const url = safeUrl(item.link)
    if (!url) continue
    results.push({
      title: cleanText(item.title) ?? url,
      url,
      snippet: limitSnippet(cleanText(item.snippet), 1_800),
      publishedDate: cleanText(item.date),
      author: cleanText(item.source),
    })
  }
  return { endpoint, results }
}

async function searchZenserp(
  request: NormalizedWebSearchRequest,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; results: SearchResultItem[] }> {
  const endpointUrl = new URL('https://app.zenserp.com/api/v2/search')
  endpointUrl.searchParams.set('q', request.query)
  endpointUrl.searchParams.set('engine', 'google')
  endpointUrl.searchParams.set('num', String(Math.min(request.numResults, 100)))
  const endpoint = endpointUrl.origin + endpointUrl.pathname
  const payload = (await fetchJson(
    endpointUrl.toString(),
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        apikey: apiKey,
        'user-agent': 'luna-ai-web-search/1.0.0',
      },
    },
    'zenserp',
    signal,
    fetchImpl,
  )) as ZenserpSearchResponse

  const error =
    payloadErrorMessage(payload.error) ?? payloadErrorMessage(payload.message)
  if (error) throw new Error(`Zenserp respondió con error: ${error}`)
  const results: SearchResultItem[] = []
  for (const item of payload.organic ?? []) {
    const url =
      safeUrl(item.url) ?? safeUrl(item.link) ?? safeUrl(item.destination)
    if (!url) continue
    results.push({
      title: cleanText(item.title) ?? url,
      url,
      snippet: limitSnippet(cleanText(item.description), 1_800),
      publishedDate: cleanText(item.date),
      author: cleanText(item.source),
    })
  }
  return { endpoint, results }
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(cleanText).filter((entry): entry is string => Boolean(entry))
}

function bravePublishedDate(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const dates = cleanStringArray(value)
    return dates.find((entry) => /^\d{4}-\d{2}-\d{2}/.test(entry)) ?? dates[0]
  }
  return cleanText(value)
}

function parseBraveContextResults(
  payload: BraveLlmContextResponse,
): SearchResultItem[] {
  const items: BraveContextItem[] = [
    ...(payload.grounding?.generic ?? []),
    ...(payload.grounding?.map ?? []),
    ...(payload.grounding?.poi ? [payload.grounding.poi] : []),
  ]
  const results: SearchResultItem[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const url = safeUrl(item.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const source =
      payload.sources?.[url] ?? payload.sources?.[String(item.url ?? '')]
    const snippets = cleanStringArray(item.snippets).join(' ')
    results.push({
      title:
        cleanText(item.title) ??
        cleanText(item.name) ??
        cleanText(source?.title) ??
        url,
      url,
      snippet: limitSnippet(snippets || undefined, 4_000),
      publishedDate: bravePublishedDate(source?.age),
    })
  }
  return results
}

async function searchBraveLlmContext(
  request: NormalizedWebSearchRequest,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; results: SearchResultItem[] }> {
  const endpointUrl = new URL('https://api.search.brave.com/res/v1/llm/context')
  endpointUrl.searchParams.set('q', request.query)
  endpointUrl.searchParams.set(
    'count',
    String(Math.min(Math.max(request.numResults * 2, 8), 50)),
  )
  endpointUrl.searchParams.set(
    'maximum_number_of_urls',
    String(Math.min(request.numResults, 50)),
  )
  endpointUrl.searchParams.set(
    'maximum_number_of_tokens',
    String(
      Math.min(
        32_768,
        Math.max(
          1_024,
          Math.ceil((request.contextMaxCharacters ?? 15_000) / 4),
        ),
      ),
    ),
  )
  endpointUrl.searchParams.set(
    'maximum_number_of_snippets',
    String(Math.min(100, Math.max(10, request.numResults * 4))),
  )
  endpointUrl.searchParams.set(
    'context_threshold_mode',
    request.type === 'deep' ? 'balanced' : 'lenient',
  )
  endpointUrl.searchParams.set('enable_source_metadata', 'true')
  const endpoint = endpointUrl.origin + endpointUrl.pathname
  const payload = (await fetchJson(
    endpointUrl.toString(),
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'user-agent': 'luna-ai-web-search/1.0.0',
        'x-subscription-token': apiKey,
      },
    },
    'brave',
    signal,
    fetchImpl,
  )) as BraveLlmContextResponse
  return {
    endpoint,
    results: parseBraveContextResults(payload).slice(0, request.numResults),
  }
}

async function searchBraveWeb(
  request: NormalizedWebSearchRequest,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; results: SearchResultItem[] }> {
  const endpointUrl = new URL('https://api.search.brave.com/res/v1/web/search')
  endpointUrl.searchParams.set('q', request.query)
  endpointUrl.searchParams.set(
    'count',
    String(Math.min(request.numResults, 20)),
  )
  endpointUrl.searchParams.set('safesearch', 'moderate')
  endpointUrl.searchParams.set('text_decorations', 'false')
  endpointUrl.searchParams.set('extra_snippets', 'true')
  endpointUrl.searchParams.set('result_filter', 'web')
  const endpoint = endpointUrl.origin + endpointUrl.pathname
  const payload = (await fetchJson(
    endpointUrl.toString(),
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'user-agent': 'luna-ai-web-search/1.0.0',
        'x-subscription-token': apiKey,
      },
    },
    'brave',
    signal,
    fetchImpl,
  )) as BraveWebSearchResponse

  const results: SearchResultItem[] = []
  for (const item of payload.web?.results ?? []) {
    const url = safeUrl(item.url)
    if (!url) continue
    const extras = cleanStringArray(item.extra_snippets).join(' ')
    results.push({
      title: cleanText(item.title) ?? url,
      url,
      snippet: limitSnippet(
        [cleanText(item.description), extras].filter(Boolean).join(' '),
        1_800,
      ),
      publishedDate: cleanText(item.page_age) ?? cleanText(item.age),
    })
  }
  return { endpoint, results }
}

async function searchBrave(
  request: NormalizedWebSearchRequest,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; results: SearchResultItem[] }> {
  // Web Search is the primary route because it returns stable URL results in a
  // single request and works with the Brave Free plan. LLM Context is only a
  // secondary route when Web Search succeeds but yields no usable URLs.
  let webFailure: string | undefined
  try {
    const web = await searchBraveWeb(request, apiKey, signal, fetchImpl)
    if (web.results.length > 0) return web
    webFailure = 'Web Search no devolvió resultados utilizables.'
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.message === 'Operación cancelada')
    )
      throw error
    if (
      error instanceof SearchHttpError &&
      [401, 403, 422, 429].includes(error.status)
    )
      throw error
    webFailure = error instanceof Error ? error.message : String(error)
  }

  try {
    const context = await searchBraveLlmContext(
      request,
      apiKey,
      signal,
      fetchImpl,
    )
    if (context.results.length > 0) return context
    throw new Error('LLM Context no devolvió resultados utilizables.')
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.message === 'Operación cancelada')
    )
      throw error
    const contextFailure =
      error instanceof Error ? error.message : String(error)
    throw new Error(
      `Brave falló en Web Search y LLM Context. Web Search: ${webFailure} LLM Context: ${contextFailure}`,
    )
  }
}

async function runProviderSearch(
  provider: SearchProviderId,
  request: NormalizedWebSearchRequest,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; results: SearchResultItem[] }> {
  let response: { endpoint: string; results: SearchResultItem[] }
  switch (provider) {
    case 'tavily':
      response = await searchTavily(request, apiKey, signal, fetchImpl)
      break
    case 'brave':
      response = await searchBrave(request, apiKey, signal, fetchImpl)
      break
    case 'exa':
      response = await searchExa(request, apiKey, signal, fetchImpl)
      break
    case 'linkup':
      response = await searchLinkup(request, apiKey, signal, fetchImpl)
      break
    case 'firecrawl':
      response = await searchFirecrawl(request, apiKey, signal, fetchImpl)
      break
    case 'serpapi':
      response = await searchSerpApi(request, apiKey, signal, fetchImpl)
      break
    case 'zenserp':
      response = await searchZenserp(request, apiKey, signal, fetchImpl)
      break
  }
  return {
    ...response,
    results: deduplicateSearchResults(response.results, request.numResults),
  }
}

export interface WebSearchRuntimeConfig {
  settings: WebSearchSettings
  auth: WebSearchAuth
}

export async function runWebSearchWithFallback(
  input: WebSearchRequest,
  config?: WebSearchRuntimeConfig,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<WebSearchRuntimeResult> {
  const request = normalizeWebSearchRequest(input)
  const attempts: SearchAttempt[] = []
  const settings = config?.settings ?? loadWebSearchSettings()
  const auth = config?.auth ?? loadWebSearchAuth()
  const order = getSearchProviderOrder(settings, auth)
  debugInfo("api-search.runtime", "started", {
    query: request.query,
    type: request.type,
    numResults: request.numResults,
    livecrawl: request.livecrawl,
    providerOrder: order,
  })
  if (order.length === 0) {
    throw new Error(
      'web_search no está disponible: no hay motores habilitados con una API key. Configúralos desde /setup-search.',
    )
  }

  for (const provider of order) {
    const state = resolveSearchProviderState(provider, settings, auth)
    if (!state.apiKey || !state.enabled) {
      debugLog("api-search.runtime", "provider_skipped", {
        provider,
        enabled: state.enabled,
        hasApiKey: Boolean(state.apiKey),
      })
      continue
    }
    try {
      debugLog("api-search.runtime", "provider_attempt", { provider, query: request.query })
      const response = await runProviderSearch(
        provider,
        request,
        state.apiKey,
        signal,
        fetchImpl,
      )
      if (response.results.length === 0) {
        throw new Error(
          `${SEARCH_PROVIDER_LABELS[provider]} no devolvió resultados utilizables.`,
        )
      }
      attempts.push({
        provider,
        status: 'success',
        message: `${response.results.length} resultado(s).`,
      })
      debugInfo("api-search.runtime", "provider_success", {
        provider,
        query: request.query,
        resultCount: response.results.length,
        endpoint: response.endpoint,
      })
      return {
        provider,
        endpoint: response.endpoint,
        request,
        resultCount: response.results.length,
        text: formatSearchResults(provider, request.query, response.results),
        results: response.results,
        attempts,
      }
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof Error && error.message === 'Operación cancelada')
      )
        throw error
      attempts.push({
        provider,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
      debugWarn("api-search.runtime", "provider_failed_fallback", {
        provider,
        query: request.query,
        message: error instanceof Error ? error.message : String(error),
        nextProvider: order[order.indexOf(provider) + 1],
      })
    }
  }

  const summary = attempts
    .map(
      (attempt) =>
        `${SEARCH_PROVIDER_LABELS[attempt.provider]}: ${attempt.message ?? attempt.status}`,
    )
    .join(' | ')
  const suffix = summary
    ? ` ${summary}`
    : ' Usa /setup-search para configurar al menos un motor de búsqueda.'
  const finalError = new Error(
    `No fue posible completar la búsqueda con ningún motor configurado.${suffix}`,
  )
  debugError("api-search.runtime", "all_providers_failed", finalError, {
    query: request.query,
    attempts,
  })
  throw finalError
}

export async function testSearchProvider(
  provider: SearchProviderId,
  config?: WebSearchRuntimeConfig,
  query = 'documentación oficial TypeScript',
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; message: string }> {
  const settings = config?.settings ?? loadWebSearchSettings()
  const auth = config?.auth ?? loadWebSearchAuth()
  const state = resolveSearchProviderState(provider, settings, auth)
  if (!state.apiKey)
    return { ok: false, message: 'No hay API key configurada.' }
  if (!state.enabled)
    return { ok: false, message: 'El motor está deshabilitado.' }
  const apiKey = state.apiKey
  try {
    const request = normalizeWebSearchRequest({
      query,
      numResults: 1,
      type: 'fast',
    })
    const response = await runProviderSearch(
      provider,
      request,
      apiKey,
      signal,
      fetchImpl,
    )
    if (response.results.length === 0)
      return {
        ok: false,
        message: 'La API respondió, pero no devolvió resultados.',
      }
    return {
      ok: true,
      message: `Conexión correcta; ${response.results.length} resultado(s).`,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
