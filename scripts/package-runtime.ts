import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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
console.log(`[package-runtime] Runtime de whisper.cpp copiado a ${destination}`);
