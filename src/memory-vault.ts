import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "./ai.ts";
import { getAppDir } from "./utils.ts";
import {
  ensureParentDirectory,
  sanitizePathSegment,
  writeTextFileAtomically,
} from "./storage.ts";

export const MEMORY_VAULT_MAX_NOTES = 512;
export const MEMORY_VAULT_MAX_NOTE_CHARS = 256_000;
export const MEMORY_VAULT_MAX_TOTAL_CHARS = 16_000_000;
export const MEMORY_VAULT_DEFAULT_SEARCH_LIMIT = 8;

const INTERNAL_DIR = ".luna";
const TRASH_DIR = ".trash";
const STOP_WORDS = new Set([
  "a", "al", "algo", "como", "con", "cual", "cuando", "de", "del", "el", "en", "es", "esa", "ese",
  "esta", "este", "guardadas", "guardado", "hay", "la", "las", "lo", "los", "me", "mi", "mis",
  "que", "qué", "quiero", "se", "tengo", "tiene", "un", "una", "y",
]);
const SECRET_PATTERN = /(?:contrase(?:ñ|n)a|password|api[_ -]?key|token|secret|otp|c[oó]digo\s+de\s+verificaci[oó]n)\s*[:=]\s*\S+/iu;

export type VaultScalar = string | number | boolean | null;
export type VaultPropertyValue = VaultScalar | VaultScalar[];
export type VaultProperties = Record<string, VaultPropertyValue>;

export interface MemoryVaultNote {
  id: string;
  path: string;
  slug: string;
  title: string;
  type: string;
  tags: string[];
  aliases: string[];
  summary: string;
  pinned: boolean;
  created: string;
  updated: string;
  source: string;
  properties: VaultProperties;
  content: string;
  links: string[];
  size: number;
}

export interface MemoryVaultSearchResult {
  note: MemoryVaultNote;
  score: number;
  snippet: string;
  matchedTerms: string[];
}

export interface MemoryVaultUpsertInput {
  note?: string;
  title: string;
  content: string;
  mode?: "replace" | "append";
  folder?: string;
  type?: string;
  tags?: string[];
  aliases?: string[];
  summary?: string;
  pinned?: boolean;
  properties?: VaultProperties;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

function slugify(value: string): string {
  const slug = normalizeText(value)
    .replace(/[/.]+/g, "-")
    .replace(/[^a-z0-9@_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || `nota-${Date.now()}`;
}

function safeFolder(value: string | undefined): string {
  if (!value?.trim()) return "";
  const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("La carpeta de la bóveda contiene un segmento no permitido.");
  }
  return segments.map((segment) => slugify(segment)).join("/");
}

function yamlScalar(value: VaultScalar): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function parseScalar(value: string): VaultScalar {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return trimmed.startsWith('"') ? JSON.parse(trimmed) as string : trimmed.slice(1, -1).replace(/''/g, "'");
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseFrontmatter(raw: string): { properties: VaultProperties; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return { properties: {}, body: normalized };
  }
  const lines = normalized.split(/\r?\n/);
  let end = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === "---") {
      end = index;
      break;
    }
  }
  if (end < 0) return { properties: {}, body: normalized };

  const properties: VaultProperties = {};
  let currentList: string | null = null;
  for (const line of lines.slice(1, end)) {
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentList) {
      const current = properties[currentList];
      const values = Array.isArray(current) ? current : [];
      values.push(parseScalar(listMatch[1] ?? ""));
      properties[currentList] = values;
      continue;
    }
    const propertyMatch = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!propertyMatch) continue;
    const key = propertyMatch[1] ?? "";
    const value = propertyMatch[2] ?? "";
    if (!value.trim()) {
      properties[key] = [];
      currentList = key;
    } else {
      properties[key] = parseScalar(value);
      currentList = null;
    }
  }
  return {
    properties,
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""),
  };
}

