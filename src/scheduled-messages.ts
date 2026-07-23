import { debugError, debugWarn } from "./debug.ts";
import type { MessagingTransport } from "./transports/types.ts";
import { chatCompletion } from "./ai.ts";
import type { ChatMessage } from "./ai.ts";
import type { LlmConfig } from "./llm-config.ts";
import { STATIC_SYSTEM_PROMPT_CONTENT } from "./context.ts";
import { sendWithTyping } from "./messaging.ts";
import { normalizePreparedScheduledMessage } from "./scheduled-copy.ts";

export interface ScheduledMessageOptions {
  transport: MessagingTransport;
  jid: string;
  /** Modelo y configuración son opcionales: el mensaje persistido siempre puede entregarse. */
  model?: string;
  llmConfig?: LlmConfig;
  dynamicContext?: string;
  prompt: string;
  /** Mensaje autocontenido definido y persistido desde la creación. */
  fallbackText: string;
  title: string;
  logLabel: string;
}

/** Elimina un encabezado que el modelo haya repetido dentro del cuerpo. */
function stripRepeatedTitle(body: string, title: string): string {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return body;
  if (!body.toLocaleLowerCase("es-MX").startsWith(normalizedTitle.toLocaleLowerCase("es-MX"))) {
    return body;
  }
  return body.slice(normalizedTitle.length).replace(/^\s*[:\-–—]?\s*/, "").trim();
}

/**
 * Una respuesta vacía o que solo repite el título nunca puede borrar el mensaje
 * preparado al crear la alarma o el recordatorio.
 */
export function selectScheduledMessageBody(
  generated: unknown,
  fallbackText: string,
  title: string,
): string {
  const fallback = normalizePreparedScheduledMessage(fallbackText, fallbackText);
  if (typeof generated !== "string") return fallback;

  const withoutTitle = stripRepeatedTitle(generated.trim(), title);
  return normalizePreparedScheduledMessage(withoutTitle, fallback);
}

/**
 * Genera y entrega una notificación programada. El cuerpo persistido es la
 * fuente de verdad: si no hay proveedor, modelo o respuesta útil, se envía tal
 * cual. Solo resuelve cuando WhatsApp confirmó el envío.
 */
export async function deliverScheduledMessage(
  options: ScheduledMessageOptions,
): Promise<string> {
  const fallbackBody = normalizePreparedScheduledMessage(
    options.fallbackText,
    options.fallbackText,
  );
  let body = fallbackBody;

  if (options.model && options.llmConfig) {
    const messages: ChatMessage[] = [
      { role: "system", content: STATIC_SYSTEM_PROMPT_CONTENT },
      {
        role: "user",
        content: [
          options.dynamicContext?.trim() ?? "",
          "---",
          options.prompt,
          "",
          "MENSAJE PREDEFINIDO Y PERSISTIDO:",
          fallbackBody,
          "",
          "Puedes enviarlo tal cual. Solo reformúlalo si el contexto actual lo hace más natural.",
          "No omitas, cambies ni inventes la acción, los nombres, las cantidades o los datos importantes.",
          "Devuelve únicamente el cuerpo de la notificación, sin repetir el título.",
        ].filter(Boolean).join("\n\n"),
      },
    ];

    try {
      const generated = await chatCompletion(messages, options.model, options.llmConfig, 3, undefined, { jid: options.jid, purpose: "scheduled-message" });
      body = selectScheduledMessageBody(generated, fallbackBody, options.title);
    } catch (err) {
      debugError("scheduled-message", "llm_generation_failed", err, { label: options.logLabel, jid: options.jid });
    }
  } else {
    debugWarn("scheduled-message", "llm_unavailable_using_fallback", { label: options.logLabel, jid: options.jid });
  }

  const deliveredText = `${options.title}\n\n${body}`;
  await sendWithTyping(
    options.transport,
    options.jid,
    deliveredText,
    2_000,
    4_000,
  );
  return deliveredText;
}
