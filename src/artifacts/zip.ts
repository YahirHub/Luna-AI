import { deflateRawSync } from "node:zlib";
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";

interface ZipEntry {
  name: string;
  content: Buffer;
  mtime: Date;
}

interface IgnoreRule {
  base: string;
  pattern: string;
  negate: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  hasSlash: boolean;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZipBuffer(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf-8");
    const compressed = deflateRawSync(entry.content, { level: 9 });
    const checksum = crc32(entry.content);
    const dt = dosDateTime(entry.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dt.time, 12);
    c.writeUInt16LE(dt.date, 14);
    c.writeUInt32LE(checksum, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(entry.content.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE(0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, end]);
}

function globRegex(pattern: string): RegExp {
  let output = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        if (pattern[i + 1] === "/") {
          i++;
          output += "(?:.*/)?";
        } else output += ".*";
      } else output += "[^/]*";
    } else if (char === "?") output += "[^/]";
    else output += char?.replace(/[.+^${}()|[\]\\]/g, "\\$&") ?? "";
  }
  return new RegExp(`^${output}$`);
}

function parseIgnoreFile(content: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (!line) continue;
    rules.push({ base, pattern: line, negate, directoryOnly, anchored, hasSlash: line.includes("/") });
  }
  return rules;
}

function relativeUnix(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function ruleMatches(rule: IgnoreRule, absolutePath: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  const rel = relativeUnix(rule.base, absolutePath);
  if (rel === ".." || rel.startsWith("../")) return false;
  const candidates = rule.anchored || rule.hasSlash
    ? [rel]
    : rel.split("/").map((_part, index, parts) => parts.slice(index).join("/"));
  const regex = globRegex(rule.pattern);
  if (candidates.some((candidate) => regex.test(rule.hasSlash || rule.anchored ? candidate : basename(candidate)))) return true;
  if (isDirectory && candidates.some((candidate) => candidate.startsWith(`${rule.pattern}/`))) return true;
  return false;
}

function isIgnored(rules: IgnoreRule[], path: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, path, isDirectory)) ignored = !rule.negate;
  }
  return ignored;
}

interface CollectOptions {
  gitignore: boolean;
  maxFiles: number;
  maxBytes: number;
}

function collectEntries(root: string, options: CollectOptions): { entries: ZipEntry[]; ignored: string[] } {
  const entries: ZipEntry[] = [];
  const ignored: string[] = [];
  const rules: IgnoreRule[] = options.gitignore
    ? [{ base: root, pattern: ".git", negate: false, directoryOnly: true, anchored: false, hasSlash: false }]
    : [];
  let total = 0;

  const walk = (directory: string): void => {
    if (options.gitignore) {
      const ignorePath = join(directory, ".gitignore");
      try {
        rules.push(...parseIgnoreFile(readFileSync(ignorePath, "utf-8"), directory));
      } catch {
        // La carpeta no tiene .gitignore.
      }
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relativeUnix(root, absolute);
      if (!rel) continue;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        ignored.push(`${rel} [symlink]`);
        continue;
      }
      if (options.gitignore && entry.name !== ".gitignore" && isIgnored(rules, absolute, stat.isDirectory())) {
        ignored.push(rel);
        continue;
      }
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) continue;
      total += stat.size;
      if (entries.length >= options.maxFiles) throw new Error(`La carpeta supera el límite de ${options.maxFiles} archivos.`);
      if (total > options.maxBytes) throw new Error(`La carpeta supera el límite de ${options.maxBytes} bytes sin comprimir.`);
      entries.push({ name: rel, content: readFileSync(absolute), mtime: stat.mtime });
    }
  };
  walk(root);
  return { entries, ignored };
}

export interface ArchiveResult {
  outputPath: string;
  fileCount: number;
  uncompressedBytes: number;
  ignored: string[];
  secretWarnings: string[];
}

const SECRET_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /(?:^|\/)(?:id_rsa|id_ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /(?:credentials|secrets?|auth)[^/]*\.json$/i,
  /(?:^|\/)auth_info_[^/]+(?:\/|$)/i,
  /(?:^|\/)persistent(?:\/|$)/i,
];

export function createFolderArchive(
  workspace: WorkspaceManager,
  jid: string,
  sourcePath: string,
  outputPath: string,
  gitignore: boolean,
): ArchiveResult {
  const source = workspace.resolvePath(jid, sourcePath, { mustExist: true, allowDirectory: true });
  if (!statSync(source).isDirectory()) throw new Error("La ruta de origen debe ser una carpeta.");
  workspace.assertNoExternalSymlinks(jid, sourcePath);
  const collected = collectEntries(source, { gitignore, maxFiles: 20_000, maxBytes: 500_000_000 });
  const zip = createZipBuffer(collected.entries);
  const output = workspace.resolvePath(jid, outputPath);
  const parent = dirname(output);
  if (!resolve(parent).startsWith(resolve(workspace.getWorkdir(jid)))) throw new Error("Salida inválida.");
  mkdirSync(parent, { recursive: true });
  writeFileSync(output, zip, { mode: 0o600 });
  return {
    outputPath: workspace.relativePath(jid, output),
    fileCount: collected.entries.length,
    uncompressedBytes: collected.entries.reduce((sum, entry) => sum + entry.content.length, 0),
    ignored: collected.ignored,
    secretWarnings: collected.entries.map((entry) => entry.name).filter((name) => SECRET_PATTERNS.some((pattern) => pattern.test(name))),
  };
}
