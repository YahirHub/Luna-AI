import {
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function walkRuntimeFiles(root: string): string[] {
  const result: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !existsSync(current)) continue;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() || entry.isSymbolicLink()) result.push(path);
    }
  }

  return result;
}

export function linuxSharedLibraryAliases(filename: string): string[] {
  const match = filename.match(/^(lib.+\.so)\.(\d+)(?:\..+)?$/);
  if (!match?.[1] || !match[2]) return [];

  return [...new Set([match[1], `${match[1]}.${match[2]}`])]
    .filter((alias) => alias !== filename);
}

type LibraryCandidate = {
  path: string;
  base: string;
  major: string;
  versionDepth: number;
  symbolicLink: boolean;
  size: number;
};

function libraryCandidate(path: string): LibraryCandidate | null {
  const filename = basename(path);
  const match = filename.match(/^(lib.+\.so)\.(\d+)((?:\.[^.]+)*)$/);
  if (!match?.[1] || !match[2]) return null;

  const suffix = match[3] ?? "";
  let symbolicLink = false;
  try {
    symbolicLink = lstatSync(path).isSymbolicLink();
  } catch {
    return null;
  }

  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }

  return {
    path,
    base: match[1],
    major: match[2],
    versionDepth: suffix.split(".").filter(Boolean).length,
    symbolicLink,
    size,
  };
}

/**
 * Los tar oficiales de whisper.cpp usan enlaces simbólicos para sus SONAME:
 * libwhisper.so.1 -> libwhisper.so.1.x.y, por ejemplo. Algunos extractores o
 * empaquetadores no conservan esos enlaces o los convierten en archivos de
 * texto. Se crean copias regulares desde la biblioteca versionada real.
 */
export function ensureLinuxSharedLibraryAliases(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "linux") return [];

  const groups = new Map<string, LibraryCandidate[]>();
  for (const path of walkRuntimeFiles(root)) {
    const candidate = libraryCandidate(path);
    if (!candidate) continue;
    const key = `${dirname(path)}\0${candidate.base}`;
    const current = groups.get(key) ?? [];
    current.push(candidate);
    groups.set(key, current);
  }

  const created: string[] = [];
  for (const candidates of groups.values()) {
    candidates.sort((left, right) => {
      if (left.symbolicLink !== right.symbolicLink) return left.symbolicLink ? 1 : -1;
      if (left.versionDepth !== right.versionDepth) return right.versionDepth - left.versionDepth;
      return right.size - left.size;
    });

    const source = candidates[0];
    if (!source) continue;
    const aliases = [source.base, `${source.base}.${source.major}`];

    for (const alias of aliases) {
      const destination = join(dirname(source.path), alias);
      if (destination === source.path) continue;
      rmSync(destination, { force: true });
      copyFileSync(source.path, destination);
      created.push(destination);
    }
  }

  return created;
}
