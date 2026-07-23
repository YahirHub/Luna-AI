import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";

export type ManualPiperModelKind = "neo" | "onnx";

export interface ManualPiperModel {
  id: string;
  kind: ManualPiperModelKind;
  modelPath: string;
  configPath?: string;
  relativePath: string;
  aliases: string[];
}

export interface InvalidManualPiperModel {
  relativePath: string;
  reason: string;
}

function slash(value: string): string { return value.split(sep).join("/"); }
function stem(path: string): string {
  const name = basename(path);
  return name.slice(0, Math.max(0, name.length - extname(name).length));
}
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\.(?:onnx|neo)$/i, "")
    .replace(/[^a-z0-9/_-]+/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Catálogo de modelos globales colocados manualmente bajo persistent/piper/models.
 * `official/` está reservado para el catálogo/descargador administrado por Luna.
 * No sigue symlinks para no permitir que un árbol manual escape del directorio esperado.
 */
export class ManualPiperModelCatalog {
  constructor(readonly root: string) {}

  scan(): { models: ManualPiperModel[]; invalid: InvalidManualPiperModel[] } {
    const models: ManualPiperModel[] = [];
    const invalid: InvalidManualPiperModel[] = [];
    if (!existsSync(this.root)) return { models, invalid };

    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 12) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (depth === 0 && entry.name.toLowerCase() === "official") continue;
        const path = join(dir, entry.name);
        let stats;
        try { stats = lstatSync(path); } catch { continue; }
        if (stats.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(path, depth + 1);
        else if (entry.isFile()) files.push(path);
      }
    };
    walk(this.root, 0);

    const modelFiles = files.filter((path) => /\.(?:neo|onnx)$/i.test(path));
    const countByDir = new Map<string, number>();
    for (const path of modelFiles) countByDir.set(dirname(path), (countByDir.get(dirname(path)) ?? 0) + 1);

    for (const modelPath of modelFiles.sort((a, b) => slash(relative(this.root, a)).localeCompare(slash(relative(this.root, b))))) {
      const extension = extname(modelPath).toLowerCase();
      const relativePath = slash(relative(this.root, modelPath));
      const relativeWithoutExt = relativePath.slice(0, -extension.length);
      const parent = dirname(modelPath);
      const parentRelative = slash(relative(this.root, parent));
      const fileStem = stem(modelPath);
      const aliases = new Set<string>([relativeWithoutExt, fileStem]);
      if (parent !== this.root && countByDir.get(parent) === 1) {
        aliases.add(basename(parent));
        aliases.add(parentRelative);
      }

      if (extension === ".onnx") {
        const configPath = `${modelPath}.json`;
        if (!existsSync(configPath)) {
          invalid.push({ relativePath, reason: `falta ${basename(configPath)}` });
          continue;
        }
        models.push({
          id: relativeWithoutExt,
          kind: "onnx",
          modelPath,
          configPath,
          relativePath,
          aliases: [...aliases],
        });
        continue;
      }

      models.push({
        id: relativeWithoutExt,
        kind: "neo",
        modelPath,
        relativePath,
        aliases: [...aliases],
      });
    }
    return { models, invalid };
  }

  list(): ManualPiperModel[] { return this.scan().models; }

  resolve(query: string): { model?: ManualPiperModel; ambiguous?: ManualPiperModel[] } {
    const needle = normalize(query);
    if (!needle) return {};
    const models = this.list();
    const exact = models.filter((model) => [model.id, model.relativePath, ...model.aliases].some((candidate) => normalize(candidate) === needle));
    if (exact.length === 1) return { model: exact[0] };
    if (exact.length > 1) return { ambiguous: exact };
    const partial = models.filter((model) => [model.id, ...model.aliases].some((candidate) => normalize(candidate).includes(needle)));
    if (partial.length === 1) return { model: partial[0] };
    if (partial.length > 1) return { ambiguous: partial };
    return {};
  }
}
