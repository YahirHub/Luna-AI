import type { LlmConfig } from "./llm-config.ts";

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


class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
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
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true;
}

interface RawRequestOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
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
    requestBody.tool_choice = "auto";
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

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: ToolCall[];
          };
        }>;
      };

      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error("La API no devolvió choices en la respuesta");
      }

      const content = choice.message?.content ?? null;
      const toolCalls = choice.message?.tool_calls;

      return {
        content,
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (body.signal?.aborted) {
        throw lastError;
      }
      if (attempt < maxRetries && shouldRetry(lastError)) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.warn(
          `[ai] Intento ${attempt}/${maxRetries} falló — reintentando en ${backoff}ms...`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      } else {
        break;
      }
    }
  }

  throw lastError ?? new Error("Error desconocido en chat completion");
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
): Promise<string> {
  const result = await rawChatRequest(
    { model, messages, max_tokens: maxTokens },
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
  signal?: AbortSignal;
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
  const maxRounds = Math.min(10, Math.max(1, runtimeOptions.maxRounds ?? 5));

  for (let round = 0; round < maxRounds; round++) {
    const result = await rawChatRequest(
      { model, messages: currentMessages, tools, signal: runtimeOptions.signal },
      config,
      maxRetries,
    );

    // Sin tool_calls — respuesta final
    if (!result.tool_calls || result.tool_calls.length === 0) {
      return { content: result.content ?? "", toolsCalled };
    }

    // Ejecutar todos los tool_calls de esta ronda
    const toolMessages: ChatMessage[] = [];

    for (const call of result.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = {};
      }

      const toolResult = await executeTool(call.function.name, args);

      toolsCalled.push(call.function.name);

      // Notificar solo si la ejecución fue exitosa
      if (!String(toolResult).startsWith("Error:")) {
        onToolCall?.(call.function.name);
      }

      toolMessages.push({
        role: "tool",
        content: toolResult,
        tool_call_id: call.id,
      });
    }

    // Agregar assistant message con tool_calls + tool results al historial
    const assistantToolMsg: ChatMessage = {
      role: "assistant",
      content: result.content ?? "",
      tool_calls: result.tool_calls,
    };

    currentMessages = [...currentMessages, assistantToolMsg, ...toolMessages];
  }

  // Limite de rondas alcanzado
  return {
    content: "El modelo excedió el número de llamadas a herramientas.",
    toolsCalled,
  };
}

/**
 * Obtiene la lista de modelos del endpoint configurado.
 * No aplica filtros por sufijo, proveedor o nombre: el endpoint es la fuente
 * de verdad y solo se descartan identificadores vacíos o duplicados.
 */
export async function fetchModels(config: LlmConfig): Promise<string[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const response = await fetchWithTimeout(
    config.modelsUrl,
    { headers },
    config.requestTimeoutMs,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Error al obtener modelos (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const payload = (await response.json()) as { data?: unknown };

  if (!Array.isArray(payload.data)) {
    throw new Error("Respuesta inesperada del endpoint de modelos");
  }

  const ids = payload.data.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("id" in entry)) {
      return [];
    }
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id.trim() !== "" ? [id.trim()] : [];
  });

  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
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
