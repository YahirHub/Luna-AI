import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_VAULT_TOOLS,
  PersistentMemoryVault,
  executeMemoryVaultTool,
} from "../src/memory-vault.ts";

const roots: string[] = [];
function createVault(): { vault: PersistentMemoryVault; root: string } {
  const root = join(tmpdir(), `luna-memory-vault-${Date.now()}-${crypto.randomUUID()}`);
  roots.push(root);
  return { vault: new PersistentMemoryVault(root), root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PersistentMemoryVault", () => {
  it("crea notas Markdown con propiedades YAML y las encuentra por contenido", () => {
    const { vault, root } = createVault();
    const created = vault.upsert("user-a", {
      title: "Fechas de cumpleaños",
      type: "dates",
      tags: ["cumpleaños", "familia"],
      aliases: ["cumples"],
      properties: { next_review: "2026-12-01" },
      content: "# Fechas de cumpleaños\n\n- Ana — 1995-12-08\n- Luis — 15 de abril (año desconocido)",
    });

    expect(created.created).toBe(true);
    expect(created.note.path).toBe("fechas-de-cumpleanos.md");
    expect(created.note.type).toBe("dates");
    expect(created.note.tags).toContain("cumpleaños");
    const raw = readFileSync(join(root, "user-a", "vault", created.note.path), "utf8");
    expect(raw).toContain('title: "Fechas de cumpleaños"');
    expect(raw).toContain('next_review: "2026-12-01"');

    const results = vault.search("user-a", "qué fechas tengo guardadas");
    expect(results[0]?.note.title).toBe("Fechas de cumpleaños");
    expect(results[0]?.snippet).toContain("Ana");
  });

  it("mantiene aislamiento completo entre usuarios", () => {
    const { vault } = createVault();
    vault.upsert("user-a", { title: "Proyectos", content: "Proyecto secreto de A" });
    vault.upsert("user-b", { title: "Proyectos", content: "Proyecto distinto de B" });

    expect(vault.search("user-a", "secreto")).toHaveLength(1);
    expect(vault.search("user-a", "distinto")).toHaveLength(0);
    expect(vault.read("user-b", "Proyectos").content).toContain("distinto de B");
  });

  it("crea backlinks y actualiza wikilinks al renombrar", () => {
    const { vault } = createVault();
    vault.upsert("user", { title: "Ana", type: "person", content: "# Ana\n\nAmiga de la familia." });
    vault.upsert("user", {
      title: "Fechas de cumpleaños",
      type: "dates",
      content: "# Fechas de cumpleaños\n\n- [[Ana]] — 1995-12-08",
    });

    expect(vault.backlinks("user", "Ana").map((note) => note.title)).toEqual(["Fechas de cumpleaños"]);
    const renamed = vault.rename("user", "Ana", "Ana Pérez");
    expect(renamed.note.path).toBe("ana-perez.md");
    expect(renamed.linksUpdated).toBe(1);
    expect(vault.read("user", "Fechas de cumpleaños").content).toContain("[[ana-perez]]");
  });

  it("edita de forma exacta y evita reemplazos ambiguos", () => {
    const { vault } = createVault();
    vault.upsert("user", { title: "Notas", content: "uno\ndos\ndos" });
    expect(() => vault.edit("user", "Notas", "dos", "tres")).toThrow("aparece 2 veces");
    const edited = vault.edit("user", "Notas", "dos", "tres", true);
    expect(edited.replacements).toBe(2);
    expect(edited.note.content).toContain("tres\ntres");
  });

  it("mueve notas a papelera y permite restaurarlas", () => {
    const { vault, root } = createVault();
    vault.upsert("user", { title: "Temporal", content: "Dato recuperable" });
    const deleted = vault.delete("user", "Temporal");
    expect(vault.list("user")).toHaveLength(0);
    expect(vault.listTrash("user")).toContain(deleted.trashedPath.split("/").at(-1)!);
    expect(existsSync(join(root, "user", "vault", deleted.trashedPath))).toBe(true);

    const restored = vault.restore("user", deleted.trashedPath);
    expect(restored.title).toBe("Temporal");
    expect(vault.search("user", "recuperable")).toHaveLength(1);
  });

  it("bloquea escrituras mediante symlinks que salen de la bóveda", () => {
    if (process.platform === "win32") return;
    const { vault, root } = createVault();
    vault.init("user");
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, "user", "vault", "escape"), "dir");
    expect(() => vault.upsert("user", {
      title: "Escape",
      folder: "escape",
      content: "No debe salir",
    })).toThrow("enlace simbólico externo");
  });

  it("rechaza secretos en Markdown", () => {
    const { vault } = createVault();
    expect(() => vault.upsert("user", {
      title: "Accesos",
      content: "Contraseña: super-secreta",
    })).toThrow("no almacena contraseñas");
    expect(() => vault.upsert("user", {
      title: "API",
      content: "Referencia segura",
      properties: { api_key: "abc" },
    })).toThrow("parece contener un secreto");
  });

  it("construye contexto relevante sin inyectar toda la bóveda", () => {
    const { vault } = createVault();
    vault.upsert("user", { title: "Fechas de cumpleaños", type: "dates", content: "Ana cumple el 8 de diciembre." });
    vault.upsert("user", { title: "Preferencias de código", type: "preferences", content: "Prefiere TypeScript." });
    const context = vault.buildRelevantContext("user", "¿Qué cumpleaños tengo guardados?");
    expect(context).toContain("Fechas de cumpleaños");
    expect(context).toContain("Ana cumple");
    expect(context).not.toContain("Prefiere TypeScript");
  });
});

describe("herramientas memory_vault", () => {
  it("expone operaciones de listado, búsqueda, lectura y mantenimiento", () => {
    const names = MEMORY_VAULT_TOOLS.map((tool) => tool.function.name);
    expect(names).toEqual([
      "memory_vault_list",
      "memory_vault_search",
      "memory_vault_read",
      "memory_vault_upsert",
      "memory_vault_edit",
      "memory_vault_rename",
      "memory_vault_backlinks",
      "memory_vault_delete",
      "memory_vault_restore",
    ]);
  });

  it("crea, lista, busca y lee una nota mediante function tools", async () => {
    const { vault } = createVault();
    const created = await executeMemoryVaultTool("memory_vault_upsert", {
      title: "Fechas de cumpleaños",
      content: "# Fechas de cumpleaños\n\n- Ana — 1995-12-08",
      type: "dates",
      tags: ["cumpleaños"],
      aliases: ["cumples"],
    }, vault, "user");
    expect(created).toStartWith("✅ Nota creada");

    const listed = await executeMemoryVaultTool("memory_vault_list", { type: "dates" }, vault, "user");
    expect(listed).toContain("Fechas de cumpleaños");
    const searched = await executeMemoryVaultTool("memory_vault_search", { query: "Ana cumpleaños" }, vault, "user");
    expect(searched).toContain("1995-12-08");
    const read = await executeMemoryVaultTool("memory_vault_read", { note: "cumples" }, vault, "user");
    expect(read).toContain("Ana — 1995-12-08");
  });

  it("exige confirmación antes de eliminar", async () => {
    const { vault } = createVault();
    vault.upsert("user", { title: "Temporal", content: "Dato" });
    const denied = await executeMemoryVaultTool("memory_vault_delete", { note: "Temporal" }, vault, "user");
    expect(denied).toContain("confirmed=true");
    expect(vault.list("user")).toHaveLength(1);
  });
});
