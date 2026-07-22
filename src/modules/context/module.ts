import type { LunaModule } from "../types.ts";
export const CONTEXT_MODULE: LunaModule = {
  id: "context", name: "Contexto", description: "Historial, limpieza y compactación", category: "context",
  access: "authenticated", scope: "user",
  commands: [
    { name: "clear", description: "Reinicia la conversación borrando el historial" },
    { name: "compact", description: "Compacta la conversación o consulta su estado", usage: ["/compact", "/compact estado"] },
    { name: "uso", description: "Muestra métricas de contexto y consumo", usage: ["/uso", "/uso texto"] },
  ],
  tools: [{ name: "conversation_clear" }],
  prompt: { summary: "Gestiona historial, compactación y métricas de contexto.", keywords: ["compact", "contexto", "tokens", "uso", "limpia conversacion"], instructions: [
    "La compactación y las métricas son operaciones del contexto; no confundas consumo histórico de API con ocupación actual del contexto.",
  ] },
};
