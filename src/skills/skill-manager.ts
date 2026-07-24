import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { executeSandboxedCode } from "../workspace/workspace-exec.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { getAppDir } from "../utils.ts";
import type { ClaudeSkillFrontmatter, RenderedSkill, SkillDefinition, SkillShell } from "./skill-types.ts";

const MAX_SKILL_FILE_BYTES = 1_000_000;
const MAX_RESOURCE_TEXT_BYTES = 2_000_000;
const MAX_DYNAMIC_OUTPUT_CHARS = 40_000;
const MAX_CATALOG_CHARS = 16_000;
const MAX_CATALOG_SKILLS = 100;
const DESCRIPTION_LIMIT = 1_536;
const SEARCH_DESCRIPTION_LIMIT = 700;

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTokens(value: string): string[] {
  return normalizeSearchText(value).split(" ").filter((token) => token.length > 1);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safeSkillId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) throw new Error(`Nombre de skill inválido: ${value}`);
  return id;
}

function toToolList(value: unknown): string[] {
  const sources = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];
  const output: string[] = [];
  for (const source of sources) {
    let current = "";
    let depth = 0;
    for (const char of source) {
      if (char === "(") depth += 1;
      else if (char === ")" && depth > 0) depth -= 1;
      if (depth === 0 && (char === "," || /\s/.test(char))) {
        if (current.trim()) output.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim()) output.push(current.trim());
  }
  return output;
}

function toArgumentsList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function toPathList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function firstParagraph(markdown: string): string {
  const text = markdown
    .replace(/^#+\s+/gm, "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("```"));
  return (text ?? "Skill sin descripción explícita.").replace(/\s+/g, " ").slice(0, DESCRIPTION_LIMIT);
}

function parseFrontmatter(raw: string): { frontmatter: ClaudeSkillFrontmatter; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const lines = normalized.split(/\r?\n/);
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error("SKILL.md contiene frontmatter YAML sin cierre ---.");
  const yamlText = lines.slice(1, end).join("\n");
  const parsed = parseYaml(yamlText);
  if (parsed != null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error("El frontmatter de SKILL.md debe ser un objeto YAML.");
  }
  return {
    frontmatter: (parsed ?? {}) as ClaudeSkillFrontmatter,
    body: lines.slice(end + 1).join("\n"),
  };
}

function tokenizeArguments(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) out.push(current);
  return out;
}

function replaceSkillArguments(body: string, rawArguments: string, names: string[]): { content: string; values: string[]; named: Record<string, string> } {
  const values = tokenizeArguments(rawArguments);
  const named = Object.fromEntries(names.map((name, index) => [name, values[index] ?? ""]));
  const sentinel = `__LUNA_ESCAPED_DOLLAR_${crypto.randomUUID()}__`;
  let content = body.replace(/(^|[^\\])\\\$/g, (_match, prefix: string) => `${prefix}${sentinel}`);
  const hadArgumentsToken = /\$ARGUMENTS(?:\[\d+\])?|\$\d+/.test(content) || names.some((name) => content.includes(`$${name}`));

  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) => values[Number(index)] ?? "");
  content = content.replace(/\$(\d+)/g, (_match, index: string) => values[Number(index)] ?? "");
  for (const [name, value] of Object.entries(named)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    content = content.replace(new RegExp(`\\$${escapedName}\\b`, "g"), value);
  }
  content = content.replace(/\$ARGUMENTS\b/g, rawArguments);
  content = content.replaceAll(sentinel, "$");
  if (rawArguments.trim() && !hadArgumentsToken) content = `${content.trimEnd()}\n\nARGUMENTS: ${rawArguments.trim()}\n`;
  return { content, values, named };
}

function copyMissingTree(source: string, destination: string): void {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, entry.name);
    const dst = join(destination, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copyMissingTree(src, dst);
      continue;
    }
    if (!entry.isFile() || existsSync(dst)) continue;
    cpSync(src, dst, { force: false });
  }
}

function copySkillTreeForExecution(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, entry.name);
    const dst = join(destination, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copySkillTreeForExecution(src, dst);
    } else if (entry.isFile()) {
      cpSync(src, dst, { force: true });
    }
  }
}

