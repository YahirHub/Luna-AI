import type { LunaModule } from "../types.ts";
export const WORKSPACE_MODULE: LunaModule = {
  id: "workspace", name: "Archivos", description: "Workdir privado y manipulación de archivos", category: "files",
  access: "authenticated", scope: "user",
  commands: [
    { name: "clear-workdir", description: "Limpia todos los archivos y tareas del workdir privado" },
    { name: "limpiar-workdir", description: "Alias en español para limpiar el workdir privado" },
  ],
  tools: [
    // Lectura/descubrimiento: superficie barata que el router puede exponer por intención.
    { name: "workspace_list" }, { name: "workspace_read_text" }, { name: "workspace_list_artifacts" }, { name: "workspace_stat" },
    { name: "workspace_glob" }, { name: "workspace_search" }, { name: "workspace_read_files" }, { name: "workspace_runtime_status" },
    // Mutación/ejecución: se descubre mediante capability_load("workspace") cuando realmente hace falta.
    { name: "workspace_append_text", defer: true }, { name: "workspace_edit_text", defer: true }, { name: "workspace_delete", defer: true },
    { name: "workspace_write_text", defer: true }, { name: "workspace_clear", defer: true }, { name: "workspace_mkdir", defer: true },
    { name: "workspace_move", defer: true }, { name: "workspace_copy", defer: true }, { name: "workspace_apply_patch", defer: true },
    { name: "workspace_exec", defer: true },
  ],
  prompt: { summary: "Lee, crea, edita y elimina archivos dentro del workdir privado del usuario.", keywords: ["archivo", "carpeta", "workdir", "markdown", ".md", "escribe", "edita", "elimina archivo", "proyecto", "repositorio", "repo", "código", "codigo", "implementa", "corrige", "refactoriza", "tests", "pruebas", "build", "compila"], instructions: [
    "Inspecciona primero el workdir con list/glob/search/read_files y usa resultados confirmados como evidencia. Si necesitas modificar o ejecutar, carga completamente workspace con capability_load.",
  ], loadInstructions: [
    "Para editar usa write/edit/apply_patch y valida con workspace_exec cuando exista el runtime adecuado; no inventes salida.",
    "workspace_exec está confinado al workdir. Consulta workspace_runtime_status antes de asumir Python/Node/Bun.",
    "workspace_clear es destructiva y exige una petición explícita de vaciar el workdir; para archivos individuales usa workspace_delete.",
  ] },
};
