import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldUseBrowserAgentForPrompt } from "../src/agents/spawn-agents-tool.ts";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";
import { executeAgentWorkspaceTool } from "../src/workspace/agent-workspace-tools.ts";
import { executeWorkspaceTool } from "../src/workspace/workspace-tools.ts";
import { BROWSER_AGENT_TOOL_NAMES } from "../src/browser/browser-tools.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("enrutamiento browser-agent/api-search", () => {
  it("envía scraping integral de un dominio al navegador", () => {
    expect(shouldUseBrowserAgentForPrompt("Analiza https://thowilabs.com, recorre todas las páginas, HTML, imágenes y favicon")).toBe(true);
    expect(shouldUseBrowserAgentForPrompt("Scrapea example.com y extrae el contenido de cada página")).toBe(true);
  });

  it("mantiene las búsquedas rápidas en api-search", () => {
    expect(shouldUseBrowserAgentForPrompt("Busca las noticias más recientes sobre Bun y compáralas")).toBe(false);
    expect(shouldUseBrowserAgentForPrompt("Usa api-search para buscar referencias públicas de example.com")).toBe(false);
  });
});

describe("herramientas completas de navegador", () => {
  it("incluye HTML, consola, red, assets, PDF y descarga masiva", () => {
    for (const name of [
      "browser_get_html", "browser_find_html", "browser_eval", "browser_console", "browser_errors",
      "browser_network_requests", "browser_network_request", "browser_extract_assets",
      "browser_download_assets", "browser_pdf",
    ]) expect(BROWSER_AGENT_TOOL_NAMES).toContain(name as never);
  });
});

describe("edición segura del workdir", () => {
  it("permite escribir, editar, añadir y eliminar desde el orquestador", async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-workdir-tools-")); roots.push(root);
    const manager = new WorkspaceManager(root);
    const jid = "user@test";
    expect(await executeWorkspaceTool("workspace_write_text", { path: "notes.md", content: "uno" }, manager, jid)).toContain("guardado");
    expect(await executeWorkspaceTool("workspace_append_text", { path: "notes.md", content: " dos" }, manager, jid)).toContain("añadido");
    expect(await executeWorkspaceTool("workspace_edit_text", { path: "notes.md", old_text: "dos", new_text: "tres" }, manager, jid)).toContain("editado");
    expect(manager.readText(jid, "notes.md")).toBe("uno tres");
    expect(await executeWorkspaceTool("workspace_delete", { path: "notes.md", confirmed: true }, manager, jid)).toContain("eliminada");
  });

  it("confina los archivos del agente a su propia carpeta", async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-agent-workdir-")); roots.push(root);
    const manager = new WorkspaceManager(root);
    const jid = "agent@test";
    const dir = "tasks/t1/agents/01-browser-web";
    await executeAgentWorkspaceTool("agent_workspace_write_text", { path: "site.md", content: "contenido" }, manager, jid, dir);
    await executeAgentWorkspaceTool("agent_workspace_edit_text", { path: "site.md", old_text: "contenido", new_text: "actualizado" }, manager, jid, dir);
    expect(manager.readText(jid, `${dir}/site.md`)).toBe("actualizado");
    expect(await executeAgentWorkspaceTool("agent_workspace_delete", { path: "." }, manager, jid, dir)).toStartWith("Error:");
  });
});