function sanitizeDynamicOutput(value: string): string {
  const clean = value.trim();
  if (clean.length <= MAX_DYNAMIC_OUTPUT_CHARS) return clean;
  return `${clean.slice(0, 28_000)}\n\n[...salida dinámica truncada...]\n\n${clean.slice(-10_000)}`;
}

function isTextLike(path: string): boolean {
  const name = path.toLowerCase();
  return !/\.(?:png|jpe?g|gif|webp|avif|pdf|zip|tar|gz|7z|rar|mp3|mp4|wav|ogg|opus|woff2?|ttf|exe|dll|so|dylib|bin)$/i.test(name);
}

export interface SkillManagerOptions {
  appDir?: string;
  persistentDir?: string;
  bundledDirs?: string[];
}

export class SkillManager {
  readonly appDir: string;
  readonly persistentDir: string;
  readonly skillsDir: string;
  readonly bundledDirs: string[];
  private readonly sessionIds = new Map<string, string>();

  constructor(options: SkillManagerOptions = {}) {
    this.appDir = resolve(options.appDir ?? getAppDir());
    this.persistentDir = resolve(options.persistentDir ?? join(this.appDir, "persistent"));
    this.skillsDir = join(this.persistentDir, "skills");
    this.bundledDirs = options.bundledDirs?.map((item) => resolve(item)) ?? [
      join(this.appDir, "skills"),
      join(this.appDir, "assets", "skills"),
    ];
    mkdirSync(this.skillsDir, { recursive: true });
    this.bootstrapBundledSkills();
  }

  bootstrapBundledSkills(): void {
    for (const source of this.bundledDirs) {
      if (!existsSync(source) || resolve(source) === resolve(this.skillsDir)) continue;
      copyMissingTree(source, this.skillsDir);
    }
  }

  private sessionId(jid: string): string {
    const existing = this.sessionIds.get(jid);
    if (existing) return existing;
    const generated = crypto.randomUUID();
    this.sessionIds.set(jid, generated);
    return generated;
  }

