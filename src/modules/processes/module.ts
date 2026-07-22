import type { LunaModule } from "../types.ts";

export const PROCESSES_MODULE: LunaModule = {
  id: "processes",
  name: "Procesos",
  description: "Procesos persistentes ejecutados dentro del workdir con captura de logs",
  category: "runtime",
  access: "authenticated",
  scope: "user",
  tools: [
    { name: "process_start" },
    { name: "process_list" },
    { name: "process_status" },
    { name: "process_logs" },
    { name: "process_stop" },
    { name: "process_restart" },
  ],
  prompt: {
    summary: "Inicia y administra procesos persistentes de Node.js, Bun, Python o Bash dentro del workdir, con logs consultables.",
    keywords: ["inicia el bot", "iniciar bot", "ejecuta el bot", "ejecutalo", "ejecútalo", "correrlo", "deja corriendo", "corriendo", "proceso", "logs", "deten", "detén", "reinicia", "levanta", "arranca", "servidor", "daemon"],
    instructions: [
      "Para un servicio que debe seguir vivo después del turno usa process_start, no workspace_exec. workspace_exec es para comandos finitos como tests/builds.",
      "Antes de iniciar una segunda instancia consulta process_list/process_status. Para diagnosticar fallos usa process_logs y corrige el código antes de reiniciar.",
      "Cuando el usuario pida detener un bot/proceso usa process_stop; para volver a levantarlo usa process_restart o process_start según corresponda.",
      "No afirmes que un servicio está funcionando solo porque process_start devolvió un PID: revisa process_logs o process_status cuando la tarea requiera comprobar funcionamiento.",
      "No pases tokens, contraseñas ni API keys como argumentos de process_start porque los argumentos se registran; usa un archivo .env dentro del workdir cuando la aplicación lo soporte.",
    ],
  },
};
