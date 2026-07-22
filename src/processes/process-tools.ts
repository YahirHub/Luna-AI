import type { ToolDefinition } from "../ai.ts";
import type { AgenticRuntime } from "../workspace/workspace-exec.ts";
import type { UserProcessManager } from "./process-manager.ts";

export const PROCESS_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "process_start",
      description: "Inicia un proceso persistente en segundo plano dentro del workdir, por ejemplo un bot Node.js. Devuelve un process_id y captura stdout/stderr para inspección posterior.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nombre estable, por ejemplo telegram-bot." },
          runtime: { type: "string", enum: ["node", "bun", "python", "bash"] },
          entry: { type: "string", description: "Archivo ejecutable relativo al workdir, por ejemplo telegram-bot/src/bot.js." },
          cwd: { type: "string", description: "Directorio de trabajo relativo; por defecto '.'." },
          args: { type: "array", maxItems: 40, items: { type: "string" } },
        },
        required: ["name", "runtime", "entry"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "process_list",
      description: "Lista procesos persistentes del usuario y sus estados reales.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "process_status",
      description: "Consulta el estado real de un proceso persistente por ID o nombre.",
      parameters: {
        type: "object",
        properties: { process_id: { type: "string", description: "ID P-XXXXXXXX o nombre del proceso. Si se omite usa el activo/más reciente." } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "process_logs",
      description: "Lee las últimas líneas de stdout/stderr de un proceso persistente para diagnosticar errores y verificar actividad.",
      parameters: {
        type: "object",
        properties: {
          process_id: { type: "string" },
          stream: { type: "string", enum: ["all", "stdout", "stderr"] },
          lines: { type: "integer", minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "process_stop",
      description: "Detiene un proceso persistente y todo su árbol de procesos.",
      parameters: { type: "object", properties: { process_id: { type: "string" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "process_restart",
      description: "Reinicia un proceso persistente conservando runtime, entry, cwd y argumentos.",
      parameters: { type: "object", properties: { process_id: { type: "string" } }, additionalProperties: false },
    },
  },
];

function formatProcess(record: ReturnType<UserProcessManager["get"]>): string {
  if (!record) return "Error: proceso no encontrado.";
  return [
    `${record.name} (${record.id})`,
    `Estado: ${record.status}${record.pid ? ` · PID ${record.pid}` : ""}`,
    `Runtime: ${record.runtime}`,
    `Entry: ${record.entry}`,
    `CWD: ${record.cwd}`,
    record.ownerGoalId ? `Goal propietario: ${record.ownerGoalId}` : "",
    record.exitCode !== undefined ? `Exit code: ${record.exitCode}` : "",
    record.error ? `Error: ${record.error}` : "",
  ].filter(Boolean).join("\n");
}

export async function executeProcessTool(
  name: string,
  args: Record<string, unknown>,
  manager: UserProcessManager,
  jid: string,
  ownerGoalId?: string,
): Promise<string> {
  try {
    const id = typeof args.process_id === "string" ? args.process_id.trim() || undefined : undefined;
    if (name === "process_start") {
      const processName = typeof args.name === "string" ? args.name.trim() : "";
      const runtime = typeof args.runtime === "string" ? args.runtime as AgenticRuntime : undefined;
      const entry = typeof args.entry === "string" ? args.entry.trim() : "";
      if (!processName || !runtime || !["node", "bun", "python", "bash"].includes(runtime) || !entry) {
        return "Error: name, runtime y entry son obligatorios.";
      }
      const record = manager.start(jid, {
        name: processName,
        runtime,
        entry,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        args: Array.isArray(args.args) ? args.args.filter((item): item is string => typeof item === "string") : undefined,
        ownerGoalId,
      });
      return `✅ Proceso iniciado en segundo plano.\n${formatProcess(record)}\nUsa process_logs para revisar su salida y process_stop para detenerlo.`;
    }
    if (name === "process_list") {
      const records = manager.list(jid);
      return records.length
        ? ["PROCESOS DEL USUARIO", ...records.slice(0, 30).map((item) => `- ${item.id} | ${item.name} | ${item.status} | ${item.runtime} ${item.entry}${item.pid ? ` | PID ${item.pid}` : ""}`)].join("\n")
        : "No hay procesos persistentes registrados.";
    }
    if (name === "process_status") return formatProcess(manager.get(jid, id));
    if (name === "process_logs") {
      const stream = args.stream === "stdout" || args.stream === "stderr" ? args.stream : "all";
      const lines = typeof args.lines === "number" ? args.lines : 120;
      return manager.logs(jid, id, stream, lines);
    }
    if (name === "process_stop") return `⛔ Proceso detenido/terminando.\n${formatProcess(manager.stop(jid, id))}`;
    if (name === "process_restart") return `🔄 Proceso reiniciado.\n${formatProcess(await manager.restart(jid, id))}`;
    return `Error: herramienta de procesos desconocida: ${name}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
