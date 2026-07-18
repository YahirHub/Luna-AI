import type { ToolDefinition } from "../ai.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { writePdfArtifact } from "./pdf.ts";
import { createFolderArchive } from "./zip.ts";

export const ARTIFACT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "create_pdf_from_markdown",
      description: "Crea un PDF multipágina a partir de un archivo Markdown del workdir.",
      parameters: { type: "object", properties: { markdown_path: { type: "string" }, output_path: { type: "string" } }, required: ["markdown_path", "output_path"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "archive_folder",
      description: "Comprime una carpeta del workdir en ZIP.",
      parameters: { type: "object", properties: { path: { type: "string" }, output_path: { type: "string" } }, required: ["path", "output_path"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "gitzip",
      description: "Comprime código fuente ignorando .git, enlaces externos y archivos excluidos por los .gitignore de cada carpeta. Advierte si detecta posibles secretos.",
      parameters: { type: "object", properties: { path: { type: "string" }, output_path: { type: "string" } }, required: ["path", "output_path"], additionalProperties: false },
    },
  },
];

export async function executeArtifactTool(name: string, args: Record<string, unknown>, workspace: WorkspaceManager, jid: string): Promise<string> {
  try {
    const source = typeof args.path === "string" ? args.path : "";
    const output = typeof args.output_path === "string" ? args.output_path : "";
    if (name === "create_pdf_from_markdown") {
      const markdownPath = typeof args.markdown_path === "string" ? args.markdown_path : "";
      if (!markdownPath || !output) return "Error: markdown_path y output_path son obligatorios.";
      const stored = writePdfArtifact(workspace, jid, markdownPath, output);
      const artifact = workspace.registerArtifact(jid, stored, "create_pdf_from_markdown");
      return `✅ PDF creado en ${artifact.path} (${artifact.size} bytes).`;
    }
    if (name === "archive_folder" || name === "gitzip") {
      if (!source || !output) return "Error: path y output_path son obligatorios.";
      const result = createFolderArchive(workspace, jid, source, output, name === "gitzip");
      const artifact = workspace.registerArtifact(jid, result.outputPath, name);
      return [
        `✅ ZIP creado en ${artifact.path}.`,
        `Archivos: ${result.fileCount}`,
        `Tamaño sin comprimir: ${result.uncompressedBytes} bytes`,
        ...(result.ignored.length ? [`Ignorados: ${result.ignored.length}`] : []),
        ...(result.secretWarnings.length ? ["⚠️ Posibles secretos incluidos:", ...result.secretWarnings.map((item) => `- ${item}`)] : []),
      ].join("\n");
    }
    return `Error: herramienta de artefactos desconocida "${name}".`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
