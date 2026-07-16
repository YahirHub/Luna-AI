import type { WASocket } from "@whiskeysockets/baileys";

/** Comando interpretado a partir de un mensaje de texto. */
export interface ParsedCommand {
  /** Nombre del comando en minúsculas (ej. "ayuda", "ping"). */
  name: string;
  /** Argumentos después del comando. */
  args: string[];
  /** Texto completo del mensaje sin el prefijo del comando. */
  body: string;
}

/** Prefijos que activan los comandos. */
const COMMAND_PREFIXES = ["!", "/"] as const;

/**
 * Interpreta un mensaje de texto como comando.
 * Retorna null si el mensaje no comienza con un prefijo válido.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();

  let prefix: string | null = null;
  for (const p of COMMAND_PREFIXES) {
    if (trimmed.startsWith(p)) {
      prefix = p;
      break;
    }
  }

  if (!prefix) {
    return null;
  }

  const withoutPrefix = trimmed.slice(prefix.length).trim();
  const parts = withoutPrefix.split(/\s+/);
  const name = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1);
  const body = args.join(" ");

  if (name.length === 0) {
    return null;
  }

  return { name, args, body };
}

/** Respuesta generada por un manejador de comandos. */
export interface CommandResult {
  text: string;
}

/** Firma de un manejador de comandos. Incluye sock para acciones avanzadas. */
export type CommandHandler = (
  command: ParsedCommand,
  senderJid: string,
  sock: WASocket,
) => CommandResult | Promise<CommandResult>;

/** Manejadores registrados: nombre del comando -> handler. */
const handlers = new Map<string, CommandHandler>();

/** Descripciones de comandos para el menú de ayuda. */
const descriptions = new Map<string, string>();

/** Registra un comando con su descripción para el menú !ayuda. */
export function registerCommand(
  name: string,
  description: string,
  handler: CommandHandler,
): void {
  handlers.set(name.toLowerCase(), handler);
  descriptions.set(name.toLowerCase(), description);
}

/** Obtiene la lista de comandos registrados con sus descripciones. */
export function getCommands(): Array<{ name: string; description: string }> {
  return Array.from(descriptions.entries())
    .map(([name, description]) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Despacha un comando a su handler. Retorna null si no existe. */
export async function dispatchCommand(
  command: ParsedCommand,
  senderJid: string,
  sock: WASocket,
): Promise<CommandResult | null> {
  const handler = handlers.get(command.name.toLowerCase());
  if (!handler) {
    return null;
  }
  return handler(command, senderJid, sock);
}

/** Verifica si un texto parece un número entero positivo. */
export function isPositiveInteger(text: string): boolean {
  return /^\d+$/.test(text.trim());
}
