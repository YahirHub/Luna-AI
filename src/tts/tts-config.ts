import { join } from "node:path";
import { getAppDir } from "../utils.ts";
import { readJsonFile, sanitizePathSegment, writeJsonFileAtomically } from "../storage.ts";

export type TtsVoiceSelection =
  | { kind: "official"; id: string }
  | { kind: "neo"; id: string; path: string }
  | { kind: "manual"; id: string; path: string; configPath?: string; format: "neo" | "onnx" };

export type TtsResponseMode = "adaptive" | "voice" | "text";

export interface UserTtsConfig {
  version: 2;
  responseMode: TtsResponseMode;
  selectedVoice: TtsVoiceSelection | null;
  speakerId?: number;
  lengthScale: number;
  noiseScale: number;
  noiseWScale: number;
  ptt: boolean;
  updatedAt: string;
}

export function defaultTtsConfig(): UserTtsConfig {
  return {
    version: 2,
    responseMode: "adaptive",
    selectedVoice: null,
    lengthScale: 1,
    noiseScale: 0.667,
    noiseWScale: 0.8,
    ptt: true,
    updatedAt: new Date().toISOString(),
  };
}

export function getUserTtsConfigPath(jid: string, root = getAppDir()): string {
  return join(root, "persistent", "contexts", sanitizePathSegment(jid), "tts.json");
}

function responseModeFromLegacy(value: Record<string, unknown>): TtsResponseMode {
  if (value.responseMode === "adaptive" || value.responseMode === "voice" || value.responseMode === "text") {
    return value.responseMode;
  }
  // Configs v1: enabled=true significaba siempre voz. El estado predeterminado
  // enabled=false migra a adaptativo para habilitar decisiones por turno.
  return value.enabled === true ? "voice" : "adaptive";
}

export function loadUserTtsConfig(jid: string, root = getAppDir()): UserTtsConfig {
  const value = readJsonFile<Record<string, unknown>>(getUserTtsConfigPath(jid, root)) ?? {};
  const base = defaultTtsConfig();
  const selected = value.selectedVoice;
  const selectedVoice = selected && typeof selected === "object" && ((selected as { kind?: unknown }).kind === "official" || (selected as { kind?: unknown }).kind === "neo" || (selected as { kind?: unknown }).kind === "manual")
    ? selected as TtsVoiceSelection
    : null;
  return {
    version: 2,
    responseMode: responseModeFromLegacy(value),
    selectedVoice,
    speakerId: typeof value.speakerId === "number" && Number.isInteger(value.speakerId) && value.speakerId >= 0 ? value.speakerId : undefined,
    lengthScale: typeof value.lengthScale === "number" && Number.isFinite(value.lengthScale) ? Math.min(4, Math.max(0.25, value.lengthScale)) : base.lengthScale,
    noiseScale: typeof value.noiseScale === "number" && Number.isFinite(value.noiseScale) ? Math.min(2, Math.max(0, value.noiseScale)) : base.noiseScale,
    noiseWScale: typeof value.noiseWScale === "number" && Number.isFinite(value.noiseWScale) ? Math.min(2, Math.max(0, value.noiseWScale)) : base.noiseWScale,
    ptt: value.ptt !== false,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : base.updatedAt,
  };
}

export function saveUserTtsConfig(jid: string, patch: Partial<UserTtsConfig>, root = getAppDir()): UserTtsConfig {
  const next: UserTtsConfig = {
    ...loadUserTtsConfig(jid, root),
    ...patch,
    version: 2,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFileAtomically(getUserTtsConfigPath(jid, root), next);
  return next;
}
