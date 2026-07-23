/**
 * Convierte una respuesta rica en Markdown a texto natural apto para TTS.
 * No intenta "leer" código, URLs ni sintaxis visual: elimina lo que solo tiene
 * sentido en pantalla y conserva puntuación básica para la prosodia de Piper.
 */
export function sanitizeTextForSpeech(input: string): string {
  let text = input.replace(/\r\n?/g, "\n");

  // Contenido que no debe pronunciarse literalmente.
  text = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");

  // Imágenes Markdown no aportan texto hablado; enlaces conservan su etiqueta.
  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1 ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s)>\]}]+/gi, " ")
    .replace(/www\.[^\s)>\]}]+/gi, " ")
    .replace(/<[^>]+>/g, " ");

  // Tablas Markdown: quitar separadores visuales y conservar el contenido útil.
  text = text
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/gm, " ")
    .replace(/\|/g, ". ");

  // Estructuras Markdown y citas.
  text = text
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1");

  // Entidades frecuentes y símbolos con lectura natural.
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, " y ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, " menor que ")
    .replace(/&gt;/gi, " mayor que ")
    .replace(/\s*&\s*/g, " y ")
    .replace(/\s*→\s*|\s*⇒\s*|\s*=>\s*/g, ". ")
    .replace(/\s*←\s*|\s*⇐\s*|\s*<=\s*/g, ". ")
    .replace(/…/g, "...");

  // Emojis, pictogramas, controles y decoraciones visuales.
  text = text
    .replace(/[\u200B-\u200D\u2060\uFE0E\uFE0F]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[■□▪▫●○◆◇▶▷►▸◀◁◄◂✓✔✕✖✗✘★☆•·]/gu, " ")
    .replace(/[\\/^~=+#{}\[\]<>]/g, " ");

  // Conservar letras Unicode, números y puntuación útil para prosodia. El resto
  // de símbolos visuales se transforma en espacio para evitar pronunciaciones raras.
  text = text.replace(/[^\p{L}\p{M}\p{N}\s.,;:!?¿¡'"()%-]/gu, " ");

  // Limpieza final: una frase hablable, sin líneas/espacios visuales sobrantes.
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, ". ")
    .replace(/\.{3,}/g, "...")
    .replace(/(?:\.\s*){2,}/g, ". ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([¿¡])\s+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export type TtsTurnPreference = "voice" | "text" | null;

/** Detecta una petición explícita de formato para el turno actual. */
export function detectTtsTurnPreference(message: string): TtsTurnPreference {
  const normalized = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");

  const textPatterns = [
    /\b(?:responde|respondeme|contestame|mandame|enviame|dime)\b.{0,35}\b(?:por )?(?:texto|mensaje|escrito|chat)\b/,
    /\b(?:solo|solamente|unicamente)\b.{0,12}\b(?:texto|mensaje|escrito)\b/,
    /\b(?:no|sin)\b.{0,10}\b(?:audio|voz|nota de voz)\b/,
  ];
  if (textPatterns.some((pattern) => pattern.test(normalized))) return "text";

  const voicePatterns = [
    /\b(?:responde|respondeme|contestame|mandame|enviame|dime)\b.{0,35}\b(?:en|por|con)?\s*(?:audio|voz|nota de voz)\b/,
    /\b(?:solo|solamente|unicamente)\b.{0,12}\b(?:audio|voz|nota de voz)\b/,
    /\b(?:quiero|prefiero)\b.{0,25}\b(?:audio|voz|nota de voz)\b/,
  ];
  return voicePatterns.some((pattern) => pattern.test(normalized)) ? "voice" : null;
}

export function isTranscribedAudioMessage(message: string): boolean {
  return message.includes("[Transcripción de audio generada por el sistema]")
    || /\[ADJUNTO DISPONIBLE[^\]]*\][\s\S]{0,220}Tipo:\s*audio/iu.test(message);
}
