import type { LunaModule } from "../types.ts";
export const WORKSPACE_MODULE: LunaModule = {
  id: "workspace", name: "Archivos", description: "Workdir privado y manipulación de archivos", category: "files",
  access: "authenticated", scope: "user",
  commands: [
    { name: "clear-workdir", description: "Limpia todos los archivos y tareas del workdir privado" },
    { name: "limpiar-workdir", description: "Alias en español para limpiar el workdir privado" },
  ],
  tools: [
    { name: "workspace_list" }, { name: "workspace_append_text" }, { name: "workspace_edit_text" }, { name: "workspace_delete" },
    { name: "workspace_read_text" }, { name: "workspace_write_text" }, { name: "workspace_list_artifacts" }, { name: "workspace_clear" },
    { name: "workspace_mkdir" }, { name: "workspace_stat" }, { name: "workspace_move" }, { name: "workspace_copy" },
    { name: "workspace_glob" }, { name: "workspace_search" }, { name: "workspace_read_files" }, { name: "workspace_apply_patch" },
    { name: "workspace_runtime_status" }, { name: "workspace_exec" },
  ],
  prompt: { summary: "Lee, crea, edita y elimina archivos dentro del workdir privado del usuario.", keywords: ["archivo", "carpeta", "workdir", "markdown", ".md", "escribe", "edita", "elimina archivo"], instructions: [
    "Usa las tools de workspace para operaciones físicas; no afirmes que un archivo existe sin resultado confirmado.",
    "Para tareas de código inspecciona primero con workspace_list/glob/search/read_files, edita con write/edit/apply_patch y valida con workspace_exec cuando exista el runtime adecuado.",
    "workspace_exec está confinado al workdir y debe usarse para tests, builds o scripts necesarios. No inventes salida ni asumas que Python/Node/Bun están instalados: consulta workspace_runtime_status/contexto dinámico.",
    "workspace_clear es destructiva y requiere petición explícita de vaciar el workdir; para archivos individuales usa workspace_delete.",
  ] },
};
