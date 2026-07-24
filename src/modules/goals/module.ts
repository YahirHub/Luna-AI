import type { LunaModule } from "../types.ts";

export const GOALS_MODULE: LunaModule = {
  id: "goals",
  name: "Goals",
  description: "Objetivos autónomos verificados y tasklists internas persistentes",
  category: "agents",
  access: "authenticated",
  scope: "user",
  commands: [
    {
      name: "goal",
      description: "Inicia o controla un objetivo autónomo que continúa hasta superar la verificación",
      usage: ["/goal <objetivo>", "/goal estado", "/goal instruccion <cambio>", "/goal cancelar", "/goal reanudar"],
    },
  ],
  tools: [
    // El agente principal solo necesita iniciar/controlar goals. El tasklist
    // completo se carga dentro de GoalRuntime o mediante capability_load.
    { name: "tasklist_create", defer: true },
    { name: "tasklist_read", defer: true },
    { name: "tasklist_replace", defer: true },
    { name: "tasklist_update", defer: true },
    { name: "tasklist_add", defer: true },
    { name: "goal_start" },
    { name: "goal_status" },
    { name: "goal_cancel" },
    { name: "goal_resume" },
    { name: "goal_instruction" },
  ],
  prompt: {
    summary: "Mantiene tasklists internas y ejecuta goals autónomos hasta que un verifier confirme el resultado.",
    keywords: ["goal", "objetivo", "hasta terminar", "no pares", "continua hasta", "continúa hasta", "tasklist", "plan de trabajo", "implementa", "refactoriza", "corrige el proyecto", "crea el proyecto"],
    patterns: [
      /\b(?:investiga|analiza).{0,80}\b(?:implementa|corrige|crea|edita).{0,80}\b(?:prueba|test|build|compila|valida)\b/iu,
      /\b(?:implementa|refactoriza|corrige|crea).{0,100}\b(?:proyecto|repositorio|repo|c[oó]digo|aplicaci[oó]n).{0,100}\b(?:prueba|test|build|compila|valida)\b/iu,
    ],
    instructions: [
      "Para trabajos de varias fases dependientes o proyectos que requieren editar + validar, usa goal_start y libera el chat; el verifier decide cuándo termina.",
      "Si ya existe un goal activo y el usuario corrige requisitos, usa goal_instruction en vez de rehacer el trabajo en el turno principal.",
      "No existe comando /tasklist público; la tasklist detallada pertenece al GoalRuntime.",
    ],
    loadInstructions: [
      "Las tasklist_* son internas: conserva el plan, actualiza evidencia y no marques completed como simple intención.",
    ],
  },
};
