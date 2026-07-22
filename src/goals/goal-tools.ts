import type { ToolDefinition } from "../ai.ts";

/**
 * Controles del runtime autónomo accesibles al orquestador principal.
 * La tasklist sigue siendo interna: estos controles nunca exponen un comando /tasklist.
 */
export const GOAL_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "goal_start",
      description: "Inicia un objetivo autónomo persistente en segundo plano. Úsalo cuando el usuario pida explícitamente continuar hasta terminar/no detenerse o cuando una tarea compleja de múltiples pasos necesite investigar, crear/editar archivos, ejecutar código y verificar iterativamente antes de considerarse completa. El chat queda libre mientras el goal trabaja.",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", description: "Objetivo completo y autocontenido que debe cumplir el runtime." },
          max_iterations: { type: "integer", minimum: 3, maximum: 40, description: "Límite opcional de iteraciones autónomas." },
        },
        required: ["objective"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goal_status",
      description: "Consulta el estado autoritativo del goal activo o de un goal concreto, incluida su tasklist interna y progreso.",
      parameters: {
        type: "object",
        properties: { goal_id: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goal_cancel",
      description: "Cancela el goal activo o uno concreto y propaga la cancelación a procesos y subagentes iniciados por él.",
      parameters: {
        type: "object",
        properties: { goal_id: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goal_resume",
      description: "Reanuda un goal interrumpido o fallido conservando sus archivos y tasklist, reiniciando su presupuesto de iteraciones.",
      parameters: {
        type: "object",
        properties: { goal_id: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
];
