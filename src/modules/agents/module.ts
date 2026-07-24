import type { LunaModule } from "../types.ts";
export const AGENTS_MODULE: LunaModule = {
  id: "agents", name: "Agentes", description: "Delegación, supervisor y tareas en segundo plano", category: "agents",
  access: "authenticated", scope: "user",
  commands: [{ name: "config", description: "Configura herramientas y subagentes", access: "admin" }],
  tools: [
    { name: "spawn_agents" }, { name: "task_list" }, { name: "task_status" }, { name: "agent_list" }, { name: "agent_status" },
    { name: "task_inspect", defer: true }, { name: "task_review", defer: true }, { name: "task_cancel", defer: true },
    { name: "task_cancel_all", defer: true }, { name: "agent_review", defer: true }, { name: "agent_cancel", defer: true },
    { name: "agent_config_status", access: "admin", defer: true }, { name: "agent_config_update", access: "admin", defer: true },
  ],
  prompt: { summary: "Delega tareas aisladas, supervisa progreso y revisa resultados persistentes.", keywords: ["agente", "agentes", "tarea", "tareas", "segundo plano", "paralelo"], instructions: [
    "Usa spawn_agents para trabajos independientes; registrar un subagente NO termina el turno principal. Continúa en paralelo cualquier parte de la solicitud que no dependa de su resultado y no relances la misma misión.",
    "Cuando el resultado background llegue, el supervisor lo integrará con la solicitud original y el contexto congelado; no inventes antes comparaciones o conclusiones que dependan de ese resultado.",
    "Consulta task_status/agent_status para progreso. Para inspección, revisión, cancelación o configuración avanzada carga completamente agents con capability_load.",
  ], loadInstructions: [
    "Revisa resultados/artefactos contra la solicitud original y cancela solo la tarea/agente indicado; no contradigas estados terminales confirmados.",
  ] },
};
