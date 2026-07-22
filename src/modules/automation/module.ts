import type { LunaModule } from "../types.ts";
export const AUTOMATION_MODULE: LunaModule = {
  id: "automation", name: "Automatización", description: "Recordatorios y alarmas", category: "automation",
  access: "authenticated", scope: "user",
  tools: [
    { name: "create_reminder" }, { name: "delete_reminder" }, { name: "list_reminders" },
    { name: "create_alarm" }, { name: "delete_alarm" }, { name: "list_alarms" }, { name: "toggle_alarm" },
  ],
  prompt: { summary: "Crea, consulta y administra recordatorios y alarmas persistentes.", keywords: ["recuerdame", "recuérdame", "recordatorio", "alarma", "avisame", "avísame"], instructions: [
    "Cuando el usuario pida un recordatorio o alarma, llama la herramienta correspondiente; no afirmes que existe sin confirmación.",
    "Las entregas programadas deben guardar un delivery_message autocontenido con los datos importantes.",
    "Si el usuario duda de algo previamente programado, lista primero antes de crear duplicados.",
  ] },
};
