import { join } from "node:path";
import type { LlmUsageEvent, LlmUsageSource } from "../ai.ts";
import { getAppDir } from "../utils.ts";
import { readJsonFile, sanitizePathSegment, writeJsonFileAtomically } from "../storage.ts";

export interface ContextUsageBreakdownSnapshot {
  timestamp: string;
  model: string;
  maxContextTokens: number;
  effectiveInputBudget: number;
  autoCompactTriggerTokens: number;
  estimatedTotalTokens: number;
  percentOfContext: number;
  percentOfInputBudget: number;
  systemTokens: number;
  conversationTokens: number;
  currentMessageTokens: number;
  toolTokens: number;
  profileMemoryTokens: number;
  vaultMemoryTokens: number;
  compactedSummaryTokens: number;
  supervisorTokens: number;
  otherDynamicTokens: number;
  messageCount: number;
  toolCount: number;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  providerReportedRequests: number;
  estimatedRequests: number;
  mixedRequests: number;
}

export interface UsagePurposeTotals extends UsageTotals {
  purpose: string;
}

export interface StoredUsageRequest extends LlmUsageEvent {}

export interface UsageCompactionStats {
  count: number;
  messagesCompacted: number;
  lastCompactedAt: string | null;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  lastReductionPercent: number;
}

export interface UserUsageData {
  version: 1;
  lifetime: UsageTotals;
  byPurpose: Record<string, UsagePurposeTotals>;
  lastRequest: StoredUsageRequest | null;
  lastContext: ContextUsageBreakdownSnapshot | null;
  compaction: UsageCompactionStats;
  updatedAt: string;
}

function emptyTotals(): UsageTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
    providerReportedRequests: 0,
    estimatedRequests: 0,
    mixedRequests: 0,
  };
}

function emptyData(): UserUsageData {
  return {
    version: 1,
    lifetime: emptyTotals(),
    byPurpose: {},
    lastRequest: null,
    lastContext: null,
    compaction: {
      count: 0,
      messagesCompacted: 0,
      lastCompactedAt: null,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
      lastReductionPercent: 0,
    },
    updatedAt: new Date().toISOString(),
  };
}


function normalizeTotals(value: Partial<UsageTotals> | undefined): UsageTotals {
  const base = emptyTotals();
  if (!value) return base;
  for (const key of Object.keys(base) as Array<keyof UsageTotals>) {
    const candidate = Number(value[key]);
    if (Number.isFinite(candidate) && candidate >= 0) base[key] = Math.round(candidate);
  }
  return base;
}

function sourceCounterKey(source: LlmUsageSource): keyof Pick<UsageTotals, "providerReportedRequests" | "estimatedRequests" | "mixedRequests"> {
  if (source === "provider") return "providerReportedRequests";
  if (source === "mixed") return "mixedRequests";
  return "estimatedRequests";
}

export class UsageStore {
  private readonly cache = new Map<string, UserUsageData>();
  constructor(private readonly rootDir = getAppDir()) {}

  private usagePath(jid: string): string {
    return join(this.rootDir, "persistent", "contexts", sanitizePathSegment(jid), "usage.json");
  }

  get(jid: string): UserUsageData {
    const cached = this.cache.get(jid);
    if (cached) return structuredClone(cached);
    let data = emptyData();
    try {
      const stored = readJsonFile<Partial<UserUsageData>>(this.usagePath(jid));
      if (stored) {
        data = {
          ...data,
          ...stored,
          version: 1,
          lifetime: normalizeTotals(stored.lifetime),
          byPurpose: {},
          compaction: { ...data.compaction, ...(stored.compaction ?? {}) },
        } as UserUsageData;
        for (const [purpose, totals] of Object.entries(stored.byPurpose ?? {})) {
          data.byPurpose[purpose] = { purpose, ...normalizeTotals(totals) };
        }
      }
    } catch {
      data = emptyData();
    }
    this.cache.set(jid, data);
    return structuredClone(data);
  }

  private mutate(jid: string, operation: (data: UserUsageData) => void): UserUsageData {
    const current = this.cache.get(jid) ?? this.get(jid);
    const data = structuredClone(current);
    operation(data);
    data.updatedAt = new Date().toISOString();
    this.cache.set(jid, data);
    writeJsonFileAtomically(this.usagePath(jid), data);
    return structuredClone(data);
  }

  recordLlmRequest(event: LlmUsageEvent): void {
    this.mutate(event.jid, (data) => {
      const add = (totals: UsageTotals): void => {
        totals.promptTokens += event.promptTokens;
        totals.completionTokens += event.completionTokens;
        totals.totalTokens += event.totalTokens;
        totals.requests += 1;
        totals[sourceCounterKey(event.source)] += 1;
      };
      add(data.lifetime);
      const purpose = event.purpose || "chat";
      const purposeTotals = data.byPurpose[purpose] ?? { purpose, ...emptyTotals() };
      add(purposeTotals);
      data.byPurpose[purpose] = purposeTotals;
      data.lastRequest = { ...event };
    });
  }

  recordContext(jid: string, snapshot: ContextUsageBreakdownSnapshot): void {
    this.mutate(jid, (data) => {
      data.lastContext = { ...snapshot };
    });
  }

  recordCompaction(jid: string, options: {
    messagesCompacted: number;
    tokensBefore: number;
    tokensAfter: number;
    timestamp?: string;
  }): void {
    this.mutate(jid, (data) => {
      const before = Math.max(0, Math.round(options.tokensBefore));
      const after = Math.max(0, Math.round(options.tokensAfter));
      data.compaction.count += 1;
      data.compaction.messagesCompacted += Math.max(0, Math.round(options.messagesCompacted));
      data.compaction.lastCompactedAt = options.timestamp ?? new Date().toISOString();
      data.compaction.estimatedTokensBefore = before;
      data.compaction.estimatedTokensAfter = after;
      data.compaction.lastReductionPercent = before > 0
        ? Math.max(0, Math.min(100, ((before - after) / before) * 100))
        : 0;
    });
  }
}
