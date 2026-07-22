import { afterEach, describe, expect, it } from "bun:test";
import { chatCompletion, setLlmUsageObserver, type LlmUsageEvent } from "../src/ai.ts";
import type { LlmConfig } from "../src/llm-config.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setLlmUsageObserver(null);
});

const config: LlmConfig = {
  modelsUrl: "https://example.test/models",
  chatCompletionsUrl: "https://example.test/chat/completions",
  apiKey: "test",
  defaultModel: "modelo",
  requestTimeoutMs: 5_000,
};

describe("métricas opcionales del provider", () => {
  it("usa usage real cuando existe", async () => {
    const events: LlmUsageEvent[] = [];
    setLlmUsageObserver((event) => { events.push(event); });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await chatCompletion([{ role: "user", content: "hola" }], "modelo", config, 1, 100, { jid: "u", purpose: "chat" });
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("provider");
    expect(events[0]?.promptTokens).toBe(50);
    expect(events[0]?.completionTokens).toBe(7);
  });

  it("cae al estimador cuando usage no existe", async () => {
    const events: LlmUsageEvent[] = [];
    setLlmUsageObserver((event) => { events.push(event); });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "respuesta estimada" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await chatCompletion([{ role: "user", content: "hola mundo" }], "modelo", config, 1, 100, { jid: "u", purpose: "chat" });
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("estimated");
    expect(events[0]?.promptTokens).toBeGreaterThan(0);
    expect(events[0]?.completionTokens).toBeGreaterThan(0);
  });

  it("acepta métricas parciales y completa el resto", async () => {
    const events: LlmUsageEvent[] = [];
    setLlmUsageObserver((event) => { events.push(event); });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { input_tokens: 33 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await chatCompletion([{ role: "user", content: "hola" }], "modelo", config, 1, 100, { jid: "u", purpose: "chat" });
    expect(events[0]?.source).toBe("mixed");
    expect(events[0]?.promptTokens).toBe(33);
    expect(events[0]?.completionTokens).toBeGreaterThan(0);
  });
});
