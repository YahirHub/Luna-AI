import type { ToolDefinition } from "../ai.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { SkillManager } from "./skill-manager.ts";

export const SKILL_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "skill_search",
      description: "Busca localmente las skills globales relevantes para una tarea sin inyectar el catálogo completo. Devuelve solo unas pocas coincidencias; después usa skill_load únicamente sobre la skill necesaria.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Tecnología, dominio o metodología concreta que necesitas." },
          limit: { type: "integer", minimum: 1, maximum: 10, description: "Máximo de resultados; por defecto 5." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_list",
      description: "Lista las skills globales instaladas que el modelo puede invocar automáticamente. Devuelve solo metadatos; usa skill_load para cargar el SKILL.md relevante.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_load",
      description: "Carga y renderiza una skill global compatible con Claude/Agent Skills cuando sea relevante para la tarea. Expande argumentos, recursos y contexto dinámico seguro sin copiar todo el catálogo al prompt.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string" },
          arguments: { type: "string", description: "Argumentos que sustituirán $ARGUMENTS, $0, $1 y argumentos nombrados." },
        },
        required: ["skill"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_read_resource",
      description: "Lee un archivo textual auxiliar de una skill, como reference.md, examples o documentación. La ruta siempre queda confinada a la carpeta global de esa skill.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string" },
          path: { type: "string" },
          max_chars: { type: "integer", minimum: 500, maximum: 100000 },
        },
        required: ["skill", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_copy_resource",
      description: "Copia un recurso de una skill global al workdir privado del usuario. Úsalo para plantillas, assets o archivos que deban modificarse sin alterar la skill global compartida.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string" },
          path: { type: "string" },
          destination: { type: "string" },
        },
        required: ["skill", "path", "destination"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_run_script",
      description: [
        "Ejecuta un script o compilado incluido en una skill dentro del sandbox del workdir del usuario.",
        "La skill global permanece de solo lectura: Luna materializa una copia privada para esa ejecución.",
        "Soporta detección automática y runtimes Bash, PowerShell, Python, Node.js o Bun cuando estén disponibles.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string" },
          path: { type: "string", description: "Ruta dentro de la skill, por ejemplo scripts/validate.py." },
          args: { type: "array", maxItems: 50, items: { type: "string" } },
          cwd: { type: "string", description: "CWD relativo al workdir del usuario; por defecto '.'." },
          runtime: { type: "string", enum: ["auto", "bash", "python", "node", "bun", "powershell"] },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 900 },
        },
        required: ["skill", "path"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeSkillTool(
  name: string,
  args: Record<string, unknown>,
  skills: SkillManager,
  workspace: WorkspaceManager,
  jid: string,
  signal?: AbortSignal,
  options: { executeDynamicCommands?: boolean; allowScripts?: boolean; destinationPrefix?: string } = {},
): Promise<string> {
  try {
    if (name === "skill_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const limit = typeof args.limit === "number" ? args.limit : 5;
      return skills.searchForModel(query, limit);
    }
    if (name === "skill_list") return skills.buildCatalogForModel();
    const skillName = typeof args.skill === "string" ? args.skill.trim() : "";
    if (!skillName) return "Error: skill es obligatorio.";

    if (name === "skill_load") {
      const rendered = await skills.render(
        skillName,
        typeof args.arguments === "string" ? args.arguments : "",
        workspace,
        jid,
        { modelInvocation: true, executeDynamicCommands: options.executeDynamicCommands !== false, signal },
      );
      return [
        rendered.content,
        "",
        `[Skill cargada: ${rendered.skill.id}; comandos dinámicos ejecutados: ${rendered.dynamicCommandsExecuted}]`,
      ].join("\n");
    }
    if (name === "skill_read_resource") {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return "Error: path es obligatorio.";
      const max = typeof args.max_chars === "number" ? Math.max(500, Math.min(100_000, Math.trunc(args.max_chars))) : 50_000;
      return skills.readResource(skillName, path, max);
    }
    if (name === "skill_copy_resource") {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      const destination = typeof args.destination === "string" ? args.destination.trim() : "";
      if (!path || !destination) return "Error: path y destination son obligatorios.";
      const scopedDestination = options.destinationPrefix
        ? `${options.destinationPrefix.replace(/\/$/, "")}/${destination.replace(/^\/+/, "")}`
        : destination;
      return `✅ Recurso de skill copiado en ${skills.copyResourceToWorkspace(skillName, path, scopedDestination, workspace, jid)}`;
    }
    if (name === "skill_run_script") {
      if (options.allowScripts === false) return "Error: skill_run_script no está permitido en este contexto de subagente; delega la ejecución al goal/orquestador.";
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return "Error: path es obligatorio.";
      const runtime = typeof args.runtime === "string" && ["auto", "bash", "python", "node", "bun", "powershell"].includes(args.runtime)
        ? args.runtime as "auto" | "bash" | "python" | "node" | "bun" | "powershell"
        : "auto";
      return await skills.runScript({
        skillName,
        path,
        workspace,
        jid,
        args: Array.isArray(args.args) ? args.args.filter((item): item is string => typeof item === "string").slice(0, 50) : [],
        cwd: options.destinationPrefix
          ? `${options.destinationPrefix.replace(/\/$/, "")}/${typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim().replace(/^\/+/, "") : ""}`.replace(/\/$/, "")
          : typeof args.cwd === "string" ? args.cwd : ".",
        runtime,
        timeoutSeconds: typeof args.timeout_seconds === "number" ? args.timeout_seconds : 120,
        signal,
      });
    }
    return `Error: herramienta de skill desconocida: ${name}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
