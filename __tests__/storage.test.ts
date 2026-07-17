import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitizePathSegment,
  writeJsonFileAtomically,
  writeTextFileAtomically,
} from "../src/storage.ts";

const TEST_DIR = join(tmpdir(), `luna-storage-test-${Date.now()}`);

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("storage", () => {
  it("sanitiza segmentos de ruta externos", () => {
    expect(sanitizePathSegment("521 99/../test@s.whatsapp.net")).toBe(
      "521_99_.._test@s.whatsapp.net",
    );
  });

  it("crea directorios y reemplaza texto", () => {
    const path = join(TEST_DIR, "nested", "data.txt");
    writeTextFileAtomically(path, "primero");
    writeTextFileAtomically(path, "segundo");

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("segundo");
  });

  it("serializa JSON completo sin dejar temporales visibles", () => {
    const path = join(TEST_DIR, "json", "data.json");
    writeJsonFileAtomically(path, { enabled: true, count: 2 });

    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      enabled: true,
      count: 2,
    });
    expect(readdirSync(join(TEST_DIR, "json"))).toEqual(["data.json"]);
  });
});
