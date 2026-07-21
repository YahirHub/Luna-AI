import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_LLM_CONFIG_FILE,
  ProviderSetupManager,
  deleteLlmConfig,
  getLlmConfigPath,
  loadLlmConfig,
  loadLlmConfigIfPresent,
  saveGlobalLlmModel,
  loadGlobalLlmModel,
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

describe("ProviderSetupManager", () => {
  it("deriva endpoints, descubre catálogo y selecciona modelo por número", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin@s.whatsapp.net";

    setup.start(jid);
    expect(setup.getStep(jid)).toBe("chatCompletionsUrl");
    expect(setup.submit(jid, "https://api.example.com/v1")).toEqual({
      completed: false,
      nextStep: "apiKey",
    });
    const apiResult = setup.submit(jid, "secret-key");
    expect(apiResult.completed).toBe(false);
    if (!apiResult.completed) {
      expect(apiResult.nextStep).toBe("defaultModel");
      expect(apiResult.secretInput).toBe(true);
      expect(apiResult.discover?.candidates[0]).toEqual({
        baseUrl: "https://api.example.com/v1",
        chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
        modelsUrl: "https://api.example.com/v1/models",
      });
    }
    setup.setDiscoveredModels(jid, {
      baseUrl: "https://api.example.com/v1",
      chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
      modelsUrl: "https://api.example.com/v1/models",
    }, ["vendor/model-a", "vendor/model-main"]);
    const result = setup.submit(jid, "2");
    expect(result.completed).toBe(true);
    if (result.completed) {
      expect(result.config).toEqual({
        chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
        modelsUrl: "https://api.example.com/v1/models",
        defaultModel: "vendor/model-main",
        apiKey: "secret-key",
        requestTimeoutMs: 60_000,
      });
    }
  });

  it("acepta dominio sin /v1 y recupera la base desde endpoints pegados", () => {
    const setup = new ProviderSetupManager();
    setup.start("root@s.whatsapp.net");
    const first = setup.submit("root@s.whatsapp.net", "Proveedor https://api.example.com/chat/completions");
    expect(first).toEqual({ completed: false, nextStep: "apiKey" });
    const key = setup.submit("root@s.whatsapp.net", "sin-clave");
    expect(key.completed).toBe(false);
    if (!key.completed) {
      expect(key.discover?.candidates.map((item) => item.baseUrl)).toEqual([
        "https://api.example.com/v1",
        "https://api.example.com",
      ]);
    }
  });

  it("persiste un modelo global ligado al catálogo del provider", () => {
    const path = join(TEST_DIR, "global", "llm.config.json");
    const config = {
      chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
      modelsUrl: "https://api.example.com/v1/models",
      defaultModel: "model-b",
      apiKey: "",
      requestTimeoutMs: 60_000,
    };
    saveGlobalLlmModel(config, path);
    expect(loadGlobalLlmModel(config.modelsUrl, path)).toBe("model-b");
    expect(loadGlobalLlmModel("https://other.example/v1/models", path)).toBeNull();
  });
});
