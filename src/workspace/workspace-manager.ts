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
  sourcePath?: string;
}

interface ArtifactFile {
  artifacts: WorkspaceArtifact[];
}

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
    const candidate = resolve(root, normalized);
    if (!isInside(root, candidate)) {
      throw new Error("La ruta solicitada está fuera del workdir del usuario.");
    }

    if (options.mustExist && !existsSync(candidate)) {
      throw new Error(`No existe "${normalized}" en el workdir.`);
    }

    if (existsSync(candidate)) {
      const realRoot = realpathSync(root);
      const realCandidate = realpathSync(candidate);
      if (!isInside(realRoot, realCandidate)) {
        throw new Error("La ruta resuelve fuera del workdir mediante un enlace simbólico.");
      }
      if (!options.allowDirectory && statSync(candidate).isDirectory()) {
        throw new Error("La operación requiere un archivo, no una carpeta.");
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

  remove(jid: string, path: string): void {
    const target = this.resolvePath(jid, path, { mustExist: true, allowDirectory: true });
    if (target === this.getWorkdir(jid)) throw new Error("No se puede eliminar el workdir completo.");
    rmSync(target, { recursive: true, force: true });
  }

  registerArtifact(
    jid: string,
    path: string,
    createdBy: string,
    options: { taskId?: string; temporary?: boolean; sourcePath?: string } = {},
  ): WorkspaceArtifact {
    const target = this.resolvePath(jid, path, { mustExist: true });
    let sourcePath: string | undefined;
    if (options.sourcePath) {
      const sourceTarget = this.resolvePath(jid, options.sourcePath, { mustExist: true });
      sourcePath = this.relativePath(jid, sourceTarget);
    }
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
      ...(sourcePath ? { sourcePath } : {}),
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

  findArtifact(jid: string, idOrPath?: string): WorkspaceArtifact | undefined {
    const artifacts = this.listArtifacts(jid);
    if (!idOrPath) return artifacts.at(-1);
    const needle = idOrPath.trim().replace(/\\/g, "/").toLowerCase();
    return artifacts.find((item) => item.id.toLowerCase() === needle || item.path.toLowerCase() === needle || item.filename.toLowerCase() === needle);
  }

  readArtifactText(jid: string, idOrPath?: string, maxChars = 100_000): { artifact: WorkspaceArtifact; sourcePath: string; content: string } {
    const artifact = this.findArtifact(jid, idOrPath);
    if (!artifact) throw new Error(idOrPath ? `No existe el artefacto "${idOrPath}".` : "No hay artefactos registrados.");
    let sourcePath = artifact.sourcePath;
    if (!sourcePath && artifact.path.toLowerCase().endsWith(".pdf")) {
      const sibling = artifact.path.replace(/\.pdf$/i, ".md");
      try {
        this.resolvePath(jid, sibling, { mustExist: true });
        sourcePath = sibling;
      } catch {
        // PDF externo o sin Markdown fuente asociado.
      }
    }
    sourcePath ??= artifact.path;
    const mime = guessMimeType(sourcePath);
    if (!mime.startsWith("text/") && !mime.includes("json") && !sourcePath.toLowerCase().endsWith(".md")) {
      throw new Error(`El artefacto ${artifact.filename} no tiene una fuente de texto legible asociada.`);
    }
    return { artifact, sourcePath, content: this.readText(jid, sourcePath, maxChars) };
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
