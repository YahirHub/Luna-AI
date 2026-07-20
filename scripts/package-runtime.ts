import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { agentBrowserGenericName, agentBrowserNativeName } from "../src/browser/browser-discovery.ts";
import {
  ensureLinuxRuntimeDependencies,
  ensureLinuxSharedLibraryAliases,
} from "./whisper-linux-libs.ts";

const root = process.cwd();
const source = join(root, "assets", "runtime", "whisper");
const destination = join(root, "dist", "runtime", "whisper");
const ffmpegSource = join(root, "assets", "runtime", "ffmpeg");
const ffmpegDestination = join(root, "dist", "runtime", "ffmpeg");
const twemojiSource = join(root, "assets", "twemoji");
const twemojiDestination = join(root, "dist", "runtime", "twemoji");

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

if (!existsSync(join(ffmpegSource, "manifest.json"))) {
  throw new Error("Falta el runtime de FFmpeg. Ejecuta bun run prepare:media.");
}
rmSync(ffmpegDestination, { recursive: true, force: true });
cpSync(ffmpegSource, ffmpegDestination, {
  recursive: true,
  filter(path: string) {
    return !path.includes(`${join("ffmpeg", ".downloads")}`);
  },
});
const ffmpegExecutable = join(ffmpegDestination, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
if (process.platform !== "win32" && existsSync(ffmpegExecutable)) chmodSync(ffmpegExecutable, 0o755);
console.log(`[package-runtime] Runtime de FFmpeg copiado a ${ffmpegDestination}`);
if (existsSync(twemojiSource)) {
  rmSync(twemojiDestination, { recursive: true, force: true });
  cpSync(twemojiSource, twemojiDestination, { recursive: true });
  console.log(`[package-runtime] Assets Twemoji copiados a ${twemojiDestination}`);
}


const agentBrowserPreparedDir = join(root, "assets", "runtime", "agent-browser");
const agentBrowserPreparedSource = join(agentBrowserPreparedDir, agentBrowserGenericName());
const agentBrowserNodeModulesSource = join(root, "node_modules", "agent-browser", "bin", agentBrowserNativeName());
const agentBrowserDestination = join(root, "dist", "runtime", "agent-browser");
rmSync(agentBrowserDestination, { recursive: true, force: true });
mkdirSync(agentBrowserDestination, { recursive: true });

const target = join(agentBrowserDestination, agentBrowserGenericName());
if (existsSync(agentBrowserPreparedSource)) {
  // Copia también manifest.json para conservar la arquitectura/versión del
  // runtime preparado y facilitar diagnósticos de builds multi-arquitectura.
  cpSync(agentBrowserPreparedDir, agentBrowserDestination, { recursive: true });
} else if (existsSync(agentBrowserNodeModulesSource)) {
  cpSync(agentBrowserNodeModulesSource, target);
} else {
  throw new Error(
    `Falta el runtime nativo de agent-browser para ${process.platform}/${process.arch}. `
    + "Ejecuta bun run prepare:browser o bun install antes del build.",
  );
}
if (process.platform !== "win32") chmodSync(target, 0o755);
console.log(`[package-runtime] agent-browser nativo copiado a ${target}`);
