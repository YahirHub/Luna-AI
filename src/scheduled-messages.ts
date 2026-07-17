import type { WASocket } from "@whiskeysockets/baileys";
import { chatCompletion } from "./ai.ts";
import type { ChatMessage } from "./ai.ts";
import type { LlmConfig } from "./llm-config.ts";
import { STATIC_SYSTEM_PROMPT_CONTENT } from "./context.ts";
import { sendWithTyping } from "./messaging.ts";

export interface ScheduledMessageOptions {
  sock: WASocket;
  jid: string;
  model: string;
  llmConfig: LlmConfig;
  dynamicContext: string;
  prompt: string;
  fallbackText: string;
  title: string;
  logLabel: string;
}

/**
 * Genera y entrega una notificación programada. Si el proveedor LLM falla,
 * envía el contenido original; solo resuelve cuando WhatsApp confirmó el envío.
 */
export async function deliverScheduledMessage(
  options: ScheduledMessageOptions,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: STATIC_SYSTEM_PROMPT_CONTENT },
    {
      role: "user",
      content: `${options.dynamicContext}\n\n---\n\n${options.prompt}`,
    },
  ];

  let body = options.fallbackText;
  try {
    body = await chatCompletion(messages, options.model, options.llmConfig);
  } catch (err) {
    console.error(`[${options.logLabel}] Falló la generación con LLM; usando fallback:`, err);
  }

  const deliveredText = `${options.title}\n\n${body}`;
  await sendWithTyping(
    options.sock,
    options.jid,
    deliveredText,
    2_000,
    4_000,
  );
  return deliveredText;
}
