import type { LunaModule } from "../types.ts";
export const AGENTS_MODULE: LunaModule = {
  id: "agents", name: "Agentes", description: "Delegación, supervisor y tareas en segundo plano", category: "agents",
  access: "authenticated", scope: "user",
  commands: [{ name: "config", description: "Configura herramientas y subagentes", access: "admin" }],
  tools: [
    { name: "spawn_agents" }, { name: "task_list" }, { name: "task_status" }, { name: "task_inspect" }, { name: "task_review" },
    { name: "task_cancel" }, { name: "task_cancel_all" }, { name: "agent_list" }, { name: "agent_status" }, { name: "agent_review" }, { name: "agent_cancel" },
    { name: "agent_config_status", access: "admin" }, { name: "agent_config_update", access: "admin" },
  ],
  prompt: { summary: "Delega tareas aisladas, supervisa progreso y revisa resultados persistentes.", keywords: ["agente", "agentes", "tarea", "tareas", "segundo plano", "paralelo"], instructions: [
    "Usa spawn_agents para dos o más trabajos independientes; las tareas de fondo no bloquean el chat.",
    "Los estados del supervisor son autoritativos: no contradigas agent_started, waiting_user o estados terminales.",
    "Revisa resultados y artefactos contra la solicitud original; si falta evidencia, delega únicamente el hueco necesario.",
  ] },
};
