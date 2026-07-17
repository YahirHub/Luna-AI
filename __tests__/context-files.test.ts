import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const CONTEXT_DIR = join(import.meta.dir, "..", "contexto");

describe("contexto — numeración", () => {
  it("usa una secuencia única y continua de dos dígitos", () => {
    const files = readdirSync(CONTEXT_DIR)
      .filter((name) => name.endsWith(".md"))
      .sort();

    expect(new Set(files).size).toBe(files.length);
    files.forEach((name, index) => {
      const expectedPrefix = String(index + 1).padStart(2, "0");
      expect(name).toMatch(/^\d{2}-[^/]+\.md$/);
      expect(name.startsWith(`${expectedPrefix}-`)).toBe(true);
    });
  });
});
