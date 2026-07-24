import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "../src/ai.ts";
import { buildTaskOriginContext, buildTaskPostDelegationContext } from "../src/orchestration/task-continuation.ts";

describe("contexto de continuación de tareas background", () => {
  it("conserva datos previos necesarios para comparar y corta mensajes posteriores", () => {
    const origin = "Ahora revisa el clima en Villahermosa y compáralo, dónde será más fresco y dónde más calor";
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "Dame el clima de Jalpa" },
      { role: "assistant", content: "Jalpa: actual 27°C, máxima 36°C, mínima 26°C." },
      { role: "user", content: origin },
      { role: "user", content: "Este mensaje llegó después y no debe cambiar la misión" },
    ];
    const context = buildTaskOriginContext(messages, origin);
    expect(context).toContain("Jalpa: actual 27°C, máxima 36°C, mínima 26°C.");
    expect(context).toContain(origin);
    expect(context).not.toContain("Este mensaje llegó después");
    expect(context).not.toContain("system");
  });

  it("ve trabajo confirmado después de delegar para combinar finales FIFO sin repetirlos", () => {
    const origin = "Investiga Villahermosa y compáralo con Jalpa; además prepara un resumen independiente";
    const messages: ChatMessage[] = [
      { role: "user", content: "Jalpa: máxima 36°C" },
      { role: "user", content: origin },
      { role: "assistant", content: "Ya preparé el resumen independiente mientras el agente investiga." },
      { role: "user", content: "[Resultado background confirmado para continuar la solicitud original]" },
      { role: "assistant", content: "Un primer agente confirmó humedad de 80%." },
    ];
    const context = buildTaskPostDelegationContext(messages, origin);
    expect(context).toContain("Ya preparé el resumen independiente");
    expect(context).toContain("Un primer agente confirmó humedad de 80%.");
    expect(context).not.toContain("Jalpa: máxima 36°C");
  });

  it("no mezcla una conversación nueva si la solicitud original ya no está en el contexto activo", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Conversación nueva después de !clear" },
      { role: "assistant", content: "Empezamos de cero." },
    ];
    expect(buildTaskPostDelegationContext(messages, "Solicitud antigua")).toBe("");
  });
});