  private resolveSkillDir(skillName: string): { id: string; directory: string } {
    const requested = safeSkillId(skillName);
    const direct = join(this.skillsDir, requested);
    if (existsSync(direct) && statSync(direct).isDirectory()) {
      const realRoot = realpathSync(this.skillsDir);
      const realDirectory = realpathSync(direct);
      if (!isInside(realRoot, realDirectory)) throw new Error("La skill resuelve fuera del repositorio global mediante un enlace no permitido.");
      return { id: requested, directory: direct };
    }
    // Compatibilidad de mayúsculas/etiqueta: buscar por id de directorio.
    for (const entry of readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.toLowerCase() !== requested) continue;
      const candidate = join(this.skillsDir, entry.name);
      const realRoot = realpathSync(this.skillsDir);
      const realDirectory = realpathSync(candidate);
      if (!isInside(realRoot, realDirectory)) throw new Error("La skill resuelve fuera del repositorio global mediante un enlace no permitido.");
      return { id: entry.name.toLowerCase(), directory: candidate };
    }
    throw new Error(`Skill global no encontrada: ${skillName}`);
  }

  get(skillName: string): SkillDefinition {
    const { id, directory } = this.resolveSkillDir(skillName);
    const skillFile = join(directory, "SKILL.md");
    if (!existsSync(skillFile) || !statSync(skillFile).isFile()) throw new Error(`La skill ${id} no contiene SKILL.md.`);
    if (statSync(skillFile).size > MAX_SKILL_FILE_BYTES) throw new Error(`SKILL.md de ${id} supera el límite de ${MAX_SKILL_FILE_BYTES} bytes.`);
    const raw = readFileSync(skillFile, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const displayName = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : basename(directory);
    const whenToUseRaw = typeof frontmatter.when_to_use === "string"
      ? frontmatter.when_to_use
      : typeof frontmatter["when-to-use"] === "string" ? frontmatter["when-to-use"] as string : "";
    const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : firstParagraph(body);
    const shell: SkillShell = frontmatter.shell === "powershell" ? "powershell" : "bash";
    return {
      id,
      displayName,
      description,
      license: typeof frontmatter.license === "string" ? frontmatter.license.trim() : undefined,
      compatibility: typeof frontmatter.compatibility === "string" ? frontmatter.compatibility.trim() : undefined,
      metadata: frontmatter.metadata && typeof frontmatter.metadata === "object" && !Array.isArray(frontmatter.metadata) ? frontmatter.metadata as Record<string, unknown> : {},
      whenToUse: whenToUseRaw.trim(),
      argumentHint: typeof frontmatter["argument-hint"] === "string" ? frontmatter["argument-hint"].trim() : undefined,
      arguments: toArgumentsList(frontmatter.arguments),
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
      userInvocable: frontmatter["user-invocable"] !== false,
      allowedTools: toToolList(frontmatter["allowed-tools"]),
      disallowedTools: toToolList(frontmatter["disallowed-tools"]),
      model: typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined,
      effort: typeof frontmatter.effort === "string" ? frontmatter.effort.trim() : undefined,
      context: typeof frontmatter.context === "string" ? frontmatter.context.trim() : undefined,
      agent: typeof frontmatter.agent === "string" ? frontmatter.agent.trim() : undefined,
      hooks: frontmatter.hooks,
      paths: toPathList(frontmatter.paths),
      shell,
      directory,
      skillFile,
      body,
      frontmatter,
    };
  }

  list(options: { includeManualOnly?: boolean } = {}): SkillDefinition[] {
    this.bootstrapBundledSkills();
    const skills: SkillDefinition[] = [];
    for (const entry of readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const skill = this.get(entry.name);
        if (!options.includeManualOnly && skill.disableModelInvocation) continue;
        skills.push(skill);
      } catch {
        // Un directorio roto no debe tumbar el catálogo completo.
      }
    }
    return skills.sort((a, b) => a.id.localeCompare(b.id));
  }

  hasUserInvocable(skillName: string): boolean {
    try { return this.get(skillName).userInvocable; } catch { return false; }
  }

  buildCatalogForModel(): string {
    const all = this.list({ includeManualOnly: false }).slice(0, MAX_CATALOG_SKILLS);
    if (!all.length) return "No hay skills globales model-invocable instaladas.";
    const lines = [
      "Skills globales disponibles (carga el cuerpo solo cuando sea relevante mediante skill_load):",
    ];
    let chars = lines[0]!.length;
    for (const skill of all) {
      const description = [skill.description, skill.whenToUse].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, DESCRIPTION_LIMIT);
      const row = `- ${skill.id}: ${description}${skill.context === "fork" ? " [context: fork]" : ""}${skill.paths.length ? ` [paths: ${skill.paths.join(", ")}]` : ""}`;
      if (chars + row.length + 1 > MAX_CATALOG_CHARS) break;
      lines.push(row);
      chars += row.length + 1;
    }
    return lines.join("\n");
  }

  searchForModel(query: string, limit = 5): string {
    const cleanQuery = query.replace(/\s+/g, " ").trim();
    if (!cleanQuery) return "Error: query es obligatorio para buscar skills.";
    const normalizedQuery = normalizeSearchText(cleanQuery);
    const queryTokens = new Set(searchTokens(cleanQuery));
    const ranked = this.list({ includeManualOnly: false })
      .map((skill) => {
        const description = [skill.description, skill.whenToUse].filter(Boolean).join(" ").replace(/\s+/g, " ");
        const haystack = normalizeSearchText([
          skill.id,
          skill.displayName,
          description,
          skill.paths.join(" "),
        ].join(" "));
        const tokens = new Set(searchTokens(haystack));
        let overlap = 0;
        for (const token of queryTokens) if (tokens.has(token)) overlap += 1;
        const idExact = normalizedQuery === normalizeSearchText(skill.id) ? 8 : 0;
        const phrase = haystack.includes(normalizedQuery) ? 5 : 0;
        const prefix = normalizeSearchText(skill.id).startsWith(normalizedQuery) ? 3 : 0;
        const coverage = queryTokens.size > 0 ? overlap / queryTokens.size : 0;
        return { skill, description, score: idExact + phrase + prefix + coverage * 4 + overlap * 0.2 };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
      .slice(0, Math.max(1, Math.min(10, Math.trunc(limit))));
    if (!ranked.length) return `No encontré skills relevantes para: ${cleanQuery}`;
    return [
      `Skills relevantes para "${cleanQuery}" (carga solo la necesaria con skill_load):`,
      ...ranked.map(({ skill, description }) => `- ${skill.id}: ${description.slice(0, SEARCH_DESCRIPTION_LIMIT)}${skill.context === "fork" ? " [context: fork]" : ""}`),
    ].join("\n");
  }

  formatListForUser(): string {
    const skills = this.list({ includeManualOnly: true });
    if (!skills.length) return "🧩 No hay skills instaladas en persistent/skills.";
    return [
      "🧩 SKILLS GLOBALES",
      ...skills.map((skill) => `- /${skill.id}${skill.argumentHint ? ` ${skill.argumentHint}` : ""} — ${skill.description}${skill.disableModelInvocation ? " · manual" : ""}${skill.userInvocable ? "" : " · solo agente"}`),
    ].join("\n");
  }

  private resolveResource(skill: SkillDefinition, resourcePath: string): string {
    const normalized = resourcePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || normalized.includes("\0") || isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) {
      throw new Error("La ruta del recurso debe permanecer dentro de la skill.");
    }
    const candidate = resolve(skill.directory, normalized);
    const realSkill = realpathSync(skill.directory);
    if (!existsSync(candidate)) throw new Error(`No existe el recurso ${normalized} en ${skill.id}.`);
    const realCandidate = realpathSync(candidate);
    if (!isInside(realSkill, realCandidate)) throw new Error("El recurso resuelve fuera de la skill mediante un enlace simbólico.");
    return candidate;
  }

  listResources(skillName: string, maxEntries = 300): string[] {
    const skill = this.get(skillName);
    const root = realpathSync(skill.directory);
    const output: string[] = [];
    const walk = (current: string): void => {
      if (output.length >= maxEntries) return;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (output.length >= maxEntries) break;
        const candidate = join(current, entry.name);
        const rel = relative(root, candidate).replace(/\\/g, "/");
        if (entry.isSymbolicLink()) {
          output.push(`🔗 ${rel}`);
          continue;
        }
        if (entry.isDirectory()) {
          output.push(`📁 ${rel}`);
          walk(candidate);
        } else if (entry.isFile()) {
          output.push(`📄 ${rel} — ${statSync(candidate).size} bytes`);
        }
      }
    };
    walk(root);
    return output;
  }

  readResource(skillName: string, resourcePath: string, maxChars = 100_000): string {
    const skill = this.get(skillName);
    const target = this.resolveResource(skill, resourcePath);
    if (!statSync(target).isFile()) throw new Error("El recurso solicitado no es un archivo.");
    if (!isTextLike(target)) return `Recurso binario: ${resourcePath} (${statSync(target).size} bytes). Usa skill_copy_resource o skill_run_script según corresponda.`;
    if (statSync(target).size > MAX_RESOURCE_TEXT_BYTES) throw new Error(`El recurso supera el límite de lectura textual de ${MAX_RESOURCE_TEXT_BYTES} bytes.`);
    const text = readFileSync(target, "utf8");
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[Contenido truncado]` : text;
  }

  copyResourceToWorkspace(skillName: string, resourcePath: string, destination: string, workspace: WorkspaceManager, jid: string): string {
    const skill = this.get(skillName);
    const source = this.resolveResource(skill, resourcePath);
    const target = workspace.resolvePath(jid, destination, { allowDirectory: true });
    if (lstatSync(source).isSymbolicLink()) throw new Error("No se copian enlaces simbólicos desde una skill.");
    mkdirSync(dirname(target), { recursive: true });
    if (statSync(source).isDirectory()) cpSync(source, target, { recursive: true, dereference: false, errorOnExist: false, force: true });
    else cpSync(source, target, { force: true });
    return workspace.relativePath(jid, target);
  }

  private async executeDynamicShell(jid: string, workspace: WorkspaceManager, skill: SkillDefinition, command: string, signal?: AbortSignal): Promise<string> {
    const shell = skill.shell;
    const environmentPrefix = [
      `export CLAUDE_SKILL_DIR=/skills/${skill.id}`,
      "export CLAUDE_PROJECT_DIR=/workspace",
      `export CLAUDE_SESSION_ID=${JSON.stringify(this.sessionId(jid))}`,
      "export CLAUDE_EFFORT=medium",
    ].join("; ");
    const runtime = shell === "powershell" ? "powershell" : "bash";
    const code = shell === "powershell" ? command : `${environmentPrefix}; ${command}`;
    const result = await executeSandboxedCode({
      manager: workspace,
      jid,
      runtime,
      code,
      cwd: ".",
      args: [],
      timeoutSeconds: 120,
      signal,
      env: {
        CLAUDE_SKILL_DIR: `/skills/${skill.id}`,
        CLAUDE_PROJECT_DIR: "/workspace",
        CLAUDE_SESSION_ID: this.sessionId(jid),
        CLAUDE_EFFORT: "medium",
        LUNA_SKILL_ID: skill.id,
      },
    });
    if (result.startsWith("Error:")) throw new Error(result);
    return sanitizeDynamicOutput(result);
  }

  private replaceClaudeVariables(content: string, jid: string, skill: SkillDefinition): string {
    return content
      .replaceAll("${CLAUDE_SESSION_ID}", this.sessionId(jid))
      .replaceAll("${CLAUDE_EFFORT}", "medium")
      .replaceAll("${CLAUDE_SKILL_DIR}", `/skills/${skill.id}`)
      .replaceAll("${CLAUDE_PROJECT_DIR}", "/workspace");
  }

  private async expandDynamicCommands(content: string, jid: string, workspace: WorkspaceManager, skill: SkillDefinition, signal?: AbortSignal): Promise<{ content: string; count: number }> {
    // Claude ejecuta sustituciones dinámicas una sola vez sobre el SKILL.md
    // original. Usamos placeholders opacos para impedir que la salida de un
    // comando pueda introducir otro !`command` que luego se ejecute.
    const commands: Array<{ token: string; command: string }> = [];
    let rendered = content.replace(/```!\s*\r?\n([\s\S]*?)\r?\n```/g, (_match, raw: string) => {
      const command = raw.trim();
      if (!command) return "";
      const token = `__LUNA_SKILL_DYNAMIC_${crypto.randomUUID()}__`;
      commands.push({ token, command });
      return token;
    });
    rendered = rendered.replace(/(^|[\t ])!`([^`\r\n]+)`/gm, (_match, prefix: string, raw: string) => {
      const command = raw.trim();
      if (!command) return prefix;
      const token = `__LUNA_SKILL_DYNAMIC_${crypto.randomUUID()}__`;
      commands.push({ token, command });
      return `${prefix}${token}`;
    });

    for (const item of commands) {
      const output = await this.executeDynamicShell(jid, workspace, skill, item.command, signal);
      rendered = rendered.replace(item.token, output);
    }
    return { content: rendered, count: commands.length };
  }

  async render(skillName: string, rawArguments: string, workspace: WorkspaceManager, jid: string, options: { modelInvocation?: boolean; executeDynamicCommands?: boolean; signal?: AbortSignal } = {}): Promise<RenderedSkill> {
    const skill = this.get(skillName);
    if (options.modelInvocation && skill.disableModelInvocation) {
      throw new Error(`La skill ${skill.id} tiene disable-model-invocation: true y solo puede ser invocada explícitamente por el usuario.`);
    }
    const substituted = replaceSkillArguments(skill.body, rawArguments, skill.arguments);
    let content = this.replaceClaudeVariables(substituted.content, jid, skill);
    let dynamicCommandsExecuted = 0;
    if (options.executeDynamicCommands !== false && /(?:^|[\t ])!`|```!/m.test(content)) {
      const expanded = await this.expandDynamicCommands(content, jid, workspace, skill, options.signal);
      content = expanded.content;
      dynamicCommandsExecuted = expanded.count;
    }
    const compatibility = [
      `[LUNA SKILL: ${skill.id}]`,
      `Directorio global de solo lectura dentro del sandbox: /skills/${skill.id}`,
      `Alias del workdir: .skills/${skill.id}`,
      skill.license ? `license: ${skill.license}` : "",
      skill.compatibility ? `compatibility: ${skill.compatibility}` : "",
      skill.paths.length ? `paths: ${skill.paths.join(", ")} (activa automáticamente solo cuando la tarea trabaja con rutas compatibles)` : "",
      skill.allowedTools.length ? `allowed-tools declaradas por la skill: ${skill.allowedTools.join(", ")} (solo pre-aprueban dentro de permisos existentes; nunca amplían permisos de Luna)` : "",
      skill.disallowedTools.length ? `disallowed-tools declaradas: ${skill.disallowedTools.join(", ")}` : "",
      skill.model ? `model solicitado por la skill: ${skill.model} (Luna mantiene el modelo autorizado por la sesión si no existe ese modelo)` : "",
      skill.effort ? `effort solicitado: ${skill.effort}` : "",
      skill.context === "fork" ? `context: fork; debe ejecutarse en contexto aislado/subagente cuando el runtime llamador soporte delegación.` : "",
      skill.agent ? `agent solicitado: ${skill.agent}` : "",
      skill.hooks ? "La skill declara hooks de Claude. Luna conserva el metadato; los permisos y validaciones autoritativas de Luna siempre prevalecen." : "",
    ].filter(Boolean).join("\n");
    return {
      skill,
      content: `${compatibility}\n\n${content.trim()}`,
      argumentsText: rawArguments,
      argumentValues: substituted.values,
      namedArguments: substituted.named,
      dynamicCommandsExecuted,
    };
  }

  async runScript(options: {
    skillName: string;
    path: string;
    workspace: WorkspaceManager;
    jid: string;
    args?: string[];
    cwd?: string;
    runtime?: "auto" | "bash" | "python" | "node" | "bun" | "powershell";
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const skill = this.get(options.skillName);
    const source = this.resolveResource(skill, options.path);
    if (!statSync(source).isFile()) throw new Error("El recurso ejecutable debe ser un archivo.");

    // Materializar una copia privada evita ejecutar desde persistent/ con escritura
    // y permite que el script use recursos hermanos sin modificar la skill global.
    const runRootRelative = `.skill-runtime/${skill.id}/${crypto.randomUUID()}`;
    const runRoot = options.workspace.resolveInternalPath(options.jid, runRootRelative);
    mkdirSync(dirname(runRoot), { recursive: true });
    copySkillTreeForExecution(skill.directory, runRoot);
    const sourceRelative = relative(skill.directory, source).replace(/\\/g, "/");
    const copiedRelative = `${runRootRelative}/${sourceRelative}`;
    const copiedAbsolute = options.workspace.resolveInternalPath(options.jid, copiedRelative, { mustExist: true });
    const ext = copiedAbsolute.toLowerCase().split(".").pop() ?? "";
    let runtime = options.runtime ?? "auto";
    if (runtime === "auto") {
      if (["py", "pyw"].includes(ext)) runtime = "python";
      else if (["ps1", "exe"].includes(ext)) runtime = "powershell";
      else if (["js", "mjs", "cjs", "ts", "mts", "cts"].includes(ext)) runtime = ext.includes("ts") ? "bun" : "node";
      else runtime = "bash";
    }
    const args = options.args ?? [];
    const quotedPath = JSON.stringify(`/workspace/${copiedRelative}`);
    const argJson = JSON.stringify(args);
    let code: string;
    if (runtime === "python") {
      code = `import runpy, sys; sys.argv=[${quotedPath}, *${argJson}]; runpy.run_path(${quotedPath}, run_name='__main__')`;
    } else if (runtime === "node") {
      code = `process.argv=[process.argv[0], ${quotedPath}, ...${argJson}]; import('file://' + ${quotedPath}).catch((error) => { console.error(error); process.exitCode = 1; });`;
    } else if (runtime === "bun") {
      code = `process.argv=[process.argv[0], ${quotedPath}, ...${argJson}]; import('file://' + ${quotedPath}).catch((error) => { console.error(error); process.exitCode = 1; });`;
    } else if (runtime === "powershell") {
      const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
      code = `& ${psQuote(`/workspace/${copiedRelative}`)} ${args.map(psQuote).join(" ")}`.trim();
    } else {
      const shellArgs = args.map((item) => `'${item.replace(/'/g, `'"'"'`)}'`).join(" ");
      code = `chmod +x ${quotedPath} 2>/dev/null || true; ${quotedPath}${shellArgs ? ` ${shellArgs}` : ""}`;
    }
    try {
      return await executeSandboxedCode({
        manager: options.workspace,
        jid: options.jid,
        runtime,
        code,
        cwd: options.cwd?.trim() || ".",
        args: [],
        timeoutSeconds: Math.max(1, Math.min(900, options.timeoutSeconds ?? 120)),
        signal: options.signal,
        env: {
          CLAUDE_SKILL_DIR: `/workspace/${runRootRelative}`,
          CLAUDE_PROJECT_DIR: "/workspace",
          CLAUDE_SESSION_ID: this.sessionId(options.jid),
          CLAUDE_EFFORT: "medium",
          LUNA_SKILL_ID: skill.id,
        },
      });
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  }
}
