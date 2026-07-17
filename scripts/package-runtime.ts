import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ensureLinuxRuntimeDependencies,
  ensureLinuxSharedLibraryAliases,
} from "./whisper-linux-libs.ts";

const root = process.cwd();
const source = join(root, "assets", "runtime", "whisper");
const destination = join(root, "dist", "runtime", "whisper");

if (!existsSync(join(source, "manifest.json"))) {
  throw new Error("Falta el runtime de whisper.cpp. Ejecuta bun run prepare:media.");
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(join(root, "dist", "runtime"), { recursive: true });
cpSync(source, destination, {
  recursive: true,
  filter(path: string) {
    return !path.includes(`${join("whisper", ".downloads")}`);
  },
});
const aliases = ensureLinuxSharedLibraryAliases(destination);
for (const alias of aliases) {
  console.log(`[package-runtime] Alias Linux restaurado: ${relative(destination, alias)}`);
}
const dependencies = await ensureLinuxRuntimeDependencies(destination);
for (const dependency of dependencies) {
  console.log(`[package-runtime] Dependencia Linux incluida: ${relative(destination, dependency)}`);
}
console.log(`[package-runtime] Runtime de whisper.cpp copiado a ${destination}`);
