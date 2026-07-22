import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import type { ToolDefinition } from "../ai.ts";
import type { WorkspaceManager } from "./workspace-manager.ts";
import { executeSandboxedCode, formatRuntimeStatus, getRuntimeStatus } from "./workspace-exec.ts";

const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", ".home", "coverage"]);
const MAX_SEARCH_FILE_BYTES = 2_000_000;

export const AGENTIC_WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "workspace_mkdir",
      description: "Crea una carpeta, incluyendo directorios padres, dentro del workdir privado del usuario.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_stat",
      description: "Obtiene tipo, tamaño y metadatos básicos de un archivo o carpeta del workdir.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_move",
      description: "Mueve o renombra un archivo/carpeta dentro del workdir. Origen y destino deben permanecer dentro del sandbox.",
      parameters: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_copy",
      description: "Copia un archivo o carpeta dentro del workdir sin salir del sandbox.",
      parameters: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" }, overwrite: { type: "boolean" } }, required: ["source", "destination"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_glob",
      description: "Busca archivos por patrón glob relativo al workdir, por ejemplo **/*.ts o src/**/*.js.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["pattern"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_search",
      description: "Busca texto o una expresión regular dentro de archivos del workdir y devuelve coincidencias con ruta y línea. Úsala para localizar código antes de editar.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          regex: { type: "boolean" },
          case_sensitive: { type: "boolean" },
          max_results: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_read_files",
      description: "Lee varios archivos de texto del workdir en una sola llamada. Cada ruta sigue confinada al usuario.",
      parameters: { type: "object", properties: { paths: { type: "array", minItems: 1, maxItems: 40, items: { type: "string" } }, max_chars_per_file: { type: "integer", minimum: 500, maximum: 100000 } }, required: ["paths"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_apply_patch",
      description: "Aplica una serie de reemplazos exactos a uno o varios archivos. Falla si un fragmento no existe o es ambiguo, evitando ediciones silenciosas incorrectas.",
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                old_text: { type: "string" },
                new_text: { type: "string" },
                replace_all: { type: "boolean" },
              },
              required: ["path", "old_text", "new_text"],
              additionalProperties: false,
            },
          },
        },
        required: ["changes"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_runtime_status",
      description: "Indica qué runtimes agenticos están disponibles para ejecutar código dentro del sandbox del workdir (Bash, Python, Node.js o Bun).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_exec",
      description: [
        "Ejecuta código Bash, Python, Node.js o Bun dentro del workdir privado usando el sandbox del sistema.",
        "Úsala para tests, builds, scripts, generación de archivos o validaciones necesarias para completar una tarea.",
        "No asumas que un runtime existe: consulta workspace_runtime_status o usa un runtime que el contexto dinámico marque como disponible.",
        "La ejecución tiene timeout, salida acotada y cancelación del árbol de procesos.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          runtime: { type: "string", enum: ["bash", "python", "node", "bun"] },
          code: { type: "string" },
          cwd: { type: "string", description: "Carpeta relativa dentro del workdir; por defecto '.'." },
          args: { type: "array", maxItems: 40, items: { type: "string" } },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 900 },
        },
        required: ["runtime", "code"],
        additionalProperties: false,
      },
    },
  },
];

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let out = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        i += 1;
        if (normalized[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

function walkFiles(manager: WorkspaceManager, jid: string, inputPath = ".", limit = 10000): string[] {
  const root = manager.resolvePath(jid, inputPath, { mustExist: true, allowDirectory: true });
  const workdir = manager.getWorkdir(jid);
  const files: string[] = [];
  const walk = (current: string): void => {
    if (files.length >= limit) return;
    const info = lstatSync(current);
    if (info.isSymbolicLink()) {
      // resolvePath protege accesos directos, pero el crawler no sigue enlaces.
      return;
    }
    if (info.isFile()) {
      files.push(relative(workdir, current).replace(/\\/g, "/"));
      return;
    }
    if (!info.isDirectory()) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (files.length >= limit) break;
      if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue;
      walk(join(current, entry.name));
    }
  };
  walk(root);
  return files;
}

function isLikelyText(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return !new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".tar", ".7z", ".mp3", ".mp4", ".wav", ".ogg", ".opus", ".woff", ".woff2", ".ttf", ".exe", ".dll", ".so", ".bin"]).has(ext);
}

