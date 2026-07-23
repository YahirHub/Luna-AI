import type { LlmConfig, ProviderEndpointCandidate } from "./llm-config.ts";
import { debugError, debugWarn } from "./debug.ts";

/** Mensaje en formato OpenAI. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  /** Solo para mensajes assistant con tool_calls. */
  tool_calls?: ToolCall[];
}

// ─── Tool calling types ─────────────────────────────────────────

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// ─── Internal raw request helper ────────────────────────────────

export type LlmUsageSource = "provider" | "estimated" | "mixed";

export interface LlmUsageEvent {
  jid: string;
  model: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: LlmUsageSource;
  providerPromptTokens?: number;
  providerCompletionTokens?: number;
  providerTotalTokens?: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  timestamp: string;
}

export interface LlmUsageContext {
  jid?: string;
  purpose?: string;
}

type LlmUsageObserver = (event: LlmUsageEvent) => void | Promise<void>;
let llmUsageObserver: LlmUsageObserver | null = null;

export function setLlmUsageObserver(observer: LlmUsageObserver | null): void {
  llmUsageObserver = observer;
}

function positiveUsageNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed);
}

function estimateRawPromptTokens(messages: ChatMessage[], tools?: ToolDefinition[]): number {
  let total = estimateTokensAccurate(messages);
  if (tools && tools.length > 0) total += estimateTextTokens(JSON.stringify(tools)) + tools.length * 60;
  return Math.max(1, total);
}

function estimateRawCompletionTokens(content: string | null, toolCalls?: ToolCall[]): number {
  let total = estimateTextTokens(content ?? "");
  for (const call of toolCalls ?? []) {
    total += 40 + estimateTextTokens(call.function.name) + estimateTextTokens(call.function.arguments);
  }
  return Math.max(1, total);
}

