import type { LunaModule } from "../types.ts";
export const MEMORY_MODULE: LunaModule = {
  id: "memory", name: "Memoria", description: "Perfil y bóveda personal persistente", category: "memory",
  access: "authenticated", scope: "user",
  tools: [
    { name: "memory_write" }, { name: "memory_read" }, { name: "memory_vault_list" }, { name: "memory_vault_search" },
    { name: "memory_vault_read" }, { name: "memory_vault_upsert" }, { name: "memory_vault_edit" }, { name: "memory_vault_rename" },
    { name: "memory_vault_backlinks" }, { name: "memory_vault_delete" }, { name: "memory_vault_restore" },
  ],
  prompt: {
    summary: "Guarda y consulta perfil compacto y notas Markdown temáticas persistentes.",
    keywords: ["recuerda", "no olvides", "memoria", "cumple", "fecha guardada", "guarda", "boveda", "bóveda"],
    instructions: [
      "memory.md es para nombre, forma de trato, preferencias estables e instrucciones personales breves; usa la bóveda para fechas, personas, proyectos y conocimiento creciente.",
      "Una petición explícita de recordar/guardar/no olvidar es transaccional: no termines hasta que memory_write, memory_vault_upsert o memory_vault_edit confirme éxito.",
      "memory_vault_search/list/read solo consultan y nunca prueban que algo fue guardado.",
      "Antes de crear una nota temática busca equivalentes para evitar duplicados; para cumpleaños reutiliza una nota estable cuando sea posible.",
      "No guardes contraseñas, tokens, API keys ni OTP en Markdown.",
    ],
  },
};
