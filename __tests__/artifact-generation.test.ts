import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPdfFromMarkdown, writePdfArtifact } from "../src/artifacts/pdf.ts";
import { createFolderArchive } from "../src/artifacts/zip.ts";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";

const roots: string[] = [];
function createWorkspace(): WorkspaceManager {
  const root = join(tmpdir(), `luna-artifacts-${Date.now()}-${crypto.randomUUID()}`);
  roots.push(root);
  return new WorkspaceManager(root);
}
afterAll(() => roots.forEach((value) => rmSync(value, { recursive: true, force: true })));

describe("artefactos PDF y ZIP", () => {
  it("genera un PDF válido y crea carpetas de salida", () => {
    const direct = createPdfFromMarkdown("# Reporte\n\nAquí está la comparación.\n\n| Modelo | Precio |\n|---|---|\n| GPT | 1 |\n");
    expect(direct.subarray(0, 8).toString("latin1")).toStartWith("%PDF-1.4");
    expect(direct.toString("latin1")).toContain("%%EOF");
    const pdfText = direct.toString("latin1");
    expect(pdfText).toContain("Aquí está la comparación");
    expect(pdfText).toContain("Modelo");
    expect(pdfText).toContain("Precio");
    expect(pdfText).not.toContain("| Modelo | Precio |");
    expect(pdfText).toContain(" re S");

    const workspace = createWorkspace();
    workspace.writeText("user", "inbox/reporte.md", "# Informe\n\nContenido");
    const path = writePdfArtifact(workspace, "user", "inbox/reporte.md", "exports/final/reporte.pdf");
    expect(path).toBe("exports/final/reporte.pdf");
    expect(workspace.readBuffer("user", path).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("repite el encabezado de tablas largas al cambiar de página", () => {
    const rows = Array.from({ length: 80 }, (_, index) =>
      `| Proveedor ${index + 1} | Modelo con descripción suficientemente larga ${index + 1} | $${index}.00 |`
    ).join("\n");
    const pdf = createPdfFromMarkdown(
      `# Comparativa larga\n\n| Proveedor | Modelo | Precio |\n|---|---|---|\n${rows}\n`,
    ).toString("latin1");
    const pageCount = Number(pdf.match(/\/Count (\d+)/)?.[1] ?? "0");
    expect(pageCount).toBeGreaterThan(1);
    expect(pdf.match(/\(Proveedor\) Tj/g)?.length ?? 0).toBe(pageCount);
  });

  it("archive_folder incluye todo y gitzip respeta .gitignore anidados", () => {
    const workspace = createWorkspace();
    const jid = "user";
    workspace.writeText(jid, "project/.gitignore", "node_modules/\n*.log\n!keep.log\n");
    workspace.writeText(jid, "project/src/index.ts", "console.log('ok')");
    workspace.writeText(jid, "project/debug.log", "ignorar");
    workspace.writeText(jid, "project/keep.log", "conservar");
    workspace.writeText(jid, "project/node_modules/pkg.js", "ignorar");
    workspace.writeText(jid, "project/nested/.gitignore", "secret.txt\n");
    workspace.writeText(jid, "project/nested/secret.txt", "ignorar");
    workspace.writeText(jid, "project/nested/readme.md", "incluir");

    const normal = createFolderArchive(workspace, jid, "project", "exports/all/project.zip", false);
    expect(normal.fileCount).toBe(8);

    const git = createFolderArchive(workspace, jid, "project", "exports/source/project.zip", true);
    expect(git.ignored.some((name) => name.includes("node_modules"))).toBe(true);
    expect(git.ignored).toContain("debug.log");
    expect(git.ignored).toContain("nested/secret.txt");
    const zipText = workspace.readBuffer(jid, git.outputPath).toString("utf8");
    expect(zipText).toContain("src/index.ts");
    expect(zipText).toContain("keep.log");
    expect(zipText).toContain("nested/readme.md");
    expect(zipText).not.toContain("node_modules/pkg.js");
    expect(zipText).not.toContain("nested/secret.txt");
  });
});