function emitLlmUsage(event: LlmUsageEvent): void {
  if (!llmUsageObserver) return;
  try {
    const result = llmUsageObserver(event);
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch((error) => debugWarn("ai.usage", "observer_failed", { error: error instanceof Error ? error.message : String(error) }));
    }
  } catch (error) {
    debugWarn("ai.usage", "observer_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

// DeepSeek V4 puede devolver tool calls DSML dentro de message.content en lugar
// de usar el campo OpenAI tool_calls. Normalizamos las variantes oficiales
// <｜DSML｜...>, la variante observada <｜｜DSML｜｜...> y <||DSML||...>.
function normalizeDsmlMarkup(value: string): string {
  return value.replace(
    /<(\/?)[\s]*(?:(?:\|){1,2}|(?:｜){1,2})[\s]*DSML[\s]*(?:(?:\|){1,2}|(?:｜){1,2})[\s]*([a-z_]+)/giu,
    "<$1DSML_$2",
  );
}

function decodeDsmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '\"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseDsmlParameterValue(rawValue: string, stringMode: boolean): unknown {
  const decoded = decodeDsmlText(rawValue).trim();
  if (stringMode) return decoded;
  if (!decoded) return null;
  try {
    return JSON.parse(decoded);
  } catch {
    // Una respuesta DSML defectuosa no debe tumbar todo el turno. Conservamos
    // el valor para que el ejecutor/schema pueda devolver un error útil al modelo.
    return decoded;
  }
}

interface TextualToolCallRecovery {
  content: string;
  toolCalls: ToolCall[];
  rejectedToolNames: string[];
  detected: boolean;
}

/**
 * Recupera tool calls DSML serializados como texto por algunos providers/modelos.
 * Solo transforma nombres presentes en `tools`; escribir DSML nunca eleva permisos.
 */
function recoverTextualDsmlToolCalls(
  content: string,
  tools: ToolDefinition[] | undefined,
): TextualToolCallRecovery {
  const normalized = normalizeDsmlMarkup(content);
  const allowed = new Set((tools ?? []).map((tool) => tool.function.name));
  const toolCalls: ToolCall[] = [];
  const rejectedToolNames: string[] = [];
  let detected = false;
  let ordinal = 0;

  const stripped = normalized.replace(
    /<DSML_tool_calls\b[^>]*>([\s\S]*?)<\/DSML_tool_calls>/giu,
    (_block, inner: string) => {
      detected = true;
      const invokeRegex = /<DSML_invoke\b([^>]*)>([\s\S]*?)<\/DSML_invoke>/giu;
      let invokeMatch: RegExpExecArray | null;
      while ((invokeMatch = invokeRegex.exec(inner)) !== null) {
        const attrs = invokeMatch[1] ?? "";
        const body = invokeMatch[2] ?? "";
        const name = /\bname\s*=\s*["']([^"']+)["']/iu.exec(attrs)?.[1]?.trim() ?? "";
        if (!name) continue;
        if (!allowed.has(name)) {
          rejectedToolNames.push(name);
          continue;
        }

        const args: Record<string, unknown> = {};
        const paramRegex = /<DSML_parameter\b([^>]*)>([\s\S]*?)<\/DSML_parameter>/giu;
        let paramMatch: RegExpExecArray | null;
        while ((paramMatch = paramRegex.exec(body)) !== null) {
          const paramAttrs = paramMatch[1] ?? "";
          const paramName = /\bname\s*=\s*["']([^"']+)["']/iu.exec(paramAttrs)?.[1]?.trim() ?? "";
          if (!paramName) continue;
          const stringAttr = /\bstring\s*=\s*["'](true|false)["']/iu.exec(paramAttrs)?.[1]?.toLowerCase();
          args[paramName] = parseDsmlParameterValue(paramMatch[2] ?? "", stringAttr !== "false");
        }

        ordinal += 1;
        toolCalls.push({
          id: `call_dsml_${Date.now()}_${ordinal}`,
          type: "function",
          function: {
            name,
            arguments: JSON.stringify(args),
          },
        });
      }
      return "";
    },
  );

  // Si el provider dejó tokens de fin propios después del bloque, tampoco deben
  // filtrarse al usuario. No tocamos texto normal fuera del protocolo.
  const cleaned = stripped
    .replace(/<(?:(?:\|){1,2}|(?:｜){1,2})end[^>]*>/giu, "")
    .trim();

  return { content: cleaned, toolCalls, rejectedToolNames, detected };
}


class HttpStatusError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, message: string, responseBody = "") {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class LlmRetriesExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: Error;

  constructor(attempts: number, lastError: Error) {
    super(`El proveedor LLM no respondió correctamente después de ${attempts} intento(s): ${lastError.message}`);
    this.name = "LlmRetriesExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.cause = lastError;
  }
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function effectiveRetryAttempts(requested: number): number {
  return intEnv("LUNA_LLM_RETRY_ATTEMPTS", requested, 1, 8);
}

function retryBaseDelayMs(): number {
  return intEnv("LUNA_LLM_RETRY_BASE_MS", 1_500, 10, 30_000);
}

function transientHttp400(error: HttpStatusError): boolean {
  const text = `${error.message} ${error.responseBody}`.toLowerCase();
  return /upstream request failed|upstream.*(?:timeout|unavailable|overload)|provider.*(?:unavailable|failed|timeout)|temporar(?:y|ily)|try again|console.*upstream|connection reset|connection closed|gateway|service unavailable|internal server error/.test(text);
}


async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  } else {
    externalSignal?.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

function shouldRetry(error: Error): boolean {
  if (error instanceof HttpStatusError) {
    return error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500 || (error.status === 400 && transientHttp400(error));
  }
  // Errores de red, AbortError por timeout interno, JSON incompleto, choices
  // vacíos y conexiones cerradas son recuperables mientras la señal externa
  // de la tarea no haya sido cancelada.
  return true;
}

interface RawRequestOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "required" | {
    type: "function";
    function: { name: string };
  };
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
  usage?: LlmUsageContext;
}

/**
 * Ejecuta una solicitud raw a /chat/completions con reintentos.
 */
async function rawChatRequest(
  body: RawRequestOptions,
  config: LlmConfig,
  maxRetries = 3,
): Promise<{
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason?: string | null;
}> {
  const url = config.chatCompletionsUrl;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const requestBody: Record<string, unknown> = {
    model: body.model,
    messages: body.messages,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 2048,
    stream: false,
  };

  if (body.tools && body.tools.length > 0) {
    requestBody.tools = body.tools;
    requestBody.tool_choice = body.tool_choice ?? "auto";
  }

  // Normalizar mensajes: assistant con tool_calls debe tener content=null
  const normalizedMessages = body.messages.map((msg) => {
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      return { ...msg, content: null };
    }
    return msg;
  });
  requestBody.messages = normalizedMessages;

  const bodyStr = JSON.stringify(requestBody);

  let lastError: Error | null = null;
  const attempts = effectiveRetryAttempts(maxRetries);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchWithTimeout(
        url,
        { method: "POST", headers, body: bodyStr },
        config.requestTimeoutMs,
        body.signal,
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new HttpStatusError(
          response.status,
          `Error (${response.status}): ${text.slice(0, 300)}`,
          text,
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{
          finish_reason?: string | null;
          message?: {
            content?: string | null;
            tool_calls?: ToolCall[];
          };
        }>;
        usage?: {
          prompt_tokens?: number | string;
          completion_tokens?: number | string;
          total_tokens?: number | string;
          input_tokens?: number | string;
          output_tokens?: number | string;
        };
      };

      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error("La API no devolvió choices en la respuesta");
      }

      const providerContent = choice.message?.content ?? null;
      let toolCalls = choice.message?.tool_calls;
      let content = providerContent;

      if (providerContent?.trim()) {
        const recovered = recoverTextualDsmlToolCalls(providerContent, body.tools);
        if (recovered.detected) {
          // Siempre retiramos el protocolo textual del content. Si el provider ya
          // entregó tool_calls estructurados, esos tienen prioridad para evitar
          // ejecutar dos veces la misma mutación.
          content = recovered.content || null;
          if ((!toolCalls || toolCalls.length === 0) && recovered.toolCalls.length > 0) {
            toolCalls = recovered.toolCalls;
          }
          debugWarn("ai.tools", "textual_dsml_detected", {
            recovered: recovered.toolCalls.map((call) => call.function.name),
            rejected: recovered.rejectedToolNames,
            structuredToolCalls: choice.message?.tool_calls?.length ?? 0,
            residualChars: recovered.content.length,
            model: body.model,
          });
        }
      }

      if ((!toolCalls || toolCalls.length === 0) && !content?.trim()) {
        throw new Error("La API devolvió una respuesta vacía sin tool calls");
      }

      const usageContext = body.usage;
      if (usageContext?.jid) {
        const estimatedPromptTokens = estimateRawPromptTokens(body.messages, body.tools);
        const estimatedCompletionTokens = estimateRawCompletionTokens(content, toolCalls);
        const providerPromptTokens = positiveUsageNumber(data.usage?.prompt_tokens ?? data.usage?.input_tokens);
        const providerCompletionTokens = positiveUsageNumber(data.usage?.completion_tokens ?? data.usage?.output_tokens);
        const providerTotalTokens = positiveUsageNumber(data.usage?.total_tokens);
        const hasPrompt = providerPromptTokens !== undefined;
        const hasCompletion = providerCompletionTokens !== undefined;
        const promptTokens = providerPromptTokens ?? estimatedPromptTokens;
        const completionTokens = providerCompletionTokens ?? estimatedCompletionTokens;
        const totalTokens = providerTotalTokens ?? (promptTokens + completionTokens);
        const source: LlmUsageSource = hasPrompt && hasCompletion
          ? "provider"
          : hasPrompt || hasCompletion || providerTotalTokens !== undefined
            ? "mixed"
            : "estimated";
        emitLlmUsage({
          jid: usageContext.jid,
          model: body.model,
          purpose: usageContext.purpose ?? "chat",
          promptTokens,
          completionTokens,
          totalTokens,
          source,
          providerPromptTokens,
          providerCompletionTokens,
          providerTotalTokens,
          estimatedPromptTokens,
          estimatedCompletionTokens,
          timestamp: new Date().toISOString(),
        });
      }

      return {
        content,
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: choice.finish_reason ?? null,
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (body.signal?.aborted) {
        throw lastError;
      }
      const retryable = shouldRetry(lastError);
      if (attempt < attempts && retryable) {
        const backoff = Math.min(retryBaseDelayMs() * Math.pow(2, attempt - 1), 30_000);
        debugWarn("ai.retry", "will_retry", {
          attempt,
          attempts,
          backoffMs: backoff,
          status: lastError instanceof HttpStatusError ? lastError.status : undefined,
          error: lastError.message,
          model: body.model,
        });
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            body.signal?.removeEventListener("abort", onAbort);
            reject(body.signal?.reason ?? new Error("llm-task-cancelled"));
          };
          const timer = setTimeout(() => {
            body.signal?.removeEventListener("abort", onAbort);
            resolve();
          }, backoff);
          body.signal?.addEventListener("abort", onAbort, { once: true });
        });
      } else {
        debugError("ai.retry", "exhausted", lastError, {
          attempt,
          attempts,
          retryable,
          status: lastError instanceof HttpStatusError ? lastError.status : undefined,
          model: body.model,
        });
        break;
      }
    }
  }

  const finalError = lastError ?? new Error("Error desconocido en chat completion");
  throw new LlmRetriesExhaustedError(attempts, finalError);
}

