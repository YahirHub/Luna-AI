import type { ChatMessage, ToolDefinition } from "../ai.ts";
import { estimateMessageTokens, estimateRequestTokens, estimateToolTokens } from "../compaction.ts";
import { estimateTextTokens } from "../ai.ts";
import { modelCatalog } from "../models.ts";
import type { ContextUsageBreakdownSnapshot } from "./usage-store.ts";

export interface BuildContextUsageOptions {
  model: string;
  persistedMessages: ChatMessage[];
  apiMessages: ChatMessage[];
  tools: ToolDefinition[];
  rawCurrentMessage: string;
  profileMemory: string;
  vaultContext: string;
  compactedSummary: string;
  supervisorContext: string;
}

export function buildContextUsageSnapshot(options: BuildContextUsageOptions): ContextUsageBreakdownSnapshot {
  const { model, persistedMessages, apiMessages, tools } = options;
  const systemTokens = persistedMessages[0]?.role === "system" ? estimateMessageTokens(persistedMessages[0]) : 0;
  const currentMessageTokens = estimateTextTokens(options.rawCurrentMessage) + 8;
  const historicMessages = persistedMessages.slice(1, Math.max(1, persistedMessages.length - 1));
  const conversationTokens = historicMessages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  const toolTokens = estimateToolTokens(tools);
  const profileMemoryTokens = estimateTextTokens(options.profileMemory);
  const vaultMemoryTokens = estimateTextTokens(options.vaultContext);
  const compactedSummaryTokens = estimateTextTokens(options.compactedSummary);
  const supervisorTokens = estimateTextTokens(options.supervisorContext);
  const estimatedTotalTokens = estimateRequestTokens(apiMessages, tools);
  const accounted = systemTokens + conversationTokens + currentMessageTokens + toolTokens + profileMemoryTokens
    + vaultMemoryTokens + compactedSummaryTokens + supervisorTokens;
  const otherDynamicTokens = Math.max(0, estimatedTotalTokens - accounted);
  const info = modelCatalog.getModelInfo(model);
  const effectiveInputBudget = modelCatalog.getEffectiveBudget(model, toolTokens);
  const autoCompactTriggerTokens = Math.floor(effectiveInputBudget * 0.85);

  return {
    timestamp: new Date().toISOString(),
    model,
    maxContextTokens: info.maxContextTokens,
    effectiveInputBudget,
    autoCompactTriggerTokens,
    estimatedTotalTokens,
    percentOfContext: info.maxContextTokens > 0 ? (estimatedTotalTokens / info.maxContextTokens) * 100 : 0,
    percentOfInputBudget: effectiveInputBudget > 0 ? (estimatedTotalTokens / effectiveInputBudget) * 100 : 0,
    systemTokens,
    conversationTokens,
    currentMessageTokens,
    toolTokens,
    profileMemoryTokens,
    vaultMemoryTokens,
    compactedSummaryTokens,
    supervisorTokens,
    otherDynamicTokens,
    messageCount: persistedMessages.length,
    toolCount: tools.length,
  };
}
