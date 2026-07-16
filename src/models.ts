/**
 * Límites de tokens por modelo.
 *
 * Todos los modelos actuales usan el mismo límite de 120k tokens.
 * Si en el futuro se necesitan límites distintos por modelo,
 * se agrega un Map<string, ModelInfo> simple.
 */

// ─── Tipos ───────────────────────────────────────────────────────

export interface ModelInfo {
  pattern: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  description?: string;
}

// ─── Constantes ──────────────────────────────────────────────────

export const DEFAULT_CONTEXT_TOKENS = 120_000;
export const DEFAULT_OUTPUT_TOKENS = 8_000;

// ─── ModelCatalog ─────────────────────────────────────────────────

export class ModelCatalog {
  /**
   * Obtiene la información de contexto para un modelo específico.
   * Actualmente todos los modelos usan el mismo límite.
   */
  getModelInfo(_modelId: string): ModelInfo {
    return {
      pattern: "*",
      maxContextTokens: DEFAULT_CONTEXT_TOKENS,
      maxOutputTokens: DEFAULT_OUTPUT_TOKENS,
      description: "Límite por defecto",
    };
  }

  /**
   * Calcula el presupuesto efectivo de tokens de entrada.
   * Fórmula: maxContextTokens - maxOutputTokens - toolsEstimate - margin(5%)
   */
  getEffectiveBudget(_modelId: string, toolsTokenEstimate: number = 4_000): number {
    const margin = Math.floor(DEFAULT_CONTEXT_TOKENS * 0.05);
    const budget =
      DEFAULT_CONTEXT_TOKENS -
      DEFAULT_OUTPUT_TOKENS -
      toolsTokenEstimate -
      margin;

    return Math.max(budget, 4_000);
  }
}

/** Instancia global por defecto. */
export const modelCatalog = new ModelCatalog();
