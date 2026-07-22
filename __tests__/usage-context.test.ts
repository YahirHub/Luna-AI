import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../src/usage/usage-store.ts";
import { buildContextUsageSnapshot } from "../src/usage/context-usage.ts";
import { renderUsageCard } from "../src/usage/usage-card.ts";
import { ContextManager } from "../src/context.ts";
import { estimateTokensAccurate, type ChatMessage } from "../src/ai.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = join(tmpdir(), `luna-usage-${Date.now()}-${crypto.randomUUID()}`);
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("UsageStore", () => {
  it("mezcla métricas reales y estimadas sin depender de usage del provider", () => {
    const store = new UsageStore(tempRoot());
    store.recordLlmRequest({
      jid: "user@lid", model: "modelo", purpose: "chat", source: "provider",
      promptTokens: 100, completionTokens: 20, totalTokens: 120,
      providerPromptTokens: 100, providerCompletionTokens: 20, providerTotalTokens: 120,
      estimatedPromptTokens: 95, estimatedCompletionTokens: 18, timestamp: new Date().toISOString(),
    });
    store.recordLlmRequest({
      jid: "user@lid", model: "modelo", purpose: "chat", source: "estimated",
      promptTokens: 80, completionTokens: 10, totalTokens: 90,
      estimatedPromptTokens: 80, estimatedCompletionTokens: 10, timestamp: new Date().toISOString(),
    });
    const data = store.get("user@lid");
    expect(data.lifetime.promptTokens).toBe(180);
    expect(data.lifetime.completionTokens).toBe(30);
    expect(data.lifetime.requests).toBe(2);
    expect(data.lifetime.providerReportedRequests).toBe(1);
    expect(data.lifetime.estimatedRequests).toBe(1);
  });
});

describe("context usage", () => {
  it("desglosa tools, conversación y memoria sin superar el total estimado", () => {
    const persisted: ChatMessage[] = [
      { role: "system", content: "sistema" },
      { role: "user", content: "hola" },
    ];
    const apiMessages: ChatMessage[] = [
      persisted[0]!,
      { role: "user", content: "memoria resumen supervisor hola" },
    ];
    const snapshot = buildContextUsageSnapshot({
      model: "unknown-model",
      persistedMessages: persisted,
      apiMessages,
      tools: [{ type: "function", function: { name: "demo", description: "demo", parameters: { type: "object", properties: {} } } }],
      rawCurrentMessage: "hola",
      profileMemory: "memoria",
      vaultContext: "",
      compactedSummary: "resumen",
      supervisorContext: "supervisor",
    });
    expect(snapshot.estimatedTotalTokens).toBeGreaterThan(0);
    expect(snapshot.toolTokens).toBeGreaterThan(0);
    expect(snapshot.maxContextTokens).toBeGreaterThan(snapshot.estimatedTotalTokens);
  });

  it("genera una tarjeta PNG válida", () => {
    const store = new UsageStore(tempRoot());
    const ctx = buildContextUsageSnapshot({
      model: "unknown-model",
      persistedMessages: [{ role: "system", content: "sistema" }, { role: "user", content: "hola" }],
      apiMessages: [{ role: "system", content: "sistema" }, { role: "user", content: "hola" }],
      tools: [], rawCurrentMessage: "hola", profileMemory: "", vaultContext: "", compactedSummary: "", supervisorContext: "",
    });
    const png = renderUsageCard(store.get("user"), ctx);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.length).toBeGreaterThan(1000);
  });
});

describe("compactación por snapshot", () => {
  it("preserva mensajes agregados mientras se genera el resumen", () => {
    const root = tempRoot();
    const oldCwd = process.cwd();
    process.chdir(root);
    try {
      const cm = new ContextManager("modelo");
      const jid = "snapshot@lid";
      cm.addMessage(jid, { role: "user", content: "mensaje antiguo" });
      cm.addMessage(jid, { role: "assistant", content: "respuesta antigua" });
      const snapshot = structuredClone(cm.getMessages(jid));
      cm.addMessage(jid, { role: "user", content: "mensaje llegado durante compactación" });
      const kept = [snapshot[0]!, snapshot[snapshot.length - 1]!];
      const applied = cm.applyCompactionSnapshot(jid, snapshot, kept, {
        durableFacts: [], preferences: [], currentTopics: [], verifiedToolActions: [], unverifiedClaims: [], pendingTasks: [], decisions: [], importantConstraints: [], recentState: "ok", unresolvedQuestions: [],
      }, estimateTokensAccurate(snapshot), snapshot.length - kept.length, estimateTokensAccurate);
      expect(applied.applied).toBe(true);
      expect(applied.appendedMessages).toBe(1);
      expect(cm.getMessages(jid).at(-1)?.content).toContain("durante compactación");
    } finally {
      process.chdir(oldCwd);
    }
  });
});
