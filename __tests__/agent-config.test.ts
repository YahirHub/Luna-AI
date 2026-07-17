import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentConfigFlowManager,
  DEFAULT_AGENT_CONFIG,
  loadAgentConfig,
  normalizeAgentConfig,
} from "../src/agent-config.ts";

const TEST_DIR = join(tmpdir(), `luna-agent-config-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("agent config", () => {
  it("normaliza valores y limita el timeout", () => {
    expect(normalizeAgentConfig({
      webSearchEnabled: false,
      researchSubagentEnabled: false,
      defaultSearchDepth: "deep",
      researcherTimeoutMs: 999_999,
    })).toEqual({
      version: 1,
      webSearchEnabled: false,
      researchSubagentEnabled: false,
      defaultSearchDepth: "deep",
      researcherTimeoutMs: 300_000,
    });
  });

  it("usa valores seguros si el archivo no existe", () => {
    expect(loadAgentConfig(join(TEST_DIR, "missing.json"))).toEqual(DEFAULT_AGENT_CONFIG);
  });

  it("guarda cada cambio del flujo y permite salir", () => {
    const path = join(TEST_DIR, "agent-config.json");
    const manager = new AgentConfigFlowManager(path);
    const jid = "admin@s.whatsapp.net";
    manager.start(jid);

    const toggled = manager.submit(jid, "1", { ...DEFAULT_AGENT_CONFIG });
    expect(toggled.config.webSearchEnabled).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(loadAgentConfig(path).webSearchEnabled).toBe(false);

    const done = manager.submit(jid, "0", toggled.config);
    expect(done.done).toBe(true);
    expect(manager.has(jid)).toBe(false);
  });
});
