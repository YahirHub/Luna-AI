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
    if (name === "workspace_list_artifacts") {
      const artifacts = manager.listArtifacts(jid);
      if (artifacts.length === 0) return "No hay artefactos registrados.";
      return artifacts.map((item, index) => `${index + 1}. ${item.path} — ${item.mimeType} — ${item.size} bytes`).join("\n");
    }
    return `Error: herramienta de workdir desconocida "${name}".`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
