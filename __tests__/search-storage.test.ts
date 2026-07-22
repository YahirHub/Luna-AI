import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSearchProviderOrder,
  resolveSearchProviderState,
} from "../src/search/search-config.ts";
import {
  loadWebSearchAuth,
  loadWebSearchSettings,
  isApiSearchAvailable,
  removeSearchProviderApiKey,
  saveSearchProviderApiKey,
  setDefaultSearchProvider,
  setSearchProviderEnabled,
} from "../src/search/search-storage.ts";

const TEST_DIR = join(tmpdir(), `luna-search-storage-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("search storage", () => {
  it("inicia sin motores disponibles", () => {
    expect(getSearchProviderOrder(
      loadWebSearchSettings(TEST_DIR),
      loadWebSearchAuth(TEST_DIR),
    )).toEqual([]);
    expect(isApiSearchAvailable(TEST_DIR)).toBe(false);
  });

  it("separa la API key de las preferencias y activa el primer motor", () => {
    saveSearchProviderApiKey("tavily", "tvly-secret", TEST_DIR);
    const settings = loadWebSearchSettings(TEST_DIR);
    const auth = loadWebSearchAuth(TEST_DIR);

    expect(auth.apiKeys.tavily).toBe("tvly-secret");
    expect(settings.defaultProvider).toBe("tavily");
    expect(resolveSearchProviderState("tavily", settings, auth).enabled).toBe(true);
    expect(isApiSearchAvailable(TEST_DIR)).toBe(true);
  });

  it("cambia el predeterminado y recupera fallback al deshabilitarlo", () => {
    saveSearchProviderApiKey("exa", "exa-secret", TEST_DIR);
    setDefaultSearchProvider("exa", TEST_DIR);
    expect(loadWebSearchSettings(TEST_DIR).defaultProvider).toBe("exa");

    setSearchProviderEnabled("exa", false, TEST_DIR);
    expect(loadWebSearchSettings(TEST_DIR).defaultProvider).toBe("tavily");
  });

  it("elimina la clave sin tocar los demás motores", () => {
    removeSearchProviderApiKey("tavily", TEST_DIR);
    const auth = loadWebSearchAuth(TEST_DIR);
    expect(auth.apiKeys.tavily).toBeUndefined();
    expect(auth.apiKeys.exa).toBe("exa-secret");
  });
  it("considera api-search no disponible si todas las credenciales están deshabilitadas", () => {
    const isolated = join(TEST_DIR, "availability-disabled");
    mkdirSync(isolated, { recursive: true });
    saveSearchProviderApiKey("brave", "brave-secret", isolated);
    expect(isApiSearchAvailable(isolated)).toBe(true);
    setSearchProviderEnabled("brave", false, isolated);
    expect(isApiSearchAvailable(isolated)).toBe(false);
  });

});
