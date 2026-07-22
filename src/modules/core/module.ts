import type { LunaModule } from "../types.ts";

export const CORE_MODULE: LunaModule = {
  id: "core",
  name: "Control",
  description: "Controles básicos de la sesión y conversación",
  category: "core",
  access: "authenticated",
  scope: "user",
  commands: [
    { name: "ayuda", description: "Muestra los comandos disponibles por módulo", usage: ["!ayuda", "!ayuda search"] },
    { name: "ping", description: "Responde con pong" },
    { name: "id", description: "Muestra tu identificador (JID)" },
    { name: "cancelar", description: "Cancela la operación actual" },
    { name: "cambiar-password", description: "Cambia la contraseña de tu cuenta" },
  ],
  tools: [
    { name: "control_help" }, { name: "control_ping" }, { name: "control_get_id" },
    { name: "control_cancel" }, { name: "account_password_change_start" },
  ],
  prompt: {
    summary: "Controla ayuda, identidad, cancelación y acciones básicas de la cuenta.",
    always: true,
    instructions: [
      "Los resultados confirmados de tools son la única evidencia de que una acción realmente ocurrió.",
      "No afirmes éxito de una operación persistente si su herramienta no confirmó éxito.",
      "Los comandos y tools de Luna solo existen para sesiones autenticadas; las capacidades admin aparecen únicamente para administradores.",
    ],
  },
};
