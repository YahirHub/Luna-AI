import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sanitizePathSegment, writeJsonFileAtomically, writeTextFileAtomically } from "../storage.ts";
import { getAppDir } from "../utils.ts";

export interface WorkspaceArtifact {
  id: string;
  taskId?: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  createdBy: string;
  createdAt: string;
  temporary: boolean;
}

interface ArtifactFile {
  artifacts: WorkspaceArtifact[];
}

const RESERVED_ROOT_WORKDIR_FILES = new Set(["tasks.json", "artifacts.json"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg; codecs=opus",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeRelativePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") return ".";
  if (trimmed.includes("\0") || isAbsolute(trimmed)) {
    throw new Error("La ruta debe ser relativa al workdir del usuario.");
  }
  const parts = trimmed.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error("La ruta no puede salir del workdir del usuario.");
  }
  return parts.join("/") || ".";
}

export function guessMimeType(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export class WorkspaceManager {
  readonly contextsDir: string;

  constructor(baseDir = join(getAppDir(), "persistent", "contexts")) {
    this.contextsDir = resolve(baseDir);
    mkdirSync(this.contextsDir, { recursive: true });
  }

  getUserDir(jid: string): string {
    const path = join(this.contextsDir, sanitizePathSegment(jid));
    mkdirSync(path, { recursive: true });
    return path;
  }

  getWorkdir(jid: string): string {
    const path = join(this.getUserDir(jid), "workdir");
    mkdirSync(path, { recursive: true });
    for (const folder of ["tasks", "inbox", "exports"]) {
      mkdirSync(join(path, folder), { recursive: true });
    }
    return path;
  }

  createTask(jid: string, label = "task"): { taskId: string; path: string } {
    const taskId = `${Date.now()}-${sanitizePathSegment(label).slice(0, 48) || "task"}-${crypto.randomUUID().slice(0, 8)}`;
    const path = join(this.getWorkdir(jid), "tasks", taskId);
    for (const folder of ["agents", "synthesis", "artifacts", "temp"]) {
      mkdirSync(join(path, folder), { recursive: true });
    }
    return { taskId, path };
  }

  resolvePath(jid: string, inputPath: string, options: { mustExist?: boolean; allowDirectory?: boolean } = {}): string {
    const root = this.getWorkdir(jid);
    const normalized = normalizeRelativePath(inputPath);
    if (RESERVED_ROOT_WORKDIR_FILES.has(normalized.toLowerCase())) {
      throw new Error(`"${normalized}" es metadato interno de Luna y no puede manipularse mediante herramientas de workspace.`);
    }
    const candidate = resolve(root, normalized);
    if (!isInside(root, candidate)) {
      throw new Error("La ruta solicitada está fuera del workdir del usuario.");
    }

    if (options.mustExist && !existsSync(candidate)) {
      throw new Error(`No existe "${normalized}" en el workdir.`);
    }

    const realRoot = realpathSync(root);
    if (existsSync(candidate)) {
      const realCandidate = realpathSync(candidate);
      if (!isInside(realRoot, realCandidate)) {
        throw new Error("La ruta resuelve fuera del workdir mediante un enlace simbólico.");
      }
      if (!options.allowDirectory && statSync(candidate).isDirectory()) {
        throw new Error("La operación requiere un archivo, no una carpeta.");
      }
    } else {
      // También valida el ancestro existente más cercano. Sin esta comprobación,
      // una escritura en `symlink-afuera/nuevo.txt` podría atravesar un enlace
      // aunque el archivo final todavía no existiera.
      let ancestor = dirname(candidate);
      while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
        ancestor = dirname(ancestor);
      }
      const realAncestor = realpathSync(ancestor);
      if (!isInside(realRoot, realAncestor)) {
        throw new Error("La ruta resuelve fuera del workdir mediante un enlace simbólico.");
      }
      const projected = resolve(realAncestor, relative(ancestor, candidate));
      if (!isInside(realRoot, projected)) {
        throw new Error("La ruta proyectada saldría del workdir mediante un enlace simbólico.");
      }
    }

    return candidate;
  }

  relativePath(jid: string, absolutePath: string): string {
    const root = this.getWorkdir(jid);
    const candidate = resolve(absolutePath);
    if (!isInside(root, candidate)) throw new Error("El archivo no pertenece al workdir.");
    return relative(root, candidate).replace(/\\/g, "/");
  }

  writeText(jid: string, path: string, content: string): string {
    const target = this.resolvePath(jid, path, { allowDirectory: false });
    writeTextFileAtomically(target, content);
    return this.relativePath(jid, target);
  }

  appendText(jid: string, path: string, content: string): string {
    const target = this.resolvePath(jid, path, { allowDirectory: false });
    let current = "";
    if (existsSync(target)) current = readFileSync(target, "utf-8");
    writeTextFileAtomically(target, `${current}${content}`);
    return this.relativePath(jid, target);
  }

  editText(
    jid: string,
    path: string,
    oldText: string,
    newText: string,
    replaceAll = false,
  ): { path: string; replacements: number } {
    if (!oldText) throw new Error("old_text no puede estar vacío.");
    const target = this.resolvePath(jid, path, { mustExist: true, allowDirectory: false });
    const current = readFileSync(target, "utf-8");
    const matches = current.split(oldText).length - 1;
    if (matches === 0) throw new Error("No se encontró old_text en el archivo.");
    if (!replaceAll && matches > 1) {
      throw new Error(`old_text aparece ${matches} veces. Usa replace_all=true o proporciona un fragmento más específico.`);
    }
    const updated = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
    writeTextFileAtomically(target, updated);
    return { path: this.relativePath(jid, target), replacements: replaceAll ? matches : 1 };
  }

  writeBuffer(jid: string, path: string, content: Uint8Array): string {
    const target = this.resolvePath(jid, path, { allowDirectory: false });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: 0o600 });
    return this.relativePath(jid, target);
  }

  readText(jid: string, path: string, maxChars = 100_000): string {
    const target = this.resolvePath(jid, path, { mustExist: true });
    const content = readFileSync(target, "utf-8");
    return content.length > maxChars
      ? `${content.slice(0, maxChars)}\n\n[Contenido truncado]`
      : content;
  }

  readBuffer(jid: string, path: string, maxBytes = 25_000_000): Buffer {
    const target = this.resolvePath(jid, path, { mustExist: true });
    const size = statSync(target).size;
    if (size > maxBytes) throw new Error(`El archivo supera el límite de ${maxBytes} bytes.`);
    return readFileSync(target);
  }

  list(jid: string, path = ".", maxEntries = 200): string[] {
    const target = this.resolvePath(jid, path, { mustExist: true, allowDirectory: true });
    if (!statSync(target).isDirectory()) return [this.relativePath(jid, target)];
    return readdirSync(target, { withFileTypes: true })
      .slice(0, Math.max(1, maxEntries))
      .map((entry) => `${entry.isDirectory() ? "📁" : "📄"} ${join(path, entry.name).replace(/\\/g, "/")}`);
  }

  listRecursive(jid: string, path = ".", maxEntries = 300): string[] {
    const root = this.resolvePath(jid, path, { mustExist: true, allowDirectory: true });
    const entries: string[] = [];
    const walk = (current: string): void => {
      if (entries.length >= Math.max(1, maxEntries)) return;
      const info = statSync(current);
      const relativePath = this.relativePath(jid, current);
      if (!info.isDirectory()) {
        entries.push(`📄 ${relativePath} — ${info.size} bytes`);
        return;
      }
      if (current !== root) entries.push(`📁 ${relativePath}`);
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entries.length >= Math.max(1, maxEntries)) break;
        walk(join(current, entry.name));
      }
    };
    walk(root);
    return entries;
  }

  remove(jid: string, path: string): void {
    const target = this.resolvePath(jid, path, { mustExist: true, allowDirectory: true });
    if (target === this.getWorkdir(jid)) throw new Error("No se puede eliminar el workdir completo.");
    rmSync(target, { recursive: true, force: true });
  }

  /**
   * Vacía por completo el workdir privado del usuario y recrea su estructura base.
   * No toca context.json, memory.md, credenciales ni ninguna otra persistencia
   * ubicada fuera de workdir/.
   */
  clearWorkdir(jid: string): void {
    const workdir = this.getWorkdir(jid);
    for (const entry of readdirSync(workdir)) {
      rmSync(join(workdir, entry), { recursive: true, force: true });
    }
    for (const folder of ["tasks", "inbox", "exports"]) {
      mkdirSync(join(workdir, folder), { recursive: true });
    }
  }

  registerArtifact(
    jid: string,
    path: string,
    createdBy: string,
    options: { taskId?: string; temporary?: boolean } = {},
  ): WorkspaceArtifact {
    const target = this.resolvePath(jid, path, { mustExist: true });
    const artifact: WorkspaceArtifact = {
      id: crypto.randomUUID(),
      taskId: options.taskId,
      path: this.relativePath(jid, target),
      filename: basename(target),
      mimeType: guessMimeType(target),
      size: statSync(target).size,
      createdBy,
      createdAt: new Date().toISOString(),
      temporary: options.temporary ?? true,
    };
    const registryPath = join(this.getWorkdir(jid), "artifacts.json");
    let current: ArtifactFile = { artifacts: [] };
    try {
      const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as ArtifactFile;
      if (Array.isArray(raw.artifacts)) current = raw;
    } catch {
      // Archivo nuevo o dañado: se reemplaza por un registro válido.
    }
    current.artifacts = current.artifacts.filter((item) => item.path !== artifact.path);
    current.artifacts.push(artifact);
    writeJsonFileAtomically(registryPath, current);
    return artifact;
  }

  listArtifacts(jid: string): WorkspaceArtifact[] {
    const registryPath = join(this.getWorkdir(jid), "artifacts.json");
    try {
      const parsed = JSON.parse(readFileSync(registryPath, "utf-8")) as ArtifactFile;
      return Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
    } catch {
      return [];
    }
  }

  assertNoExternalSymlinks(jid: string, path: string): void {
    const target = this.resolvePath(jid, path, { mustExist: true, allowDirectory: true });
    const root = realpathSync(this.getWorkdir(jid));
    const walk = (current: string): void => {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) {
        const real = realpathSync(current);
        if (!isInside(root, real)) throw new Error(`El enlace ${current} sale del workdir.`);
        return;
      }
      if (!info.isDirectory()) return;
      for (const entry of readdirSync(current)) walk(join(current, entry));
    };
    walk(target);
  }
}
