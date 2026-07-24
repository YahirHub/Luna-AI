import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAppDir } from "./utils.ts";
import {
  sanitizePathSegment,
  writeTextFileAtomically,
} from "./storage.ts";

export const MAX_MEMORY_CHARS = 64_000;
export const MAX_MEMORY_CONTEXT_CHARS = 4_000;

const DEFAULT_MEMORY = `# Perfil persistente

- Nombre: pendiente de conocer
- Forma de trato preferida: pendiente de conocer
- Preferencias estables: ninguna registrada
`;

function buildCompactMemoryContext(content: string, maxChars = MAX_MEMORY_CONTEXT_CHARS): string {
  const clean = content.trim();
  if (clean.length <= maxChars) return clean;
  const lines = clean.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const priorityPattern = /\b(?:nombre|trato|prefer|idioma|lengua|formato|estilo|zona horaria|timezone|correo|email|tel[eé]fono|numero|n[uú]mero|ubicaci[oó]n)\b/iu;
  const prioritized = lines.filter((line) => priorityPattern.test(line));
  const remainder = lines.filter((line) => !priorityPattern.test(line));
  const selected: string[] = [];
  let chars = 0;
  for (const line of [...prioritized, ...remainder]) {
    if (selected.includes(line)) continue;
    if (chars + line.length + 1 > maxChars - 120) break;
    selected.push(line);
    chars += line.length + 1;
  }
  return [
    ...selected,
    `[Perfil recortado para contexto: ${clean.length} caracteres almacenados; usa memory_read si necesitas el contenido completo.]`,
  ].join("\n").slice(0, maxChars);
}

/**
 * Gestor de la memoria persistente del bot, por usuario.
 * Cada usuario tiene su propio memory.md en persistent/contexts/{jid}/.
 * Guarda información importante que sobrevive a !clear.
 */
export class MemoryManager {
  private testBaseDir: string | undefined;

  constructor(testBaseDir?: string) {
    this.testBaseDir = testBaseDir;
  }

  /** Resuelve la ruta al memory.md de un jid específico. */
  private getPath(jid: string): string {
    const base = this.testBaseDir ?? join(getAppDir(), "persistent", "contexts");
    return join(base, sanitizePathSegment(jid), "memory.md");
  }

  /** Crea el archivo de memoria con contenido por defecto si no existe. */
  init(jid: string): void {
    const path = this.getPath(jid);
    if (!existsSync(path)) {
      writeTextFileAtomically(path, DEFAULT_MEMORY);
    }
  }

  /** Obtiene el contenido completo de la memoria de un usuario. */
  getContent(jid: string): string {
    const path = this.getPath(jid);
    try {
      if (existsSync(path)) {
        return readFileSync(path, "utf-8");
      }
    } catch {
      // ignorar
    }
    this.init(jid);
    return DEFAULT_MEMORY;
  }

  /** Devuelve solo el perfil que conviene inyectar en cada request. */
  getContextContent(jid: string, maxChars = MAX_MEMORY_CONTEXT_CHARS): string {
    return buildCompactMemoryContext(this.getContent(jid), Math.max(500, Math.min(MAX_MEMORY_CONTEXT_CHARS, maxChars)));
  }

  /**
   * Escribe en la memoria de un usuario.
   * @param jid Identificador del usuario
   * @param mode "append" agrega al final, "overwrite" reemplaza todo
   * @param content Contenido a escribir
   */
  write(jid: string, mode: "append" | "overwrite", content: string): void {
    this.init(jid); // asegurar que el directorio existe
    const path = this.getPath(jid);
    if (mode === "overwrite") {
      const finalContent = content.endsWith("\n") ? content : content + "\n";
      if (finalContent.length > MAX_MEMORY_CHARS) {
        throw new Error(`La memoria excede el límite de ${MAX_MEMORY_CHARS} caracteres.`);
      }
      writeTextFileAtomically(path, finalContent);
      return;
    }

    const current = this.getContent(jid);
    const separator = current.endsWith("\n") ? "" : "\n";
    const finalContent = current + separator + content + "\n";
    if (finalContent.length > MAX_MEMORY_CHARS) {
      throw new Error(`La memoria excede el límite de ${MAX_MEMORY_CHARS} caracteres.`);
    }
    writeTextFileAtomically(path, finalContent);
  }
}

// ─── Tool definitions (OpenAI function calling) ──────────────────

export const MEMORY_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "memory_write",
      description:
        "Escribe o actualiza el perfil persistente compacto del usuario. " +
        "Es OBLIGATORIA cuando el usuario pide guardar su nombre, número, correo, forma de trato o preferencias estables. " +
        "No basta con responder que fue recordado: solo el éxito de esta herramienta confirma la escritura. " +
        "Para cumpleaños, fechas, personas, proyectos o colecciones usa memory_vault_upsert/edit. " +
        "El contenido se conserva incluso después de usar !clear.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "El contenido a escribir en la memoria",
          },
          mode: {
            type: "string",
            enum: ["append", "overwrite"],
            description:
              "'append' para agregar al final, 'overwrite' para reemplazar todo el contenido",
          },
        },
        required: ["content", "mode"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_read",
      description:
        "Lee el contenido actual de la memoria persistente. " +
        "Usa esto para recordar informacion guardada previamente.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

/**
 * Ejecuta un tool call relacionado con la memoria del usuario indicado.
 * Retorna el string de resultado que se enviara al modelo como respuesta del tool.
 */
export async function executeMemoryTool(
  toolName: string,
  args: Record<string, unknown>,
  memoryManager: MemoryManager,
  jid: string,
): Promise<string> {
  switch (toolName) {
    case "memory_write": {
      const content = String(args.content ?? "");
      const mode = args.mode === "overwrite" ? "overwrite" : "append";
      if (!content.trim()) {
        return "Error: el contenido de memoria no puede estar vacío.";
      }
      try {
        memoryManager.write(jid, mode, content);
        return `✅ Memoria actualizada. Contenido actual:\n\n${memoryManager.getContent(jid)}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "no se pudo actualizar la memoria"}`;
      }
    }
    case "memory_read": {
      return memoryManager.getContent(jid);
    }
    default:
      return `Error: funcion desconocida "${toolName}"`;
  }
}
