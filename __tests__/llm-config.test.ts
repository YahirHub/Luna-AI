import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_LLM_CONFIG_FILE,
  ProviderSetupManager,
  buildLlmBaseUrlCandidates,
  deriveLlmEndpointUrls,
  deleteLlmConfig,
  getLlmConfigPath,
  getLlmModelSelectionPath,
  loadGlobalLlmModel,
  loadLlmConfig,
  loadLlmConfigIfPresent,
  saveGlobalLlmModel,
  saveLlmConfig,
} from "../src/llm-config.ts";

const TEST_DIR = join(tmpdir(), `luna-llm-config-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeConfig(name: string, data: unknown): string {
  const path = join(TEST_DIR, name);
  writeFileSync(path, JSON.stringify(data), "utf-8");
  return path;
}

describe("loadLlmConfig", () => {
  it("carga endpoints, modelo predeterminado y API key", () => {
    const path = writeConfig("valid.json", {
      chatCompletionsUrl: "https://api.example.com/v1/chat/completions/",
      modelsUrl: "https://api.example.com/v1/models/",
      defaultModel: "model-main",
      apiKey: "secret-value",
      requestTimeoutMs: 45_000,
    });

    expect(loadLlmConfig(path)).toEqual({
      chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
      modelsUrl: "https://api.example.com/v1/models",
      defaultModel: "model-main",
      apiKey: "secret-value",
      requestTimeoutMs: 45_000,
    });
  });

  it("usa timeout seguro cuando no está definido", () => {
    const path = writeConfig("default-timeout.json", {
      chatCompletionsUrl: "https://api.example.com/chat/completions",
      modelsUrl: "https://api.example.com/models",
      defaultModel: "model-main",
      apiKey: "",
    });

    expect(loadLlmConfig(path).requestTimeoutMs).toBe(60_000);
  });

  it("retorna null cuando el administrador aún no configura el proveedor", () => {
    expect(loadLlmConfigIfPresent(join(TEST_DIR, "missing.json"))).toBeNull();
  });

  it("rechaza API keys con tipos inválidos", () => {
    const path = writeConfig("invalid-key.json", {
      chatCompletionsUrl: "https://api.example.com/chat/completions",
      modelsUrl: "https://api.example.com/models",
      defaultModel: "model-main",
      apiKey: 123,
    });

    expect(() => loadLlmConfig(path)).toThrow();
  });

  it("rechaza URLs y modelos inválidos", () => {
    const path = writeConfig("invalid.json", {
      chatCompletionsUrl: "file:///tmp/chat",
      modelsUrl: "https://api.example.com/models",
      defaultModel: "",
    });

    expect(() => loadLlmConfig(path)).toThrow();
  });
});

describe("saveLlmConfig", () => {
  it("genera llm.config.json de forma atómica", () => {
    const path = join(TEST_DIR, "persistent", "llm.config.json");
    const saved = saveLlmConfig(
      {
        chatCompletionsUrl: "https://api.example.com/v1/chat/completions/",
        modelsUrl: "https://api.example.com/v1/models/",
        defaultModel: "default-model",
        apiKey: "secret",
        requestTimeoutMs: 30_000,
      },
      path,
    );

    expect(existsSync(path)).toBe(true);
    expect(loadLlmConfig(path)).toEqual(saved);
  });
});

describe("deleteLlmConfig", () => {
  it("elimina solo la configuración personalizada existente", () => {
    const path = writeConfig("delete-me.json", {
      chatCompletionsUrl: "https://api.example.com/chat",
      modelsUrl: "https://api.example.com/models",
      defaultModel: "model-main",
      apiKey: "",
    });

    expect(deleteLlmConfig(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(deleteLlmConfig(path)).toBe(false);
  });
});

describe("getLlmConfigPath", () => {
  it("usa persistent/llm.config.json por defecto", () => {
    expect(getLlmConfigPath(["bun", "src/index.ts"])).toBe(
      resolve(process.cwd(), DEFAULT_LLM_CONFIG_FILE),
    );
  });

  it("rechaza --llm-config sin ruta", () => {
    expect(() =>
      getLlmConfigPath(["bun", "src/index.ts", "--llm-config"]),
    ).toThrow();
  });

  it("acepta valor separado o inline", () => {
    expect(
      getLlmConfigPath(["bun", "src/index.ts", "--llm-config", "custom.json"]),
    ).toBe(resolve(process.cwd(), "custom.json"));
    expect(
      getLlmConfigPath(["bun", "src/index.ts", "--llm-config=prod.json"]),
    ).toBe(resolve(process.cwd(), "prod.json"));
  });
});

describe("Llm endpoint inference", () => {
  it("deriva /models y /chat/completions desde una URL base /v1", () => {
    expect(deriveLlmEndpointUrls("https://api.example.com/v1")).toEqual({
      baseUrl: "https://api.example.com/v1",
      chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
      modelsUrl: "https://api.example.com/v1/models",
    });
  });

  it("recupera la base si el administrador pega un endpoint completo", () => {
    expect(deriveLlmEndpointUrls("https://api.example.com/v1/chat/completions").baseUrl)
      .toBe("https://api.example.com/v1");
    expect(deriveLlmEndpointUrls("https://api.example.com/v1/models").baseUrl)
      .toBe("https://api.example.com/v1");
  });

  it("asume /v1 y conserva la raíz como fallback cuando solo recibe el dominio", () => {
    expect(buildLlmBaseUrlCandidates("https://api.example.com")).toEqual([
      "https://api.example.com/v1",
      "https://api.example.com",
    ]);
  });
});



describe("selección global de modelo", () => {
  it("persiste el modelo global junto al provider actual", () => {
    const configPath = join(TEST_DIR, "global-model", "llm.config.json");
    const config = {
      chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
      modelsUrl: "https://api.example.com/v1/models",
      defaultModel: "model-b",
      apiKey: "",
      requestTimeoutMs: 60_000,
    };

    saveGlobalLlmModel(config, configPath);

    expect(getLlmModelSelectionPath(configPath)).toBe(
      join(TEST_DIR, "global-model", "llm.model.json"),
    );
    expect(loadGlobalLlmModel(config.modelsUrl, configPath)).toBe("model-b");
  });

  it("no reutiliza el modelo global de un provider distinto", () => {
    const configPath = join(TEST_DIR, "provider-switch", "llm.config.json");
    saveGlobalLlmModel(
      {
        modelsUrl: "https://old.example.com/v1/models",
        defaultModel: "old-model",
      },
      configPath,
    );

    expect(
      loadGlobalLlmModel("https://new.example.com/v1/models", configPath),
    ).toBeNull();
  });
});

describe("ProviderSetupManager", () => {
  it("configura URL base, API key y modelo por selección numérica", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin@s.whatsapp.net";

    setup.start(jid);
    expect(setup.getStep(jid)).toBe("baseUrl");
    expect(setup.submit(jid, "https://api.example.com/v1")).toEqual({
      kind: "next",
      nextStep: "apiKey",
    });

    expect(setup.submit(jid, "secret-key")).toEqual({
      kind: "discover-models",
      secretInput: true,
    });
    expect(setup.getDiscoveryDraft(jid)).toEqual({
      baseUrlCandidates: ["https://api.example.com/v1"],
      apiKey: "secret-key",
      requestTimeoutMs: 60_000,
    });

    setup.setDiscoveredModels(jid, "https://api.example.com/v1", [
      "vendor/model-a",
      "vendor/model-b",
    ]);
    expect(setup.getStep(jid)).toBe("defaultModel");

    const result = setup.submit(jid, "2");
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.config).toEqual({
        chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
        modelsUrl: "https://api.example.com/v1/models",
        defaultModel: "vendor/model-b",
        apiKey: "secret-key",
        requestTimeoutMs: 60_000,
      });
    }
  });

  it("acepta que la URL base venga dentro de una frase y normaliza endpoints pegados por error", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin-natural-fields@s.whatsapp.net";

    setup.start(jid);
    expect(setup.submit(jid, "Mi proveedor está en https://api.example.com/v1/models")).toEqual({
      kind: "next",
      nextStep: "apiKey",
    });
    setup.submit(jid, "sin-clave");
    expect(setup.getDiscoveryDraft(jid).baseUrlCandidates[0]).toBe("https://api.example.com/v1");
  });

  it("extrae la API key cuando el administrador la envía dentro de una frase natural", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin-natural@s.whatsapp.net";

    setup.start(jid);
    setup.submit(jid, "https://api.example.com/v1");
    const result = setup.submit(jid, "Esta es mi API key: sk-natural-secret");

    expect(result).toEqual({
      kind: "discover-models",
      secretInput: true,
    });
    expect(setup.getDiscoveryDraft(jid).apiKey).toBe("sk-natural-secret");
  });

  it("acepta sin-clave y conserva el timeout previo", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin2@s.whatsapp.net";

    setup.start(jid, {
      chatCompletionsUrl: "https://old.example.com/v1/chat/completions",
      modelsUrl: "https://old.example.com/v1/models",
      defaultModel: "old-model",
      apiKey: "old-key",
      requestTimeoutMs: 15_000,
    });
    setup.submit(jid, "https://new.example.com/v1");
    expect(setup.submit(jid, "sin-clave")).toEqual({
      kind: "discover-models",
      secretInput: false,
    });
    expect(setup.getDiscoveryDraft(jid).requestTimeoutMs).toBe(15_000);
    expect(setup.getDiscoveryDraft(jid).apiKey).toBe("");
  });

  it("rechaza selecciones fuera del catálogo y conserva el paso", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin-model@s.whatsapp.net";
    setup.start(jid);
    setup.submit(jid, "https://api.example.com/v1");
    setup.submit(jid, "sin-clave");
    setup.setDiscoveredModels(jid, "https://api.example.com/v1", ["model-a"]);

    expect(() => setup.submit(jid, "2")).toThrow("Número inválido");
    expect(setup.getStep(jid)).toBe("defaultModel");
  });

  it("mantiene el paso actual cuando una URL es inválida", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin3@s.whatsapp.net";
    setup.start(jid);

    expect(() => setup.submit(jid, "no-es-url")).toThrow();
    expect(setup.getStep(jid)).toBe("baseUrl");
  });

  it("permite reiniciar el flujo a URL base tras un fallo de descubrimiento", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin-reset@s.whatsapp.net";
    setup.start(jid);
    setup.submit(jid, "https://api.example.com/v1");
    setup.submit(jid, "secret");
    setup.resetToBaseUrl(jid);

    expect(setup.getStep(jid)).toBe("baseUrl");
    expect(() => setup.getDiscoveryDraft(jid)).toThrow();
  });

  it("permite cancelar el flujo", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin4@s.whatsapp.net";
    setup.start(jid);
    setup.cancel(jid);
    expect(setup.has(jid)).toBe(false);
  });
});
