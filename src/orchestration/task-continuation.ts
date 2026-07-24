import type { ChatMessage } from "../ai.ts";

const MAX_LINE_CHARS = 2_400;

function printableMessage(message: ChatMessage): string | null {
  if (message.role === "system" || message.role === "tool") return null;
  const content = typeof message.content === "string" ? message.content.trim() : "";
  if (!content) return null;
  const role = message.role === "assistant" ? "Luna" : "Usuario";
  return `${role}: ${content.length > MAX_LINE_CHARS ? `${content.slice(0, MAX_LINE_CHARS)}…` : content}`;
}

/**
 * Captura el contexto inmediatamente anterior a la petición que originó una
 * tarea background. Se corta en la petición original para que mensajes
 * posteriores/no relacionados no cambien retroactivamente el significado de
 * la misión, pero conserva respuestas previas necesarias para comparaciones.
 */
export function buildTaskOriginContext(
  messages: readonly ChatMessage[],
  originPrompt: string,
  maxChars = 14_000,
): string {
  const normalizedOrigin = originPrompt.trim();
  let originIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim() === normalizedOrigin) {
      originIndex = index;
      break;
    }
  }
  if (originIndex < 0) originIndex = messages.length - 1;

  const selected: string[] = [];
  let chars = 0;
  for (let index = originIndex; index >= 0; index -= 1) {
    const rendered = printableMessage(messages[index]!);
    if (!rendered) continue;
    if (selected.length > 0 && chars + rendered.length + 2 > maxChars) break;
    selected.unshift(rendered);
    chars += rendered.length + 2;
    if (selected.length >= 12) break;
  }

  return selected.join("\n\n");
}
/**
 * Captura únicamente lo que ocurrió después de delegar una tarea, siempre que
 * la petición original siga presente en la conversación activa. Sirve para que
 * una continuación background vea acciones/respuestas foreground que terminaron
 * mientras el subagente trabajaba y también continuaciones FIFO previas, sin
 * reescribir el snapshot histórico usado para recordar datos anteriores.
 */
export function buildTaskPostDelegationContext(
  messages: readonly ChatMessage[],
  originPrompt: string,
  maxChars = 10_000,
): string {
  const normalizedOrigin = originPrompt.trim();
  let originIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim() === normalizedOrigin) {
      originIndex = index;
      break;
    }
  }
  if (originIndex < 0) return "";

  const selected: string[] = [];
  let chars = 0;
  for (let index = originIndex + 1; index < messages.length; index += 1) {
    const rendered = printableMessage(messages[index]!);
    if (!rendered) continue;
    if (selected.length > 0 && chars + rendered.length + 2 > maxChars) break;
    selected.push(rendered);
    chars += rendered.length + 2;
    if (selected.length >= 12) break;
  }
  return selected.join("\n\n");
}

