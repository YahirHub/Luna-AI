import type { LunaModule } from "../types.ts";

export const SKILLS_MODULE: LunaModule = {
  id: "skills",
  name: "Skills",
  description: "Skills globales compatibles con Claude/Agent Skills, compartidas por todos los usuarios",
  category: "agents",
  access: "authenticated",
  scope: "global",
  commands: [
    { name: "skills", description: "Lista las skills globales instaladas" },
  ],
  tools: [
    { name: "skill_list" },
    { name: "skill_load" },
    { name: "skill_read_resource" },
    { name: "skill_copy_resource" },
    { name: "skill_run_script" },
  ],
  prompt: {
    always: true,
    summary: "Descubre y carga bajo demanda skills globales desde persistent/skills; sus scripts se ejecutan aislados dentro del workdir del usuario.",
    keywords: ["skill", "skills", "metodologia", "metodología", "guia", "guía", "procedimiento", "convenciones", "script de skill"],
    instructions: [
      "Revisa el catálogo de skills disponible en el contexto. Si una skill describe exactamente la tarea o metodología necesaria, usa skill_load antes de improvisar el procedimiento.",
      "No cargues todas las skills: solo sus metadatos están precargados y el cuerpo de SKILL.md debe leerse bajo demanda.",
      "Para documentación o ejemplos auxiliares usa skill_read_resource; para plantillas/assets modificables usa skill_copy_resource.",
      "Si una skill incluye scripts o binarios auxiliares, usa skill_run_script. Se ejecutan dentro del sandbox del workdir y nunca deben modificar persistent/skills.",
      "disable-model-invocation: true impide que el modelo cargue la skill automáticamente. Solo una invocación explícita del usuario puede habilitar ese flujo.",
      "allowed-tools de una skill es informativo en Luna: nunca amplía permisos reales; ModuleRegistry, autenticación y sandbox siguen siendo autoritativos.",
    ],
  },
};
