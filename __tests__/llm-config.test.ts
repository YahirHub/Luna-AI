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
  it("construye la configuración en cuatro pasos sin filtrar modelos", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin@s.whatsapp.net";

    setup.start(jid);
    expect(setup.getStep(jid)).toBe("chatCompletionsUrl");
    expect(setup.submit(jid, "https://api.example.com/v1/chat/completions")).toEqual({
      completed: false,
      nextStep: "modelsUrl",
    });
    expect(setup.submit(jid, "https://api.example.com/v1/models")).toEqual({
      completed: false,
      nextStep: "defaultModel",
    });
    expect(setup.submit(jid, "vendor/model-main")).toEqual({
      completed: false,
      nextStep: "apiKey",
    });

    const result = setup.submit(jid, "secret-key");
    expect(result.completed).toBe(true);
    if (result.completed) {
      expect(result.config).toEqual({
        chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
        modelsUrl: "https://api.example.com/v1/models",
        defaultModel: "vendor/model-main",
        apiKey: "secret-key",
        requestTimeoutMs: 60_000,
      });
      expect(result.secretInput).toBe(true);
    }
  });

  it("acepta URLs y modelo expresados dentro de frases naturales", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin-natural-fields@s.whatsapp.net";

    setup.start(jid);
    expect(setup.submit(jid, "El endpoint de chat es https://api.example.com/v1/chat/completions")).toEqual({
      completed: false,
      nextStep: "modelsUrl",
    });
    expect(setup.submit(jid, "El catálogo está en https://api.example.com/v1/models")).toEqual({
      completed: false,
      nextStep: "defaultModel",
    });
    expect(setup.submit(jid, "Usa el modelo vendor/model-main")).toEqual({
      completed: false,
      nextStep: "apiKey",
    });
    const result = setup.submit(jid, "sin-clave");

    expect(result.completed).toBe(true);
    if (result.completed) {
      expect(result.config.chatCompletionsUrl).toBe("https://api.example.com/v1/chat/completions");
      expect(result.config.modelsUrl).toBe("https://api.example.com/v1/models");
      expect(result.config.defaultModel).toBe("vendor/model-main");
    }
  });

  it("extrae la API key cuando el administrador la envía dentro de una frase natural", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin-natural@s.whatsapp.net";

    setup.start(jid);
    setup.submit(jid, "https://api.example.com/v1/chat/completions");
    setup.submit(jid, "https://api.example.com/v1/models");
    setup.submit(jid, "vendor/model-main");
    const result = setup.submit(jid, "Esta es mi API key: sk-natural-secret");

    expect(result.completed).toBe(true);
    if (result.completed) {
      expect(result.config.apiKey).toBe("sk-natural-secret");
      expect(result.secretInput).toBe(true);
    }
  });

  it("acepta sin-clave y conserva el timeout previo", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin2@s.whatsapp.net";

    setup.start(jid, {
      chatCompletionsUrl: "https://old.example.com/chat",
      modelsUrl: "https://old.example.com/models",
      defaultModel: "old-model",
      apiKey: "old-key",
      requestTimeoutMs: 15_000,
    });
    setup.submit(jid, "https://new.example.com/chat");
    setup.submit(jid, "https://new.example.com/models");
    setup.submit(jid, "new-model");
    const result = setup.submit(jid, "sin-clave");

    expect(result.completed).toBe(true);
    if (result.completed) {
      expect(result.config.apiKey).toBe("");
      expect(result.config.requestTimeoutMs).toBe(15_000);
      expect(result.secretInput).toBe(false);
    }
  });

  it("mantiene el paso actual cuando una URL es inválida", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin3@s.whatsapp.net";
    setup.start(jid);

    expect(() => setup.submit(jid, "no-es-url")).toThrow();
    expect(setup.getStep(jid)).toBe("chatCompletionsUrl");
  });

  it("permite cancelar el flujo", () => {
    const setup = new ProviderSetupManager();
    const jid = "admin4@s.whatsapp.net";
    setup.start(jid);
    setup.cancel(jid);
    expect(setup.has(jid)).toBe(false);
  });
});
