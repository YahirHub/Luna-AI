import type { ToolDefinition } from "../ai.ts";
import type { WorkspaceManager } from "./workspace-manager.ts";

export const WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "workspace_list",
      description: "Lista archivos temporales del workdir privado del usuario.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Ruta relativa. Predeterminado: ." } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_append_text",
      description: "Añade texto al final de un archivo del workdir sin borrar su contenido actual.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_edit_text",
      description: "Edita un archivo de texto reemplazando un fragmento exacto. Falla si el fragmento no existe o es ambiguo.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_delete",
      description: "Elimina un archivo o carpeta concreta dentro del workdir. Nunca elimina el workdir completo.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          confirmed: { type: "boolean", description: "Debe ser true para confirmar la eliminación exacta." },
        },
        required: ["path", "confirmed"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_read_text",
      description: "Lee un archivo de texto del workdir privado del usuario.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, max_chars: { type: "integer", minimum: 1000, maximum: 100000 } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_write_text",
      description: "Crea o reemplaza un archivo de texto dentro del workdir privado del usuario.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_list_artifacts",
      description: "Lista los artefactos finales registrados para el usuario.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_clear",
      description:
        "Vacía por completo el workdir privado del usuario (tasks, inbox, exports y artefactos temporales). Es destructiva: úsala solo cuando el usuario pida explícitamente limpiar o borrar todo su workdir y confirmed sea true.",
      parameters: {
        type: "object",
        properties: {
          confirmed: {
            type: "boolean",
            description: "Debe ser true cuando el usuario haya pedido explícitamente vaciar todo el workdir.",
          },
        },
        required: ["confirmed"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeWorkspaceTool(
  name: string,
  args: Record<string, unknown>,
  manager: WorkspaceManager,
  jid: string,
): Promise<string> {
  try {
    if (name === "workspace_list") {
      const path = typeof args.path === "string" ? args.path : ".";
      const entries = manager.list(jid, path);
      return entries.length > 0 ? entries.join("\n") : "El workdir está vacío.";
    }
    if (name === "workspace_read_text") {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path) return "Error: path es obligatorio.";
      const maxChars = typeof args.max_chars === "number" ? args.max_chars : 100_000;
      return manager.readText(jid, path, maxChars);
    }
    if (name === "workspace_write_text") {
      const path = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!path) return "Error: path es obligatorio.";
      const stored = manager.writeText(jid, path, content);
      return `✅ Archivo guardado en ${stored}`;
    }
    if (name === "workspace_append_text") {
      const path = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!path) return "Error: path es obligatorio.";
      const stored = manager.appendText(jid, path, content);
      return `✅ Texto añadido en ${stored}`;
    }
    if (name === "workspace_edit_text") {
      const path = typeof args.path === "string" ? args.path : "";
      const oldText = typeof args.old_text === "string" ? args.old_text : "";
      const newText = typeof args.new_text === "string" ? args.new_text : "";
      if (!path || !oldText) return "Error: path y old_text son obligatorios.";
      const edited = manager.editText(jid, path, oldText, newText, args.replace_all === true);
      return `✅ Archivo editado en ${edited.path}; reemplazos: ${edited.replacements}`;
    }
    if (name === "workspace_delete") {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return "Error: path es obligatorio.";
      if (args.confirmed !== true) return "Error: workspace_delete requiere confirmed=true.";
      manager.remove(jid, path);
      return `✅ Ruta eliminada: ${path}`;
    }
    if (name === "workspace_list_artifacts") {
      const artifacts = manager.listArtifacts(jid);
      if (artifacts.length === 0) return "No hay artefactos registrados.";
      return artifacts.map((item, index) => `${index + 1}. ${item.path} — ${item.mimeType} — ${item.size} bytes`).join("\n");
    }
    if (name === "workspace_clear") {
      if (args.confirmed !== true) {
        return "Error: limpiar todo el workdir requiere una petición explícita del usuario y confirmed=true.";
      }
      manager.clearWorkdir(jid);
      return "✅ Workdir limpiado por completo. Se recrearon las carpetas base tasks, inbox y exports.";
    }
    return `Error: herramienta de workdir desconocida "${name}".`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
