import type { LunaModule } from "../types.ts";
export const ADMIN_MODULE: LunaModule = {
  id: "admin", name: "Administración", description: "Gestión de usuarios y configuración global", category: "admin",
  access: "admin", scope: "global",
  commands: [
    { name: "adduser", description: "Crea un nuevo usuario" }, { name: "banuser", description: "Bloquea un usuario" },
    { name: "desban", description: "Desbloquea un usuario" }, { name: "userlist", description: "Muestra usuarios registrados" },
  ],
  tools: [
    { name: "admin_list_users" }, { name: "admin_start_add_user" }, { name: "admin_ban_user" }, { name: "admin_unban_user" },
  ],
  prompt: { summary: "Gestiona usuarios y operaciones administrativas globales.", keywords: ["usuario", "usuarios", "admin", "banear", "desbanear"], instructions: [
    "Las tools de este módulo solo existen para administradores autenticados.",
    "Para crear usuarios usa admin_start_add_user; la contraseña se captura en un mensaje seguro separado.",
    "Nunca afirmes un cambio administrativo sin resultado confirmado.",
  ] },
};
