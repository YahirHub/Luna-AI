import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAppDir } from "./utils.ts";
import {
  sanitizePathSegment,
  writeTextFileAtomically,
} from "./storage.ts";

export const MAX_MEMORY_CHARS = 64_000;

const DEFAULT_MEMORY = `# Memoria personal de Luna 📝

Esta memoria pertenece únicamente a la persona de este chat y sobrevive a !clear.

## Perfil de la persona

- Nombre: pendiente de preguntar
- Forma de trato preferida: pendiente de conocer
- Datos y preferencias importantes: todavía no registrados

## Instrucciones para Luna

- Sé simpática, cálida y genuinamente interesada en conocer a la persona.
- Si el nombre sigue como "pendiente de preguntar", pregúntalo de manera natural únicamente durante un saludo o charla casual sin una solicitud operativa.
- Nunca anexes la pregunta del nombre a investigaciones, archivos, informes, errores, configuraciones, alarmas, recordatorios ni seguimientos de tareas.
- Cuando la persona diga su nombre, usa memory_write para reemplazar este estado pendiente por el nombre real.
- Guarda preferencias, temas importantes y la forma en que le gusta que la traten.
- Nunca inventes información personal ni des por conocido un nombre que no esté confirmado.

## Ejemplo de memoria actualizada

\`\`\`
Nombre: Juan
Le gusta que le hable de manera casual
Le interesa la programación en JavaScript
\`\`\`
`;

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
        "Escribe o actualiza la memoria persistente del bot. " +
        "Usa esto para recordar informacion importante del usuario como su nombre, " +
        "preferencias, datos relevantes, o como debe comportarse con el. " +
        "El contenido se conserva incluso despues de usar !clear.",
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
