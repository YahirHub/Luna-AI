import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CONTEXT_DIR = join(import.meta.dir, "..", "contexto");

describe("contexto — numeración", () => {
  it("mantiene un maestro 000 canónico y registros históricos numerados", () => {
    const files = readdirSync(CONTEXT_DIR)
      .filter((name) => name.endsWith(".md"))
      .sort();

    expect(new Set(files).size).toBe(files.length);
    expect(files).toContain("000-contexto-maestro.md");

    const records = files.filter((name) => name !== "000-contexto-maestro.md");
    for (const name of records) expect(name).toMatch(/^\d{2,}-[^/]+\.md$/);

    const numbers = records.map((name) => Number(name.split("-", 1)[0]));
    expect(numbers.every((number) => Number.isInteger(number) && number > 0)).toBe(true);

    // Una instalación puede conservar MD históricos al superponer un ZIP nuevo.
    // El prefijo numérico es orden cronológico, no una clave primaria: no hacemos
    // fallar toda la suite por dos documentos legacy con el mismo número. La
    // fuente canónica es 000, que sí debe apuntar a un registro existente y al
    // número más reciente disponible.
    const master = readFileSync(join(CONTEXT_DIR, "000-contexto-maestro.md"), "utf8");
    const latest = /`contexto\/(\d{2,}-[^`]+\.md)`/.exec(master)?.[1];
    expect(latest).toBeTruthy();
    expect(files).toContain(latest!);
    const latestNumber = Number(latest!.split("-", 1)[0]);
    expect(latestNumber).toBe(Math.max(...numbers));
  });
});
