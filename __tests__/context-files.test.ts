import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const CONTEXT_DIR = join(import.meta.dir, "..", "contexto");

describe("contexto — numeración", () => {
  it("mantiene un maestro 000 y registros históricos con numeración creciente", () => {
    const files = readdirSync(CONTEXT_DIR)
      .filter((name) => name.endsWith(".md"))
      .sort();

    expect(new Set(files).size).toBe(files.length);
    expect(files).toContain("000-contexto-maestro.md");

    const records = files.filter((name) => name !== "000-contexto-maestro.md");
    for (const name of records) expect(name).toMatch(/^\d{2,}-[^/]+\.md$/);

    const numbers = records.map((name) => Number(name.split("-", 1)[0]));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.every((number) => Number.isInteger(number) && number > 0)).toBe(true);
  });
});