/**
 * Solicita argumentos para una herramienta concreta. Se usa como red de
 * seguridad cuando una intención transaccional explícita no produjo el tool
 * call obligatorio en la ronda normal.
 */
export async function requestForcedToolArguments(
  messages: ChatMessage[],
  model: string,
  config: LlmConfig,
  tool: ToolDefinition,
  instruction: string,
  signal?: AbortSignal,
  usage?: LlmUsageContext,
): Promise<Record<string, unknown>> {
  const forcedMessages: ChatMessage[] = [
    ...messages,
    { role: "user", content: instruction },
  ];
  const choices: RawRequestOptions["tool_choice"][] = [
    { type: "function", function: { name: tool.function.name } },
    "required",
    "auto",
  ];
  let lastError: Error | null = null;

  for (const toolChoice of choices) {
    try {
      const result = await rawChatRequest({
        model,
        messages: forcedMessages,
        tools: [tool],
        tool_choice: toolChoice,
        max_tokens: 1_500,
        signal,
        usage,
      }, config, 1);
      const call = result.tool_calls?.find((candidate) => candidate.function.name === tool.function.name);
      if (!call) throw new Error(`El proveedor no devolvió la llamada obligatoria ${tool.function.name}.`);
      const parsed = JSON.parse(call.function.arguments) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Los argumentos de ${tool.function.name} no son un objeto válido.`);
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error(`No se pudieron generar argumentos para ${tool.function.name}.`);
}

/**
 * Envía una solicitud de chat completion (no streaming) a la API.
 * Compatible hacia atrás — solo retorna el contenido de texto.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  model: string,
  config: LlmConfig,
  maxRetries = 3,
  maxTokens?: number,
  usage?: LlmUsageContext,
  signal?: AbortSignal,
): Promise<string> {
  const result = await rawChatRequest(
    { model, messages, max_tokens: maxTokens, usage, signal },
    config,
    maxRetries,
  );
  return result.content ?? "";
}

/**
 * Chat completion con soporte de function calling (tools).
 * Si el modelo llama a herramientas, las ejecuta vía executeTool y
 * continúa en loop hasta que el modelo responda sin tool_calls.
 */
export interface ToolChatRuntimeOptions {
  maxRounds?: number;
  /** Presupuesto de salida por respuesta. Útil para subagentes con informes extensos. */
  maxTokens?: number;
  /** Veces que se intenta rehacer de forma compacta una respuesta cortada por finish_reason=length. */
  truncationRecoveryAttempts?: number;
  signal?: AbortSignal;
  onToolRoundComplete?: (toolNames: string[], round: number) => void | Promise<void>;
  /**
   * Herramientas que completan por sí solas la tarea actual. Después de una
   * ejecución exitosa se solicita el cierre final sin exponer más tools.
   */
  terminalTools?: string[];
  /** Asocia las métricas del provider/estimador con un usuario y propósito. */
  usage?: LlmUsageContext;
}


function buildToolContinuationRecoveryMessages(
  originalMessages: ChatMessage[],
  latestToolResult: string,
  toolsCalled: string[],
): ChatMessage[] {
  const systemMessages = originalMessages.filter((message) => message.role === "system");
  const lastUser = [...originalMessages].reverse().find((message) => message.role === "user");
  const compactResult = latestToolResult.length > 24_000
    ? `${latestToolResult.slice(0, 18_000)}\n\n[...contenido intermedio omitido durante recuperación...]\n\n${latestToolResult.slice(-6_000)}`
    : latestToolResult;
  return [
    ...systemMessages,
    ...(lastUser ? [lastUser] : []),
    {
      role: "user",
      content: [
        "Una herramienta ejecutada en esta misma tarea terminó correctamente, pero el proveedor LLM falló al continuar después de recibir su resultado.",
        `Herramientas ya ejecutadas: ${toolsCalled.join(", ") || "ninguna"}.`,
        "Usa el resultado recuperado de abajo como evidencia ya obtenida. Continúa la tarea desde este punto y NO repitas la herramienta completada salvo que sea estrictamente necesario.",
        "Resultado recuperado:",
        compactResult,
      ].join("\n\n"),
    },
  ];
}

async function recoverTruncatedFinalResponse(
  partialContent: string,
  currentMessages: ChatMessage[],
  model: string,
  config: LlmConfig,
  maxRetries: number,
  runtimeOptions: ToolChatRuntimeOptions,
): Promise<string | null> {
  const attempts = Math.min(3, Math.max(1, runtimeOptions.truncationRecoveryAttempts ?? 1));
  let messages = [
    ...currentMessages,
    { role: "assistant" as const, content: partialContent },
    {
      role: "user" as const,
      content: [
        "Tu respuesta final anterior fue truncada por el límite de salida.",
        "Reescribe DESDE CERO una versión completa y más compacta de la respuesta final.",
        "Conserva todos los datos esenciales solicitados, fuentes y advertencias importantes, pero elimina explicación redundante.",
        "No llames herramientas. No continúes desde la última frase: entrega una respuesta autocontenida que no termine a mitad de una tabla o frase.",
      ].join(" "),
    },
  ];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const recovered = await rawChatRequest({
      model,
      messages,
      max_tokens: runtimeOptions.maxTokens,
      signal: runtimeOptions.signal,
      usage: runtimeOptions.usage,
    }, config, maxRetries);
    const content = recovered.content?.trim() ?? "";
    if (!content) return null;
    if (recovered.finish_reason !== "length") return content;
    messages = [
      ...messages,
      { role: "assistant", content },
      {
        role: "user",
        content: "La versión compacta volvió a quedar truncada. Reduce todavía más la longitud y entrega únicamente los hallazgos necesarios para cumplir la solicitud, con una respuesta completa.",
      },
    ];
  }
  return null;
}

export async function chatCompletionWithTools(
  messages: ChatMessage[],
  model: string,
  config: LlmConfig,
  tools: ToolDefinition[],
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  maxRetries = 3,
  onToolCall?: (name: string) => void,
  runtimeOptions: ToolChatRuntimeOptions = {},
): Promise<{ content: string; toolsCalled: string[] }> {
  let currentMessages = [...messages];
  const toolsCalled: string[] = [];
  const maxRounds = Math.min(200, Math.max(1, runtimeOptions.maxRounds ?? 16));
  let latestToolResult = "";

  for (let round = 0; round < maxRounds; round++) {
    let result: Awaited<ReturnType<typeof rawChatRequest>>;
    try {
      result = await rawChatRequest(
        {
          model,
          messages: currentMessages,
          tools,
          max_tokens: runtimeOptions.maxTokens,
          signal: runtimeOptions.signal,
          usage: runtimeOptions.usage,
        },
        config,
        maxRetries,
      );
    } catch (error) {
      if (
        error instanceof LlmRetriesExhaustedError &&
        latestToolResult &&
        toolsCalled.length > 0 &&
        !runtimeOptions.signal?.aborted
      ) {
        debugWarn("ai.retry", "continuation_recovery", {
          toolsCalled,
          latestToolResultChars: latestToolResult.length,
          model,
        });
        currentMessages = buildToolContinuationRecoveryMessages(messages, latestToolResult, toolsCalled);
        result = await rawChatRequest(
          {
            model,
            messages: currentMessages,
            tools,
            max_tokens: runtimeOptions.maxTokens,
            signal: runtimeOptions.signal,
            usage: runtimeOptions.usage,
          },
          config,
          maxRetries,
        );
      } else {
        throw error;
      }
    }

    // Sin tool_calls — respuesta final
    if (!result.tool_calls || result.tool_calls.length === 0) {
      const content = result.content ?? "";
      if (result.finish_reason === "length" && content.trim()) {
        debugWarn("ai.retry", "truncated_final_response", {
          model,
          contentChars: content.length,
          maxTokens: runtimeOptions.maxTokens,
        });
        const recovered = await recoverTruncatedFinalResponse(
          content,
          currentMessages,
          model,
          config,
          maxRetries,
          runtimeOptions,
        );
        if (recovered) return { content: recovered, toolsCalled };
      }
      return { content, toolsCalled };
    }

    // Las herramientas terminales se ejecutan primero. Si una completa la
    // tarea, las demás llamadas de la misma ronda se responden como omitidas
    // para evitar repetir investigaciones, envíos o mutaciones.
    const terminalTools = new Set(runtimeOptions.terminalTools ?? []);
    const orderedCalls = terminalTools.size > 0
      ? [
          ...result.tool_calls.filter((call) => terminalTools.has(call.function.name)),
          ...result.tool_calls.filter((call) => !terminalTools.has(call.function.name)),
        ]
      : result.tool_calls;
    const toolResultsById = new Map<string, string>();
    const roundToolNames: string[] = [];
    let terminalSucceeded = false;

    for (const call of orderedCalls) {
      let toolResult: string;
      if (terminalSucceeded) {
        toolResult = "Omitida: una herramienta terminal ya completó esta tarea.";
      } else {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = {};
        }
        toolResult = await executeTool(call.function.name, args);
        const normalizedResult = String(toolResult).trim();
        if (normalizedResult) latestToolResult = normalizedResult;
        toolsCalled.push(call.function.name);
        roundToolNames.push(call.function.name);

        const succeeded = !normalizedResult.startsWith("Error:");
        if (succeeded) {
          onToolCall?.(call.function.name);
          if (terminalTools.has(call.function.name)) terminalSucceeded = true;
        }
      }
      toolResultsById.set(call.id, toolResult);
    }

    const toolMessages: ChatMessage[] = result.tool_calls.map((call) => ({
      role: "tool",
      content: toolResultsById.get(call.id) ?? "Omitida: no se ejecutó esta llamada.",
      tool_call_id: call.id,
    }));

    // Agregar assistant message con tool_calls + tool results al historial
    const assistantToolMsg: ChatMessage = {
      role: "assistant",
      content: result.content ?? "",
      tool_calls: result.tool_calls,
    };

    currentMessages = [...currentMessages, assistantToolMsg, ...toolMessages];
    await runtimeOptions.onToolRoundComplete?.(roundToolNames, round + 1);

    if (terminalSucceeded) {
      // Una herramienta terminal ya construyó y, cuando corresponde, entregó
      // el resultado final. No se vuelve a consultar al modelo principal: ese
      // cierre podía añadir preguntas ajenas (por ejemplo el nombre pendiente),
      // contradecir el estado de la tarea o iniciar otra investigación.
      return { content: latestToolResult || "La tarea fue completada.", toolsCalled };
    }
  }

  // Se agotó el presupuesto de rondas con herramientas. Pedimos una última
  // respuesta SIN tools para que el modelo cierre la tarea usando los resultados
  // ya ejecutados, en lugar de mostrar un error después de una acción exitosa.
  try {
    const finalResult = await rawChatRequest(
      {
        model,
        messages: currentMessages,
        max_tokens: runtimeOptions.maxTokens,
        signal: runtimeOptions.signal,
        usage: runtimeOptions.usage,
      },
      config,
      maxRetries,
    );
    const finalContent = finalResult.content?.trim();
    if (finalContent) return { content: finalContent, toolsCalled };
  } catch (error) {
    if (runtimeOptions.signal?.aborted) throw error;
    if (process.env.LUNA_TEST_QUIET !== "1") {
      debugWarn("ai.tools", "final_response_after_tool_limit_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    content: latestToolResult || "La tarea terminó, pero el modelo no generó un mensaje final.",
    toolsCalled,
  };
}

/**
 * Obtiene la lista de modelos del endpoint configurado.
 * No aplica filtros por sufijo, proveedor o nombre: el endpoint es la fuente
 * de verdad y solo se descartan identificadores vacíos o duplicados.
 */
function extractModelIds(payload: unknown): string[] {
  const root = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models)
        ? root.models
        : [];
  const ids = entries.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [entry.trim()];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const candidate = entry as Record<string, unknown>;
    const id = [candidate.id, candidate.model, candidate.name]
      .find((value) => typeof value === "string" && value.trim());
    return typeof id === "string" ? [id.trim()] : [];
  });
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

async function fetchModelCatalog(modelsUrl: string, apiKey: string, timeoutMs: number): Promise<string[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetchWithTimeout(modelsUrl, { headers }, timeoutMs);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200) || response.statusText}`);
  }
  return extractModelIds(await response.json());
}