function serializeFrontmatter(properties: VaultProperties): string {
  const preferred = ["id", "title", "type", "tags", "aliases", "summary", "pinned", "created", "updated", "source"];
  const keys = [
    ...preferred.filter((key) => Object.prototype.hasOwnProperty.call(properties, key)),
    ...Object.keys(properties).filter((key) => !preferred.includes(key)).sort(),
  ];
  const lines = ["---"];
  for (const key of keys) {
    const value = properties[key];
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value ?? null)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function propertyString(properties: VaultProperties, key: string, fallback = ""): string {
  const value = properties[key];
  return typeof value === "string" ? value.trim() : fallback;
}

function propertyBoolean(properties: VaultProperties, key: string): boolean {
  return properties[key] === true;
}

function propertyStringArray(properties: VaultProperties, key: string): string[] {
  const value = properties[key];
  if (!Array.isArray(value)) return typeof value === "string" && value.trim() ? [value.trim()] : [];
  return uniqueStrings(value);
}

function extractTitle(body: string, fallback: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

function extractSummary(body: string): string {
  return body
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, "$2$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function extractLinks(body: string): string[] {
  const links = new Set<string>();
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  for (const match of body.matchAll(pattern)) {
    const link = match[1]?.trim();
    if (link) links.add(link.replace(/\.md$/i, ""));
  }
  return [...links];
}

function excerptAround(body: string, terms: string[], maxChars = 420): string {
  const clean = body.replace(/^#+\s+/gm, "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const normalized = normalizeText(clean);
  let position = -1;
  for (const term of terms) {
    position = normalized.indexOf(term);
    if (position >= 0) break;
  }
  if (position < 0) return `${clean.slice(0, maxChars - 1)}…`;
  const start = Math.max(0, position - Math.floor(maxChars / 3));
  const excerpt = clean.slice(start, start + maxChars);
  return `${start > 0 ? "…" : ""}${excerpt}${start + maxChars < clean.length ? "…" : ""}`;
}

function tokenize(query: string): string[] {
  return [...new Set(normalizeText(query)
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term)))];
}

function isInside(root: string, candidate: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(rootWithSep);
}

function nearestExistingAncestor(path: string, root: string): string {
  let current = path;
  while (!existsSync(current) && current !== root) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function walkMarkdown(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === INTERNAL_DIR || entry.name === TRASH_DIR) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) results.push(...walkMarkdown(root, path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") results.push(path);
  }
  return results;
}

function validateNoSecrets(content: string, properties: VaultProperties): void {
  if (SECRET_PATTERN.test(content)) {
    throw new Error("La bóveda Markdown no almacena contraseñas, tokens, API keys ni OTP. Usa el almacén cifrado de credenciales correspondiente.");
  }
  const forbiddenKey = Object.keys(properties).find((key) => /password|contrase(?:n|ñ)a|token|api.?key|secret|otp/i.test(key));
  if (forbiddenKey) {
    throw new Error(`La propiedad ${forbiddenKey} parece contener un secreto y no puede guardarse en la bóveda Markdown.`);
  }
}

export class PersistentMemoryVault {
  private readonly testBaseDir?: string;
  private readonly catalogCache = new Map<string, { fingerprint: string; notes: MemoryVaultNote[] }>();

  constructor(testBaseDir?: string) {
    this.testBaseDir = testBaseDir;
  }

  private contextRoot(jid: string): string {
    const base = this.testBaseDir ?? join(getAppDir(), "persistent", "contexts");
    return join(base, sanitizePathSegment(jid));
  }

  getVaultRoot(jid: string): string {
    return join(this.contextRoot(jid), "vault");
  }

  init(jid: string): void {
    const root = this.getVaultRoot(jid);
    mkdirSync(join(root, INTERNAL_DIR), { recursive: true });
    mkdirSync(join(root, TRASH_DIR), { recursive: true });
  }

  private invalidate(jid: string): void {
    this.catalogCache.delete(jid);
  }

  private resolveSafePath(jid: string, relativePath: string): string {
    const root = resolve(this.getVaultRoot(jid));
    const candidate = resolve(root, relativePath.replace(/\\/g, "/"));
    if (!isInside(root, candidate)) throw new Error("La ruta resuelve fuera de la bóveda del usuario.");
    const realRoot = realpathSync(root);
    const existingAncestor = nearestExistingAncestor(candidate, root);
    const realAncestor = realpathSync(existingAncestor);
    if (!isInside(realRoot, realAncestor)) {
      throw new Error("La ruta de la bóveda atraviesa un enlace simbólico externo.");
    }
    if (existsSync(candidate) && !isInside(realRoot, realpathSync(candidate))) {
      throw new Error("La nota resuelve fuera de la bóveda mediante un enlace simbólico.");
    }
    const rel = relative(root, candidate).replace(/\\/g, "/");
    if (!rel || rel.startsWith(".") || rel.split("/").some((part) => part.startsWith("."))) {
      throw new Error("La ruta interna de la bóveda no está permitida.");
    }
    return candidate;
  }

  private parseNote(jid: string, absolutePath: string): MemoryVaultNote {
    const root = this.getVaultRoot(jid);
    const raw = readFileSync(absolutePath, "utf8");
    const parsed = parseFrontmatter(raw);
    const path = relative(root, absolutePath).replace(/\\/g, "/");
    const fallbackSlug = path.replace(/\.md$/i, "");
    const fallbackTitle = basename(path, extname(path)).replace(/[-_]+/g, " ");
    const properties = parsed.properties;
    const stat = statSync(absolutePath);
    const created = propertyString(properties, "created", stat.birthtime.toISOString());
    const updated = propertyString(properties, "updated", stat.mtime.toISOString());
    const title = propertyString(properties, "title", extractTitle(parsed.body, fallbackTitle));
    const summary = propertyString(properties, "summary", extractSummary(parsed.body));
    return {
      id: propertyString(properties, "id", `legacy-${slugify(path)}`),
      path,
      slug: fallbackSlug,
      title,
      type: propertyString(properties, "type", "note"),
      tags: propertyStringArray(properties, "tags"),
      aliases: propertyStringArray(properties, "aliases"),
      summary,
      pinned: propertyBoolean(properties, "pinned"),
      created,
      updated,
      source: propertyString(properties, "source", "user"),
      properties,
      content: parsed.body,
      links: extractLinks(parsed.body),
      size: raw.length,
    };
  }

  listNotes(jid: string): MemoryVaultNote[] {
    this.init(jid);
    const root = this.getVaultRoot(jid);
    const paths = walkMarkdown(root).sort();
    if (paths.length > MEMORY_VAULT_MAX_NOTES) {
      throw new Error(`La bóveda excede el límite de ${MEMORY_VAULT_MAX_NOTES} notas.`);
    }
    const fingerprint = paths.map((path) => {
      const stat = statSync(path);
      return `${relative(root, path)}:${stat.size}:${stat.mtimeMs}`;
    }).join("|");
    const cached = this.catalogCache.get(jid);
    if (cached?.fingerprint === fingerprint) return cached.notes;

    let total = 0;
    const notes = paths.map((path) => {
      const note = this.parseNote(jid, path);
      total += note.size;
      return note;
    });
    if (total > MEMORY_VAULT_MAX_TOTAL_CHARS) {
      throw new Error(`La bóveda excede el límite total de ${MEMORY_VAULT_MAX_TOTAL_CHARS} caracteres.`);
    }
    this.catalogCache.set(jid, { fingerprint, notes });
    return notes;
  }

  private resolveNote(jid: string, ref: string): MemoryVaultNote {
    const clean = ref.trim().replace(/^\[\[|\]\]$/g, "").replace(/#.*$/, "").replace(/\.md$/i, "");
    if (!clean) throw new Error("Debes indicar una nota.");
    const normalizedRef = normalizeText(clean);
    const candidates = this.listNotes(jid).filter((note) => {
      const pathNoExt = note.path.replace(/\.md$/i, "");
      return [note.id, note.path, pathNoExt, note.slug, note.title, ...note.aliases]
        .some((value) => normalizeText(value) === normalizedRef);
    });
    if (candidates.length === 0) throw new Error(`No existe una nota que coincida con "${ref}".`);
    if (candidates.length > 1) {
      throw new Error(`La referencia "${ref}" es ambigua: ${candidates.map((note) => note.path).join(", ")}.`);
    }
    return candidates[0]!;
  }

  read(jid: string, ref: string): MemoryVaultNote {
    return this.resolveNote(jid, ref);
  }

  list(
    jid: string,
    filters: { folder?: string; type?: string; tag?: string; limit?: number; sort?: "updated" | "created" | "title" } = {},
  ): MemoryVaultNote[] {
    const folder = filters.folder ? safeFolder(filters.folder) : "";
    const type = normalizeText(filters.type ?? "");
    const tag = normalizeText(filters.tag ?? "");
    const limit = Math.max(1, Math.min(100, filters.limit ?? 50));
    const notes = this.listNotes(jid).filter((note) => {
      if (folder && !(note.path === `${folder}.md` || note.path.startsWith(`${folder}/`))) return false;
      if (type && normalizeText(note.type) !== type) return false;
      if (tag && !note.tags.some((value) => normalizeText(value) === tag)) return false;
      return true;
    });
    const sort = filters.sort ?? "updated";
    notes.sort((a, b) => sort === "title"
      ? a.title.localeCompare(b.title, "es")
      : Date.parse(sort === "created" ? b.created : b.updated) - Date.parse(sort === "created" ? a.created : a.updated));
    return notes.slice(0, limit);
  }

  search(
    jid: string,
    query: string,
    filters: { type?: string; tags?: string[]; folder?: string; property?: string; value?: string; limit?: number } = {},
  ): MemoryVaultSearchResult[] {
    const phrase = normalizeText(query);
    const terms = tokenize(query);
    const requiredTags = uniqueStrings(filters.tags ?? []).map(normalizeText);
    const type = normalizeText(filters.type ?? "");
    const folder = filters.folder ? safeFolder(filters.folder) : "";
    const property = filters.property?.trim();
    const propertyValue = normalizeText(filters.value ?? "");
    const limit = Math.max(1, Math.min(30, filters.limit ?? MEMORY_VAULT_DEFAULT_SEARCH_LIMIT));

    const results: MemoryVaultSearchResult[] = [];
    for (const note of this.listNotes(jid)) {
      if (type && normalizeText(note.type) !== type) continue;
      if (folder && !note.path.startsWith(`${folder}/`) && note.path !== `${folder}.md`) continue;
      const normalizedTags = note.tags.map(normalizeText);
      if (requiredTags.some((tag) => !normalizedTags.includes(tag))) continue;
      if (property) {
        if (!Object.prototype.hasOwnProperty.call(note.properties, property)) continue;
        if (propertyValue && !normalizeText(JSON.stringify(note.properties[property])).includes(propertyValue)) continue;
      }

      const title = normalizeText(note.title);
      const aliasValues = note.aliases.map(normalizeText);
      const aliases = aliasValues.join(" ");
      const tags = normalizeText(note.tags.join(" "));
      const meta = normalizeText(`${note.type} ${note.summary} ${JSON.stringify(note.properties)}`);
      const body = normalizeText(note.content);
      const path = normalizeText(note.path);
      let score = note.pinned ? 3 : 0;
      const matchedTerms: string[] = [];
      if (!phrase && terms.length === 0) score += 1;
      if (phrase) {
        if (title === phrase || aliasValues.includes(phrase)) score += 100;
        else if (title.includes(phrase)) score += 55;
        if (body.includes(phrase)) score += 24;
        if (meta.includes(phrase)) score += 18;
      }
      for (const term of terms) {
        let matched = false;
        if (title.includes(term)) { score += 20; matched = true; }
        if (aliases.includes(term)) { score += 16; matched = true; }
        if (tags.includes(term)) { score += 14; matched = true; }
        if (path.includes(term)) { score += 8; matched = true; }
        if (meta.includes(term)) { score += 6; matched = true; }
        if (body.includes(term)) { score += 4; matched = true; }
        if (matched) matchedTerms.push(term);
      }
      if ((phrase || terms.length > 0) && score <= (note.pinned ? 3 : 0)) continue;
      results.push({ note, score, snippet: excerptAround(note.content, terms), matchedTerms });
    }
    return results
      .sort((a, b) => b.score - a.score || Date.parse(b.note.updated) - Date.parse(a.note.updated))
      .slice(0, limit);
  }

  upsert(jid: string, input: MemoryVaultUpsertInput): { note: MemoryVaultNote; created: boolean } {
    this.init(jid);
    const title = input.title.trim();
    if (!title) throw new Error("El título de la nota es obligatorio.");
    if (!input.content.trim() && input.mode !== "append") throw new Error("El contenido de la nota no puede estar vacío.");

    let existing: MemoryVaultNote | null = null;
    if (input.note?.trim()) existing = this.resolveNote(jid, input.note);
    else {
      const matches = this.listNotes(jid).filter((note) => normalizeText(note.title) === normalizeText(title));
      if (matches.length === 1) existing = matches[0]!;
      else if (matches.length > 1) throw new Error(`Ya existen varias notas tituladas "${title}"; indica note explícitamente.`);
    }

    const now = new Date().toISOString();
    const created = !existing;
    const folder = existing ? dirname(existing.path) === "." ? "" : dirname(existing.path) : safeFolder(input.folder);
    const relativePath = existing?.path ?? `${folder ? `${folder}/` : ""}${slugify(title)}.md`;
    const absolutePath = this.resolveSafePath(jid, relativePath);
    if (!existing && existsSync(absolutePath)) throw new Error(`Ya existe la ruta ${relativePath}.`);

    const oldProperties = existing?.properties ?? {};
    const mergedProperties: VaultProperties = {
      ...oldProperties,
      ...(input.properties ?? {}),
      id: existing?.id ?? `mem-${crypto.randomUUID()}`,
      title,
      type: input.type?.trim() || existing?.type || "note",
      tags: uniqueStrings(input.tags ?? existing?.tags ?? []),
      aliases: uniqueStrings(input.aliases ?? existing?.aliases ?? []),
      summary: input.summary?.trim() || existing?.summary || extractSummary(input.content),
      pinned: input.pinned ?? existing?.pinned ?? false,
      created: existing?.created ?? now,
      updated: now,
      source: existing?.source ?? "user",
    };
    const body = existing && input.mode === "append"
      ? `${existing.content.replace(/\s+$/, "")}\n\n${input.content.trim()}\n`
      : `${input.content.trim()}\n`;
    if (body.length > MEMORY_VAULT_MAX_NOTE_CHARS) {
      throw new Error(`La nota excede el límite de ${MEMORY_VAULT_MAX_NOTE_CHARS} caracteres.`);
    }
    validateNoSecrets(body, mergedProperties);
    writeTextFileAtomically(absolutePath, `${serializeFrontmatter(mergedProperties)}${body}`);
    this.invalidate(jid);
    return { note: this.parseNote(jid, absolutePath), created };
  }

  edit(jid: string, ref: string, oldText: string, newText: string, replaceAll = false): { note: MemoryVaultNote; replacements: number } {
    if (!oldText) throw new Error("old_text es obligatorio.");
    const note = this.resolveNote(jid, ref);
    const count = note.content.split(oldText).length - 1;
    if (count === 0) throw new Error("El fragmento indicado no existe en la nota.");
    if (count > 1 && !replaceAll) throw new Error(`El fragmento aparece ${count} veces; usa replace_all=true o proporciona más contexto.`);
    const content = replaceAll ? note.content.split(oldText).join(newText) : note.content.replace(oldText, newText);
    const result = this.upsert(jid, {
      note: note.path,
      title: note.title,
      content,
      mode: "replace",
      type: note.type,
      tags: note.tags,
      aliases: note.aliases,
      summary: note.summary,
      pinned: note.pinned,
      properties: note.properties,
    });
    return { note: result.note, replacements: replaceAll ? count : 1 };
  }

  rename(
    jid: string,
    ref: string,
    newTitle: string,
    newFolder?: string,
    updateLinks = true,
  ): { note: MemoryVaultNote; linksUpdated: number } {
    const note = this.resolveNote(jid, ref);
    const title = newTitle.trim();
    if (!title) throw new Error("new_title es obligatorio.");
    const folder = newFolder === undefined
      ? (dirname(note.path) === "." ? "" : dirname(note.path))
      : safeFolder(newFolder);
    const newRelative = `${folder ? `${folder}/` : ""}${slugify(title)}.md`;
    const oldAbsolute = this.resolveSafePath(jid, note.path);
    const newAbsolute = this.resolveSafePath(jid, newRelative);
    if (oldAbsolute !== newAbsolute && existsSync(newAbsolute)) throw new Error(`Ya existe ${newRelative}.`);

    const properties: VaultProperties = { ...note.properties, title, updated: new Date().toISOString() };
    ensureParentDirectory(newAbsolute);
    const renamedBody = /^#\s+.+$/m.test(note.content)
      ? note.content.replace(/^#\s+.+$/m, `# ${title}`)
      : note.content;
    writeTextFileAtomically(newAbsolute, `${serializeFrontmatter(properties)}${renamedBody}`);
    if (oldAbsolute !== newAbsolute) rmSync(oldAbsolute, { force: true });
    this.invalidate(jid);

    let linksUpdated = 0;
    if (updateLinks) {
      const oldTargets = new Set([
        normalizeText(note.title),
        normalizeText(note.slug),
        normalizeText(note.path.replace(/\.md$/i, "")),
      ]);
      const newTarget = newRelative.replace(/\.md$/i, "");
      for (const candidate of this.listNotes(jid)) {
        if (candidate.path === newRelative) continue;
        let changed = false;
        const content = candidate.content.replace(/\[\[([^\]|#]+)(#[^\]|]+)?(\|[^\]]+)?\]\]/g, (full, target: string, anchor = "", label = "") => {
          if (!oldTargets.has(normalizeText(target))) return full;
          changed = true;
          linksUpdated++;
          return `[[${newTarget}${anchor}${label}]]`;
        });
        if (changed) {
          this.upsert(jid, {
            note: candidate.path,
            title: candidate.title,
            content,
            type: candidate.type,
            tags: candidate.tags,
            aliases: candidate.aliases,
            summary: candidate.summary,
            pinned: candidate.pinned,
            properties: candidate.properties,
          });
        }
      }
    }
    return { note: this.resolveNote(jid, newRelative), linksUpdated };
  }

  delete(jid: string, ref: string): { trashedPath: string; note: MemoryVaultNote } {
    const note = this.resolveNote(jid, ref);
    const source = this.resolveSafePath(jid, note.path);
    const trashName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(note.path)}`;
    const trashRelative = `${TRASH_DIR}/${trashName}`;
    const target = resolve(this.getVaultRoot(jid), trashRelative);
    ensureParentDirectory(target);
    renameSync(source, target);
    this.invalidate(jid);
    return { trashedPath: trashRelative, note };
  }

  restore(jid: string, trashRef: string): MemoryVaultNote {
    this.init(jid);
    const root = this.getVaultRoot(jid);
    const trashRoot = resolve(root, TRASH_DIR);
    const clean = basename(trashRef.trim());
    const source = resolve(trashRoot, clean);
    if (!isInside(trashRoot, source) || !existsSync(source)) throw new Error("No existe esa nota en la papelera.");
    const raw = readFileSync(source, "utf8");
    const parsed = parseFrontmatter(raw);
    const title = propertyString(parsed.properties, "title", clean.replace(/^\d{4}-.*?-/, "").replace(/\.md$/i, ""));
    let targetName = `${slugify(title)}.md`;
    let index = 2;
    while (existsSync(join(root, targetName))) targetName = `${slugify(title)}-${index++}.md`;
    const target = this.resolveSafePath(jid, targetName);
    renameSync(source, target);
    this.invalidate(jid);
    return this.parseNote(jid, target);
  }

  listTrash(jid: string): string[] {
    this.init(jid);
    const dir = join(this.getVaultRoot(jid), TRASH_DIR);
    return readdirSync(dir).filter((name) => name.endsWith(".md")).sort().reverse();
  }

  backlinks(jid: string, ref: string): MemoryVaultNote[] {
    const target = this.resolveNote(jid, ref);
    const names = new Set([
      normalizeText(target.title),
      normalizeText(target.slug),
      normalizeText(target.path.replace(/\.md$/i, "")),
      ...target.aliases.map(normalizeText),
    ]);
    return this.listNotes(jid).filter((note) => note.path !== target.path && note.links.some((link) => names.has(normalizeText(link))));
  }

  buildRelevantContext(jid: string, query: string, maxChars = 5_000): string {
    const terms = tokenize(query);
    if (terms.length === 0 && normalizeText(query).length < 5) return "";
    const results = this.search(jid, query, { limit: 4 }).filter((result) => result.score >= 8);
    if (results.length === 0) return "";
    const lines = [
      "=== RECUERDOS RELACIONADOS DE LA BÓVEDA ===",
      "Estos fragmentos son contexto recuperado automáticamente. Para enumerar o verificar todo lo guardado usa las herramientas memory_vault_*.",
    ];
    for (const result of results) {
      lines.push("", `[[${result.note.path.replace(/\.md$/i, "")}]] — ${result.note.title}`, result.snippet);
    }
    lines.push("=== FIN DE RECUERDOS RELACIONADOS ===");
    return lines.join("\n").slice(0, maxChars);
  }
}

function formatNoteLine(note: MemoryVaultNote, index?: number): string {
  const prefix = index === undefined ? "-" : `${index}.`;
  const tags = note.tags.length ? ` #${note.tags.join(" #")}` : "";
  return `${prefix} ${note.title} — ${note.path} — tipo: ${note.type}${tags} — actualizado: ${note.updated}`;
}

export const MEMORY_VAULT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "memory_vault_list",
      description: "Lista las notas Markdown persistentes de la bóveda personal. Úsala para responder qué memorias, fechas, proyectos o temas están guardados.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string" },
          type: { type: "string" },
          tag: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          sort: { type: "string", enum: ["updated", "created", "title"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_vault_search",
      description: "Busca por título, alias, etiquetas, propiedades y contenido dentro de todas las notas persistentes. Devuelve resultados puntuados con fragmentos.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          type: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          folder: { type: "string" },
          property: { type: "string" },
          value: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 30 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_vault_read",
      description: "Lee una nota persistente completa por ruta, título, alias, slug o ID.",
      parameters: {
        type: "object",
        properties: { note: { type: "string" }, max_chars: { type: "integer", minimum: 1000, maximum: 100000 } },
        required: ["note"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_vault_upsert",
      description: "Crea una nota temática Markdown o actualiza una existente. Usa una nota por tema estable, por ejemplo fechas-cumpleanos.md, proyectos.md o preferencias-tecnicas.md. No almacena secretos.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "Referencia de una nota existente. Omítela para crear o localizar por título." },
          title: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["replace", "append"] },
          folder: { type: "string" },
          type: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          aliases: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          pinned: { type: "boolean" },
          properties: { type: "object", additionalProperties: true },
        },
        required: ["title", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_vault_edit",
      description: "Edita una nota reemplazando un fragmento exacto; evita reescribir accidentalmente el resto.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" },
        },
        required: ["note", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_vault_rename",
      description: "Renombra o mueve una nota y actualiza los wikilinks [[...]] que apuntan a ella.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string" }, new_title: { type: "string" }, new_folder: { type: "string" }, update_links: { type: "boolean" },
        },
        required: ["note", "new_title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_vault_backlinks",
      description: "Lista las notas que enlazan mediante [[wikilinks]] a una nota concreta.",
      parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_vault_delete",
      description: "Mueve una nota a la papelera recuperable de la bóveda. Requiere confirmación explícita.",
      parameters: {
        type: "object",
        properties: { note: { type: "string" }, confirmed: { type: "boolean" } },
        required: ["note", "confirmed"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_vault_restore",
      description: "Lista la papelera o restaura una nota eliminada. Sin trash_note solo lista los elementos recuperables.",
      parameters: {
        type: "object",
        properties: { trash_note: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
];

function parseProperties(value: unknown): VaultProperties {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: VaultProperties = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    if (candidate === null || typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean") {
      output[key] = candidate;
    } else if (Array.isArray(candidate)) {
      output[key] = candidate.filter((item): item is VaultScalar => item === null || ["string", "number", "boolean"].includes(typeof item));
    }
  }
  return output;
}

export async function executeMemoryVaultTool(
  name: string,
  args: Record<string, unknown>,
  vault: PersistentMemoryVault,
  jid: string,
): Promise<string> {
  try {
    if (name === "memory_vault_list") {
      const notes = vault.list(jid, {
        folder: typeof args.folder === "string" ? args.folder : undefined,
        type: typeof args.type === "string" ? args.type : undefined,
        tag: typeof args.tag === "string" ? args.tag : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        sort: args.sort === "created" || args.sort === "title" ? args.sort : "updated",
      });
      if (notes.length === 0) return "La bóveda personal no contiene notas con esos filtros.";
      return [`Bóveda personal: ${notes.length} nota(s).`, ...notes.map((note, index) => formatNoteLine(note, index + 1))].join("\n");
    }
    if (name === "memory_vault_search") {
      const query = typeof args.query === "string" ? args.query : "";
      const results = vault.search(jid, query, {
        type: typeof args.type === "string" ? args.type : undefined,
        tags: Array.isArray(args.tags) ? args.tags.filter((item): item is string => typeof item === "string") : undefined,
        folder: typeof args.folder === "string" ? args.folder : undefined,
        property: typeof args.property === "string" ? args.property : undefined,
        value: typeof args.value === "string" ? args.value : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      if (results.length === 0) return `No se encontraron recuerdos para "${query}".`;
      return results.map((result, index) => [
        `${index + 1}. ${result.note.title} — ${result.note.path} — puntuación ${result.score}`,
        `   ${result.snippet || "(sin contenido textual)"}`,
      ].join("\n")).join("\n");
    }
    if (name === "memory_vault_read") {
      const ref = typeof args.note === "string" ? args.note : "";
      const note = vault.read(jid, ref);
      const max = Math.max(1000, Math.min(100_000, typeof args.max_chars === "number" ? args.max_chars : 50_000));
      const raw = `${serializeFrontmatter(note.properties)}${note.content}`;
      return raw.length > max ? `${raw.slice(0, max)}\n\n[Contenido truncado por max_chars]` : raw;
    }
    if (name === "memory_vault_upsert") {
      const title = typeof args.title === "string" ? args.title : "";
      const content = typeof args.content === "string" ? args.content : "";
      const result = vault.upsert(jid, {
        note: typeof args.note === "string" ? args.note : undefined,
        title,
        content,
        mode: args.mode === "append" ? "append" : "replace",
        folder: typeof args.folder === "string" ? args.folder : undefined,
        type: typeof args.type === "string" ? args.type : undefined,
        tags: Array.isArray(args.tags) ? args.tags.filter((item): item is string => typeof item === "string") : undefined,
        aliases: Array.isArray(args.aliases) ? args.aliases.filter((item): item is string => typeof item === "string") : undefined,
        summary: typeof args.summary === "string" ? args.summary : undefined,
        pinned: typeof args.pinned === "boolean" ? args.pinned : undefined,
        properties: parseProperties(args.properties),
      });
      return `✅ ${result.created ? "Nota creada" : "Nota actualizada"}: ${result.note.path}\nTítulo: ${result.note.title}\nTipo: ${result.note.type}\nEtiquetas: ${result.note.tags.join(", ") || "ninguna"}`;
    }
    if (name === "memory_vault_edit") {
      const result = vault.edit(
        jid,
        typeof args.note === "string" ? args.note : "",
        typeof args.old_text === "string" ? args.old_text : "",
        typeof args.new_text === "string" ? args.new_text : "",
        args.replace_all === true,
      );
      return `✅ Nota editada: ${result.note.path}; reemplazos: ${result.replacements}`;
    }
    if (name === "memory_vault_rename") {
      const result = vault.rename(
        jid,
        typeof args.note === "string" ? args.note : "",
        typeof args.new_title === "string" ? args.new_title : "",
        typeof args.new_folder === "string" ? args.new_folder : undefined,
        args.update_links !== false,
      );
      return `✅ Nota renombrada: ${result.note.path}; wikilinks actualizados: ${result.linksUpdated}`;
    }
    if (name === "memory_vault_backlinks") {
      const refs = vault.backlinks(jid, typeof args.note === "string" ? args.note : "");
      if (refs.length === 0) return "No hay backlinks hacia esa nota.";
      return refs.map((note, index) => formatNoteLine(note, index + 1)).join("\n");
    }
    if (name === "memory_vault_delete") {
      if (args.confirmed !== true) return "Error: memory_vault_delete requiere confirmed=true después de una petición explícita.";
      const result = vault.delete(jid, typeof args.note === "string" ? args.note : "");
      return `✅ Nota movida a la papelera: ${result.note.path}\nRecuperable como: ${result.trashedPath}`;
    }
    if (name === "memory_vault_restore") {
      const trashNote = typeof args.trash_note === "string" ? args.trash_note.trim() : "";
      if (!trashNote) {
        const items = vault.listTrash(jid);
        return items.length ? `Papelera recuperable:\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}` : "La papelera de la bóveda está vacía.";
      }
      const note = vault.restore(jid, trashNote);
      return `✅ Nota restaurada: ${note.path}`;
    }
    return `Error: herramienta de bóveda desconocida "${name}".`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
