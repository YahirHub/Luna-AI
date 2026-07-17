import { findOpenCodeFreeModelLimit } from "./providers/opencode-free.ts";

// ─── Tipos ───────────────────────────────────────────────────────

export interface ModelInfo {
  pattern: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  description?: string;
}

// ─── Límites conservadores para modelos desconocidos ────────────

export const DEFAULT_CONTEXT_TOKENS = 120_000;
export const DEFAULT_OUTPUT_TOKENS = 8_000;

// ─── ModelCatalog ─────────────────────────────────────────────────

export class ModelCatalog {
  /**
   * Obtiene límites por coincidencia del ID. Los modelos gratuitos integrados
   * viven en su módulo de proveedor; cualquier ID desconocido usa un valor
   * conservador para no retrasar demasiado la compactación.
   */
  getModelInfo(modelId: string): ModelInfo {
    const freeLimit = findOpenCodeFreeModelLimit(modelId);
    if (freeLimit) {
      return { ...freeLimit };
    }

    return {
      pattern: "*",
      maxContextTokens: DEFAULT_CONTEXT_TOKENS,
      maxOutputTokens: DEFAULT_OUTPUT_TOKENS,
      description: "Límite conservador para modelo desconocido",
    };
  }

  /**
   * Calcula el presupuesto efectivo de tokens de entrada.
   * Fórmula: contexto - salida - tools - margen del 5%.
   */
  getEffectiveBudget(modelId: string, toolsTokenEstimate: number = 4_000): number {
    const info = this.getModelInfo(modelId);
    const margin = Math.floor(info.maxContextTokens * 0.05);
    const budget =
      info.maxContextTokens -
      info.maxOutputTokens -
      toolsTokenEstimate -
      margin;

    return Math.max(budget, 4_000);
  }
}

/** Instancia global por defecto. */
export const modelCatalog = new ModelCatalog();
