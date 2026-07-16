/** Modelo devuelto por la API de OpenAI. */
interface ApiModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

/** Mensaje en formato OpenAI. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  /** Solo para mensajes assistant con tool_calls. */
  tool_calls?: ToolCall[];
}

/** Opciones para la API. */
export interface AiConfig {
  baseUrl: string;
  apiKey: string;
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

interface RawRequestOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
}

/**
 * Ejecuta una solicitud raw a /chat/completions con reintentos.
 */
async function rawChatRequest(
  body: RawRequestOptions,
  config: AiConfig,
  maxRetries = 3,
): Promise<{
  content: string | null;
  tool_calls?: ToolCall[];
}> {
  const url = `${config.baseUrl}/chat/completions`;
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
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
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
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.warn(
          `[ai] Intento ${attempt}/${maxRetries} falló — reintentando en ${backoff}ms...`,
        );
        await new Promise((r) => setTimeout(r, backoff));
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
  config: AiConfig,
  maxRetries = 3,
): Promise<string> {
  const result = await rawChatRequest(
    { model, messages },
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
export async function chatCompletionWithTools(
  messages: ChatMessage[],
  model: string,
  config: AiConfig,
  tools: ToolDefinition[],
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  maxRetries = 3,
  onToolCall?: (name: string) => void,
): Promise<{ content: string; toolsCalled: string[] }> {
  let currentMessages = [...messages];
  const toolsCalled: string[] = [];

  for (let round = 0; round < 5; round++) {
    const result = await rawChatRequest(
      { model, messages: currentMessages, tools },
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
 * Obtiene la lista de modelos de la API y filtra los que terminan en "-free".
 */
export async function fetchFreeModels(config: AiConfig): Promise<string[]> {
  const url = `${config.baseUrl}/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Error al obtener modelos (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as { data?: ApiModel[] };

  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("Respuesta inesperada de /models");
  }

  return data.data
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.endsWith("-free"))
    .sort();
}

/**
 * Estima tokens de forma aproximada: caracteres / 4.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += Math.ceil(msg.content.length / 4) + 4;
  }
  return total;
}
