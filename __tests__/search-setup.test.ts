import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchSetupManager } from "../src/search/search-setup.ts";
import { loadWebSearchAuth, loadWebSearchSettings } from "../src/search/search-storage.ts";

const TEST_DIR = join(tmpdir(), `luna-search-setup-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("SearchSetupManager", () => {
  it("configura una clave mediante el flujo numérico", async () => {
    const manager = new SearchSetupManager(TEST_DIR);
    const jid = "admin@s.whatsapp.net";
    expect(manager.start(jid)).toContain("CONFIGURAR BÚSQUEDA WEB");

    expect((await manager.submit(jid, "1")).text).toContain("Tavily");
    expect((await manager.submit(jid, "1")).text).toContain("API KEY");
    const saved = await manager.submit(jid, "tvly-secret");

    expect(saved.secretInput).toBe(true);
    expect(loadWebSearchAuth(TEST_DIR).apiKeys.tavily).toBe("tvly-secret");
    expect(loadWebSearchSettings(TEST_DIR).defaultProvider).toBe("tavily");
  });

  it("actualiza el orden de respaldo sin perder motores", async () => {
    const manager = new SearchSetupManager(TEST_DIR);
    const jid = "admin2@s.whatsapp.net";
    manager.start(jid);
    await manager.submit(jid, "8");
    await manager.submit(jid, "3,2,1");

    expect(loadWebSearchSettings(TEST_DIR).fallbackOrder.slice(0, 3)).toEqual([
      "exa",
      "brave",
      "tavily",
    ]);
  });

  it("permite guardar y salir", async () => {
    const manager = new SearchSetupManager(TEST_DIR);
    const jid = "admin3@s.whatsapp.net";
    manager.start(jid);
    const result = await manager.submit(jid, "0");
    expect(result.done).toBe(true);
    expect(manager.has(jid)).toBe(false);
  });
});