export async function executeAgenticWorkspaceTool(
  name: string,
  args: Record<string, unknown>,
  manager: WorkspaceManager,
  jid: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    if (name === "workspace_mkdir") {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return "Error: path es obligatorio.";
      const target = manager.resolvePath(jid, path, { allowDirectory: true });
      mkdirSync(target, { recursive: true });
      return `✅ Carpeta disponible: ${manager.relativePath(jid, target)}`;
    }
    if (name === "workspace_stat") {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return "Error: path es obligatorio.";
      const target = manager.resolvePath(jid, path, { mustExist: true, allowDirectory: true });
      const info = statSync(target);
      return JSON.stringify({
        path: manager.relativePath(jid, target),
        type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        size: info.size,
        modified_at: info.mtime.toISOString(),
        created_at: info.birthtime.toISOString(),
      }, null, 2);
    }
    if (name === "workspace_move") {
      const source = typeof args.source === "string" ? args.source.trim() : "";
      const destination = typeof args.destination === "string" ? args.destination.trim() : "";
      if (!source || !destination) return "Error: source y destination son obligatorios.";
      const src = manager.resolvePath(jid, source, { mustExist: true, allowDirectory: true });
      const dst = manager.resolvePath(jid, destination, { allowDirectory: true });
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
      return `✅ Movido: ${source} → ${manager.relativePath(jid, dst)}`;
    }
    if (name === "workspace_copy") {
      const source = typeof args.source === "string" ? args.source.trim() : "";
      const destination = typeof args.destination === "string" ? args.destination.trim() : "";
      if (!source || !destination) return "Error: source y destination son obligatorios.";
      const src = manager.resolvePath(jid, source, { mustExist: true, allowDirectory: true });
      const dst = manager.resolvePath(jid, destination, { allowDirectory: true });
      if (existsSync(dst) && args.overwrite !== true) return "Error: destination ya existe; usa overwrite=true para reemplazarlo.";
      mkdirSync(dirname(dst), { recursive: true });
      if (statSync(src).isDirectory()) cpSync(src, dst, { recursive: true, force: args.overwrite === true, errorOnExist: args.overwrite !== true });
      else copyFileSync(src, dst);
      return `✅ Copiado: ${source} → ${manager.relativePath(jid, dst)}`;
    }
    if (name === "workspace_glob") {
      const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
      if (!pattern) return "Error: pattern es obligatorio.";
      const base = typeof args.path === "string" && args.path.trim() ? args.path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") : ".";
      const max = typeof args.max_results === "number" ? Math.max(1, Math.min(1000, Math.trunc(args.max_results))) : 300;
      const regex = globToRegExp(pattern);
      const prefix = base === "." ? "" : `${base}/`;
      const matches = walkFiles(manager, jid, base).filter((path) => {
        regex.lastIndex = 0;
        if (regex.test(path)) return true;
        const relativeToBase = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
        regex.lastIndex = 0;
        return regex.test(relativeToBase);
      }).slice(0, max);
      return matches.length ? `${matches.join("\n")}\n\nTotal mostrado: ${matches.length}` : `Sin archivos para patrón ${pattern}`;
    }
    if (name === "workspace_search") {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query) return "Error: query es obligatorio.";
      if (query.length > (args.regex === true ? 500 : 2_000)) return `Error: query demasiado larga para ${args.regex === true ? "regex" : "búsqueda literal"}.`;
      const base = typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
      const max = typeof args.max_results === "number" ? Math.max(1, Math.min(500, Math.trunc(args.max_results))) : 120;
      const caseSensitive = args.case_sensitive === true;
      let matcher: RegExp | null = null;
      if (args.regex === true) {
        try { matcher = new RegExp(query, caseSensitive ? "" : "i"); } catch (error) { return `Error: regex inválida: ${error instanceof Error ? error.message : String(error)}`; }
      }
      const needle = caseSensitive ? query : query.toLowerCase();
      const output: string[] = [];
      for (const path of walkFiles(manager, jid, base)) {
        if (output.length >= max) break;
        if (!isLikelyText(path)) continue;
        const absolute = manager.resolvePath(jid, path, { mustExist: true });
        if (statSync(absolute).size > MAX_SEARCH_FILE_BYTES) continue;
        let text: string;
        try { text = manager.readText(jid, path, MAX_SEARCH_FILE_BYTES + 10); } catch { continue; }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length && output.length < max; index += 1) {
          const line = lines[index] ?? "";
          const ok = matcher ? (matcher.lastIndex = 0, matcher.test(line)) : (caseSensitive ? line : line.toLowerCase()).includes(needle);
          if (ok) output.push(`${path}:${index + 1}:${line.slice(0, 1200)}`);
        }
      }
      return output.length ? `${output.join("\n")}\n\nCoincidencias mostradas: ${output.length}` : "Sin coincidencias.";
    }
    if (name === "workspace_read_files") {
      const paths = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 40) : [];
      if (!paths.length) return "Error: paths debe contener al menos una ruta.";
      const maxChars = typeof args.max_chars_per_file === "number" ? Math.max(500, Math.min(100_000, Math.trunc(args.max_chars_per_file))) : 30_000;
      return paths.map((path) => {
        try { return `===== ${path} =====\n${manager.readText(jid, path, maxChars)}`; }
        catch (error) { return `===== ${path} =====\nError: ${error instanceof Error ? error.message : String(error)}`; }
      }).join("\n\n");
    }
    if (name === "workspace_apply_patch") {
      const changes = Array.isArray(args.changes) ? args.changes.slice(0, 50) : [];
      if (!changes.length) return "Error: changes debe contener al menos un reemplazo.";

      // Prepara el patch completo en memoria antes de escribir nada. Si un
      // fragmento falta o es ambiguo, no queda un patch aplicado a medias.
      const contentByPath = new Map<string, string>();
      const replacementsByPath = new Map<string, number>();
      for (const raw of changes) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Error: cambio inválido.";
        const item = raw as Record<string, unknown>;
        const path = typeof item.path === "string" ? item.path.trim() : "";
        const oldText = typeof item.old_text === "string" ? item.old_text : "";
        const newText = typeof item.new_text === "string" ? item.new_text : "";
        if (!path || !oldText) return "Error: cada cambio requiere path y old_text.";
        const cached = contentByPath.get(path);
        let current: string;
        if (cached === undefined) {
          const absolute = manager.resolvePath(jid, path, { mustExist: true });
          current = readFileSync(absolute, "utf8");
        } else {
          current = cached;
        }
        const matches = current.split(oldText).length - 1;
        if (matches === 0) return `Error: no se encontró old_text en ${path}; no se aplicó ningún cambio.`;
        if (matches > 1 && item.replace_all !== true) return `Error: old_text aparece ${matches} veces en ${path}; usa replace_all=true o un fragmento más específico. No se aplicó ningún cambio.`;
        const replacements = item.replace_all === true ? matches : 1;
        current = item.replace_all === true ? current.split(oldText).join(newText) : current.replace(oldText, newText);
        contentByPath.set(path, current);
        replacementsByPath.set(path, (replacementsByPath.get(path) ?? 0) + replacements);
      }
      const results: string[] = [];
      for (const [path, content] of contentByPath) {
        manager.writeText(jid, path, content);
        results.push(`${path}: ${replacementsByPath.get(path) ?? 0} reemplazo(s)`);
      }
      return `✅ Patch aplicado tras prevalidación completa\n${results.join("\n")}`;
    }
    if (name === "workspace_runtime_status") {
      return formatRuntimeStatus(getRuntimeStatus());
    }
    if (name === "workspace_exec") {
      const runtime = typeof args.runtime === "string" ? args.runtime : "";
      if (!["bash", "python", "node", "bun"].includes(runtime)) return "Error: runtime inválido.";
      const code = typeof args.code === "string" ? args.code : "";
      if (!code.trim()) return "Error: code es obligatorio.";
      const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : ".";
      // resolvePath valida también el realpath del cwd antes de lanzar el sandbox.
      manager.resolvePath(jid, cwd, { mustExist: true, allowDirectory: true });
      const extraArgs = Array.isArray(args.args) ? args.args.filter((value): value is string => typeof value === "string").slice(0, 40) : [];
      const timeoutSeconds = typeof args.timeout_seconds === "number" ? Math.max(1, Math.min(900, Math.trunc(args.timeout_seconds))) : 120;
      return await executeSandboxedCode({ manager, jid, runtime: runtime as "bash" | "python" | "node" | "bun", code, cwd, args: extraArgs, timeoutSeconds, signal });
    }
    return `Error: herramienta agentica desconocida "${name}".`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
