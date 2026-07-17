import type { LlmConfig } from "../llm-config.ts";

/** Identificador interno del proveedor gratuito incluido con Luna. */
export const OPENCODE_FREE_PROVIDER_ID = "opencode-free";
export const OPENCODE_FREE_PROVIDER_NAME = "OpenCode Free";

/** Endpoints públicos compatibles con OpenAI usados por los modelos gratuitos. */
export const OPENCODE_FREE_CHAT_COMPLETIONS_URL =
  "https://opencode.ai/zen/v1/chat/completions";
export const OPENCODE_FREE_MODELS_URL = "https://opencode.ai/zen/v1/models";

/** Modelo inicial cuando todavía no se ha podido consultar el catálogo remoto. */
export const OPENCODE_FREE_DEFAULT_MODEL = "deepseek-v4-flash-free";

/**
 * Catálogo local de emergencia. El endpoint remoto sigue siendo la fuente de
 * verdad; esta lista solo evita dejar Luna inutilizable durante una caída.
 */
export const OPENCODE_FREE_FALLBACK_MODELS = [
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
] as const;

export interface OpenCodeFreeModelLimit {
  /** Coincidencia parcial, insensible a mayúsculas. */
  pattern: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  description: string;
}

/**
 * Límites expuestos actualmente por el gateway para sus modelos gratuitos.
 * Los modelos desconocidos usan los límites conservadores de src/models.ts.
 */
export const OPENCODE_FREE_MODEL_LIMITS: readonly OpenCodeFreeModelLimit[] = [
  {
    pattern: "deepseek-v4-flash-free",
    maxContextTokens: 200_000,
    maxOutputTokens: 128_000,
    description: "OpenCode Free · DeepSeek V4 Flash",
  },
  {
    pattern: "mimo-v2.5-free",
    maxContextTokens: 200_000,
    maxOutputTokens: 32_000,
    description: "OpenCode Free · MiMo V2.5",
  },
  {
    pattern: "hy3-free",
    maxContextTokens: 190_000,
    maxOutputTokens: 64_000,
    description: "OpenCode Free · HY3",
  },
  {
    pattern: "nemotron-3-ultra-free",
    maxContextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    description: "OpenCode Free · Nemotron 3 Ultra",
  },
  {
    pattern: "north-mini-code-free",
    maxContextTokens: 256_000,
    maxOutputTokens: 64_000,
    description: "OpenCode Free · North Mini Code",
  },
];

/** Configuración integrada usada cuando no existe un proveedor personalizado. */
export function createOpenCodeFreeConfig(): LlmConfig {
  return {
    chatCompletionsUrl: OPENCODE_FREE_CHAT_COMPLETIONS_URL,
    modelsUrl: OPENCODE_FREE_MODELS_URL,
    defaultModel: OPENCODE_FREE_DEFAULT_MODEL,
    apiKey: "",
    requestTimeoutMs: 60_000,
  };
}

/** OpenCode marca sus modelos gratuitos públicos con el sufijo -free. */
export function isOpenCodeFreeModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().endsWith("-free");
}

/**
 * Conserva únicamente modelos gratuitos, elimina duplicados y mantiene el
 * modelo predeterminado como primera opción.
 */
export function filterOpenCodeFreeModels(modelIds: readonly string[]): string[] {
  const filtered = [...new Set(
    modelIds
      .map((modelId) => modelId.trim())
      .filter((modelId) => modelId !== "" && isOpenCodeFreeModel(modelId)),
  )].sort((left, right) => left.localeCompare(right));

  if (!filtered.includes(OPENCODE_FREE_DEFAULT_MODEL)) {
    return filtered;
  }

  return [
    OPENCODE_FREE_DEFAULT_MODEL,
    ...filtered.filter((modelId) => modelId !== OPENCODE_FREE_DEFAULT_MODEL),
  ];
}

/** Devuelve un catálogo local seguro cuando el endpoint no está disponible. */
export function getOpenCodeFreeFallbackModels(): string[] {
  return [...OPENCODE_FREE_FALLBACK_MODELS];
}

/** Busca límites por coincidencia parcial del ID del modelo. */
export function findOpenCodeFreeModelLimit(
  modelId: string,
): OpenCodeFreeModelLimit | null {
  const normalized = modelId.trim().toLowerCase();
  return (
    OPENCODE_FREE_MODEL_LIMITS.find((entry) =>
      normalized.includes(entry.pattern.toLowerCase()),
    ) ?? null
  );
}
