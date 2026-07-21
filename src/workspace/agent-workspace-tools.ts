import type { ToolDefinition } from "../ai.ts";
import type { WorkspaceManager } from "./workspace-manager.ts";

export const AGENT_WORKSPACE_TOOL_NAMES = [
  "agent_workspace_list",
  "agent_workspace_read_text",
  "agent_workspace_write_text",
  "agent_workspace_append_text",
  "agent_workspace_edit_text",
  "agent_workspace_delete",
] as const;

export const AGENT_WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "agent_workspace_list",
      description: "Lista archivos dentro de la carpeta privada de esta ejecución del agente.",
      parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_workspace_read_text",
      description: "Lee un archivo de texto dentro de la carpeta privada de esta ejecución.",
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
      name: "agent_workspace_write_text",
      description: "Crea o reemplaza un archivo de texto dentro de la carpeta privada de esta ejecución.",
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
      name: "agent_workspace_append_text",
      description: "Añade texto a un archivo dentro de la carpeta privada de esta ejecución.",
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
      name: "agent_workspace_edit_text",
      description: "Edita un archivo de esta ejecución reemplazando un fragmento exacto.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_workspace_delete",
      description: "Elimina un archivo o subcarpeta dentro de la carpeta privada de esta ejecución.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
  },
];

function scopedPath(agentDir: string, value: unknown): string {
  const suffix = typeof value === "string" ? value.trim().replace(/^\/+/, "") : "";
  if (!suffix || suffix === ".") return agentDir;
  return `${agentDir}/${suffix}`;
}

export async function executeAgentWorkspaceTool(
  name: string,
  args: Record<string, unknown>,
  manager: WorkspaceManager,
  jid: string,
  agentDir: string,
): Promise<string> {
  try {
    if (name === "agent_workspace_list") {
      const entries = manager.listRecursive(jid, scopedPath(agentDir, args.path), 300);
      return entries.length ? entries.join("\n") : "La carpeta del agente está vacía.";
    }
    if (name === "agent_workspace_read_text") {
      return manager.readText(jid, scopedPath(agentDir, args.path), typeof args.max_chars === "number" ? args.max_chars : 100_000);
    }
    if (name === "agent_workspace_write_text") {
      const content = typeof args.content === "string" ? args.content : "";
      return `✅ Archivo guardado en ${manager.writeText(jid, scopedPath(agentDir, args.path), content)}`;
    }
    if (name === "agent_workspace_append_text") {
      const content = typeof args.content === "string" ? args.content : "";
      return `✅ Texto añadido en ${manager.appendText(jid, scopedPath(agentDir, args.path), content)}`;
    }
    if (name === "agent_workspace_edit_text") {
      const oldText = typeof args.old_text === "string" ? args.old_text : "";
      const newText = typeof args.new_text === "string" ? args.new_text : "";
      const edited = manager.editText(jid, scopedPath(agentDir, args.path), oldText, newText, args.replace_all === true);
      return `✅ Archivo editado en ${edited.path}; reemplazos: ${edited.replacements}`;
    }
    if (name === "agent_workspace_delete") {
      const target = scopedPath(agentDir, args.path);
      if (target === agentDir) return "Error: no se puede eliminar la carpeta raíz de la ejecución.";
      manager.remove(jid, target);
      return `✅ Ruta eliminada: ${target}`;
    }
    return `Error: herramienta de archivos del agente desconocida: ${name}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
