import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAppDir } from "./utils.ts";

const DEFAULT_MEMORY = `# Memoria de esta conversacion 📝

Aqui guardo informacion importante sobre esta persona que no quiero olvidar, incluso despues de que la conversacion se reinicie con !clear.

## Para que sirve? 🎯

- Recordar el nombre de la persona con la que hablo
- Guardar datos importantes que me comparte
- Anotar preferencias y comportamientos especificos
- Mantener notas sobre como tratarla

## Formato sugerido ✍️

Puedes escribir en lenguaje natural como si tomaras notas para ti misma:

\`\`\`
Nombre: Juan
Le gusta que le hable de manera casual
Le interesa la programacion en JavaScript
\`\`\`
`;

/** Sanitiza un JID para usarlo como nombre de carpeta/archivo. */
function safeJid(jid: string): string {
  return jid.replace(/[^a-zA-Z0-9@._-]/g, "_");
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
    return join(base, safeJid(jid), "memory.md");
  }

  /** Crea el archivo de memoria con contenido por defecto si no existe. */
  init(jid: string): void {
    const path = this.getPath(jid);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(path)) {
      writeFileSync(path, DEFAULT_MEMORY, "utf-8");
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
      writeFileSync(path, finalContent, "utf-8");
    } else {
      const current = this.getContent(jid);
      const separator = current.endsWith("\n") ? "" : "\n";
      writeFileSync(path, current + separator + content + "\n", "utf-8");
    }
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
      memoryManager.write(jid, mode, content);
      return `✅ Memoria actualizada. Contenido actual:\n\n${memoryManager.getContent(jid)}`;
    }
    case "memory_read": {
      return memoryManager.getContent(jid);
    }
    default:
      return `Error: funcion desconocida "${toolName}"`;
  }
}
