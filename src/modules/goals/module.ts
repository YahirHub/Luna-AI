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
      usage: ["/goal <objetivo>", "/goal estado", "/goal cancelar", "/goal reanudar"],
    },
  ],
  tools: [
    { name: "tasklist_create" },
    { name: "tasklist_read" },
    { name: "tasklist_replace" },
    { name: "tasklist_update" },
    { name: "tasklist_add" },
    { name: "goal_start" },
    { name: "goal_status" },
    { name: "goal_cancel" },
    { name: "goal_resume" },
  ],
  prompt: {
    always: true,
    summary: "Mantiene tasklists internas y ejecuta goals autónomos hasta que un verifier confirme el resultado.",
    keywords: ["goal", "objetivo", "hasta terminar", "no pares", "continua hasta", "continúa hasta", "tasklist", "plan de trabajo"],
    instructions: [
      "Para trabajos normales de 3 o más pasos usa una tasklist interna; no existe ni debes sugerir un comando /tasklist.",
      "Si la petición exige múltiples fases dependientes (por ejemplo investigar documentación, implementar, ejecutar tests y corregir hasta pasar) o el usuario dice que continúes hasta terminar, inicia goal_start en vez de abandonar después de delegar una sola investigación.",
      "Mantén la tasklist actualizada y registra evidencia al marcar completed; no uses completed como simple intención.",
      "Cuando el usuario use /goal, el runtime autónomo corre en segundo plano y el verifier decide cuándo está realmente completo.",
      "No bloquees la conversación esperando un goal activo; el usuario puede seguir hablando mientras progresa.",
    ],
  },
};