export async function fetchModels(config: LlmConfig): Promise<string[]> {
  return fetchModelCatalog(config.modelsUrl, config.apiKey, config.requestTimeoutMs);
}

export async function discoverProviderModels(
  candidates: readonly ProviderEndpointCandidate[],
  apiKey: string,
  timeoutMs: number,
): Promise<{ candidate: ProviderEndpointCandidate; models: string[] }> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const models = await fetchModelCatalog(candidate.modelsUrl, apiKey, timeoutMs);
      if (models.length === 0) throw new Error("El catálogo no contiene modelos reconocibles.");
      return { candidate, models };
    } catch (error) {
      failures.push(`${candidate.modelsUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No pude detectar /models en la URL proporcionada. ${failures.join(" | ")}`);
}

export interface ModelDiscoveryResult {
  models: string[];
  usedFallback: boolean;
  error?: Error;
}

/**
 * Consulta el catálogo y garantiza que siempre exista al menos el modelo
 * predeterminado. El modelo configurado se mantiene como primera opción.
 */
export async function discoverModels(
  config: LlmConfig,
): Promise<ModelDiscoveryResult> {
  try {
    const discovered = await fetchModels(config);
    const models = [
      config.defaultModel,
      ...discovered.filter((model) => model !== config.defaultModel),
    ];
    return { models, usedFallback: discovered.length === 0 };
  } catch (error) {
    return {
      models: [config.defaultModel],
      usedFallback: true,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Estima tokens de un texto: caracteres / 3 (conservador para
 * texto mixto español/inglés con tokenizers tipo BPE/cl100k).
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Costo estructural por mensaje. */
const MSG_OVERHEAD = 8;

/**
 * Estima tokens de un array de mensajes.
 * Fórmula: chars/3 + overhead estructural + tool_calls.
 */
export function estimateTokensAccurate(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const contentTokens = estimateTextTokens(msg.content ?? "");
    total += contentTokens + MSG_OVERHEAD;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        total += 40 + estimateTextTokens(tc.function.name);
        total += estimateTextTokens(tc.function.arguments);
      }
    }
    if (msg.tool_call_id) {
      total += 20;
    }
  }
  return total;
}
