/**
 * Catálogo de modelos con límites de tokens de contexto.
 *
 * Cada entrada puede ser un nombre exacto o un patrón (terminación en "*").
 * Los modelos que no coincidan con ninguna entrada usan el valor por defecto.
 */

// ─── Tipos ───────────────────────────────────────────────────────

export interface ModelInfo {
  /** Nombre/PATRON del modelo (ej: "deepseek-v4-flash-free", "openai/*"). */
  pattern: string;
  /** Ventana de contexto máxima del modelo en tokens. */
  maxContextTokens: number;
  /** Tokens reservados para la respuesta del modelo. */
  maxOutputTokens: number;
  /** Descripción opcional. */
  description?: string;
}

// ─── Catálogo incorporado ────────────────────────────────────────

const BUILTIN_CATALOG: ModelInfo[] = [
  // DeepSeek
  { pattern: "deepseek-*",    maxContextTokens: 120_000, maxOutputTokens: 8_000, description: "DeepSeek (límite reducido de 1M a 120k para ahorrar)" },
  // Modelos gratuitos de OpenCode / similares
  { pattern: "*-free",       maxContextTokens: 120_000, maxOutputTokens: 8_000, description: "Modelo gratuito" },
  // OpenAI
  { pattern: "openai/*",     maxContextTokens: 120_000, maxOutputTokens: 8_000, description: "OpenAI (límite por defecto)" },
  // Anthropic
  { pattern: "anthropic/*",  maxContextTokens: 120_000, maxOutputTokens: 8_000, description: "Anthropic (límite por defecto)" },
  // Google
  { pattern: "google/*",     maxContextTokens: 120_000, maxOutputTokens: 8_000, description: "Google (límite por defecto)" },
  // Groq
  { pattern: "groq/*",       maxContextTokens: 120_000, maxOutputTokens: 8_000, description: "Groq (límite por defecto)" },
  // Cualquier otro modelo (catch-all)
  { pattern: "*",            maxContextTokens: 120_000, maxOutputTokens: 8_000, description: "Valor por defecto para modelos no listados" },
];

export const DEFAULT_CONTEXT_TOKENS = 120_000;
export const DEFAULT_OUTPUT_TOKENS = 8_000;

// ─── ModelCatalog ─────────────────────────────────────────────────

export class ModelCatalog {
  private entries: ModelInfo[];

  constructor(overrides?: ModelInfo[]) {
    this.entries = overrides && overrides.length > 0 ? overrides : [...BUILTIN_CATALOG];
  }

  /**
   * Busca la entrada que mejor coincida con un nombre de modelo.
   * Primero busca coincidencia exacta, luego patrones con "*".
   */
  private findEntry(modelId: string): ModelInfo | null {
    // 1. Coincidencia exacta
    const exact = this.entries.find((e) => e.pattern === modelId);
    if (exact) return exact;

    // 2. Patrones con "*" al final (prefijo)
    const prefixMatches = this.entries.filter(
      (e) => e.pattern.endsWith("*") && modelId.startsWith(e.pattern.slice(0, -1)),
    );
    if (prefixMatches.length > 0) {
      // Entre los que coinciden, elegir el más específico (prefijo más largo)
      prefixMatches.sort(
        (a, b) => b.pattern.length - a.pattern.length,
      );
      return prefixMatches[0]!;
    }

    // 3. Patrones con "*" al inicio (sufijo, ej: "*-free")
    const suffixMatches = this.entries.filter(
      (e) => e.pattern.startsWith("*") && modelId.endsWith(e.pattern.slice(1)),
    );
    if (suffixMatches.length > 0) {
      suffixMatches.sort(
        (a, b) => b.pattern.length - a.pattern.length,
      );
      return suffixMatches[0]!;
    }

    // 4. Patrón comodín "*" (si no se encontró antes)
    return this.entries.find((e) => e.pattern === "*") ?? null;
  }

  /**
   * Obtiene la información de contexto para un modelo específico.
   * El catch-all "*" siempre coincide, así que esto nunca falla.
   */
  getModelInfo(modelId: string): ModelInfo {
    const entry = this.findEntry(modelId);
    if (entry) return entry;

    return {
      pattern: modelId,
      maxContextTokens: DEFAULT_CONTEXT_TOKENS,
      maxOutputTokens: DEFAULT_OUTPUT_TOKENS,
      description: "Fallback para modelo no reconocido",
    };
  }

  /**
   * Calcula el presupuesto efectivo de tokens de entrada.
   * Fórmula: maxContextTokens - maxOutputTokens - toolsEstimate - margin(5%)
   */
  getEffectiveBudget(modelId: string, toolsTokenEstimate: number = 4_000): number {
    const info = this.getModelInfo(modelId);
    const margin = Math.floor(info.maxContextTokens * 0.05);
    const budget =
      info.maxContextTokens -
      info.maxOutputTokens -
      toolsTokenEstimate -
      margin;

    return Math.max(budget, 4_000); // mínimo 4k
  }

  /** Retorna una copia del catálogo completo. */
  listEntries(): ModelInfo[] {
    return [...this.entries];
  }
}

/** Instancia global por defecto. */
export const modelCatalog = new ModelCatalog();
