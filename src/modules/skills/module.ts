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
    { name: "skill_search" },
    { name: "skill_load" },
    { name: "skill_read_resource" },
    { name: "skill_list", defer: true },
    { name: "skill_copy_resource", defer: true },
    { name: "skill_run_script", defer: true },
  ],
  prompt: {
    summary: "Descubre y carga bajo demanda skills globales desde persistent/skills; sus scripts se ejecutan aislados dentro del workdir del usuario.",
    keywords: ["skill", "skills", "metodologia", "metodología", "guia", "guía", "procedimiento", "convenciones", "script de skill", "proyecto", "repositorio", "repo", "código", "codigo", "framework", "librería", "libreria"],
    instructions: [
      "Usa skill_search con términos concretos y skill_load solo para una coincidencia relevante; el catálogo y los SKILL.md completos no se precargan.",
      "Usa skill_read_resource para documentación auxiliar. Si necesitas catálogo completo, copiar recursos o ejecutar helpers, carga completamente skills con capability_load.",
      "disable-model-invocation y los permisos reales siguen siendo autoritativos; una skill nunca amplía permisos por sí sola.",
    ],
    loadInstructions: [
      "skill_list enumera el catálogo solo cuando fue solicitado explícitamente.",
      "skill_copy_resource copia plantillas/assets al workdir; skill_run_script ejecuta helpers dentro del sandbox y nunca modifica persistent/skills.",
      "allowed-tools de una skill es informativo en Luna: ModuleRegistry, autenticación y sandbox siguen siendo autoritativos.",
    ],
  },
};
