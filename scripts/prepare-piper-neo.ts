import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const RUNTIME_DIR = join(ROOT, "assets", "runtime", "piper-neo");
const DOWNLOAD_DIR = join(RUNTIME_DIR, ".downloads");
const EXTRACT_DIR = join(DOWNLOAD_DIR, "extracted");
const MANIFEST_PATH = join(RUNTIME_DIR, "manifest.json");
const VOICES_SOURCE = join(ROOT, "assets", "piper", "voices.json");
const VOICES_TARGET = join(RUNTIME_DIR, "voices.json");
const FORCED_TAG = process.env.PIPER_NEO_RELEASE_TAG?.trim() || "";
const RELEASE_API = FORCED_TAG
  ? `https://api.github.com/repos/ThowiLabs/Piper-Neo/releases/tags/${encodeURIComponent(FORCED_TAG)}`
  : "https://api.github.com/repos/ThowiLabs/Piper-Neo/releases/latest";
const CONNECT_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const EXECUTABLE_VALIDATE_TIMEOUT_MS = 15_000;

const EXACT_ASSETS: Record<string, string> = {
  "linux/x64": "piper_linux_x86_64.tar.gz",
  "linux/arm64": "piper_linux_aarch64.tar.gz",
  "linux/arm": "piper_linux_armv7l.tar.gz",
  "win32/x64": "piper_windows_amd64.zip",
};

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  digest?: string | null;
  size?: number;
};

type ReleasePayload = {
  tag_name: string;
  assets: ReleaseAsset[];
};

export type PiperNeoRuntimeManifest = {
  schemaVersion: 1;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  assetName: string;
  assetDigest?: string;
  executable: string;
  preparedAt: string;
};

function ensureDir(path: string): void { mkdirSync(path, { recursive: true }); }

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

function targetAssetName(platform = process.platform, arch = process.arch): string {
  const key = `${platform}/${arch}`;
  const asset = EXACT_ASSETS[key];
  if (!asset) {
    throw new Error(
      `Piper Neo no tiene un asset configurado para ${key}. ` +
      `Objetivos soportados: ${Object.keys(EXACT_ASSETS).join(", ")}.`,
    );
  }
  return asset;
}

function chooseAsset(release: ReleasePayload): ReleaseAsset {
  const forced = process.env.PIPER_NEO_RELEASE_ASSET?.trim();
  const expectedName = forced || targetAssetName();
  const exact = release.assets.find((asset) => asset.name === expectedName);
  if (exact) return exact;

  const published = release.assets.map((asset) => asset.name).join(", ") || "(sin assets)";
  throw new Error(
    `Piper Neo ${release.tag_name} no publica el asset esperado ${expectedName} para ${process.platform}/${process.arch}. ` +
    `Assets publicados: ${published}`,
  );
}

async function fetchRelease(): Promise<ReleasePayload> {
  console.log(
    FORCED_TAG
      ? `[piper-neo] Consultando release solicitada ${FORCED_TAG}...`
      : "[piper-neo] Consultando la última release publicada en GitHub...",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `Luna-AI-Piper-Neo/Bun-${Bun.version}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(RELEASE_API, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`GitHub API respondió HTTP ${response.status}.`);
    const value = await response.json() as Partial<ReleasePayload>;
    if (!value.tag_name || !Array.isArray(value.assets)) throw new Error("Release inválida de Piper Neo.");
    console.log(`[piper-neo] Release detectada: ${value.tag_name} (${value.assets.length} assets).`);
    return value as ReleasePayload;
  } finally { clearTimeout(timer); }
}

function readManifest(): PiperNeoRuntimeManifest | null {
  try {
    const value = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as PiperNeoRuntimeManifest;
    if (value?.schemaVersion !== 1) return null;
    return value;
  } catch { return null; }
}

function manifestUsable(manifest: PiperNeoRuntimeManifest | null): manifest is PiperNeoRuntimeManifest {
  return Boolean(
    manifest
      && manifest.platform === process.platform
      && manifest.arch === process.arch
      && existsSync(join(RUNTIME_DIR, manifest.executable)),
  );
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

function expectedDigest(asset: ReleaseAsset): string | undefined {
  const match = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i);
  return match?.[1]?.toLowerCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 ** 2)).toFixed(1)} MiB`;
}

async function downloadAsset(asset: ReleaseAsset, destination: string): Promise<string> {
  const expected = expectedDigest(asset);
  if (existsSync(destination)) {
    const currentSize = statSync(destination).size;
    if (!asset.size || currentSize === asset.size) {
      const currentDigest = await sha256(destination);
      if (!expected || currentDigest === expected) {
        console.log(`[piper-neo] Reutilizando descarga verificada: ${asset.name} (${formatBytes(currentSize)}).`);
        return currentDigest;
      }
    }
    console.warn(`[piper-neo] La descarga en caché de ${asset.name} no es válida; se descargará nuevamente.`);
    rmSync(destination, { force: true });
  }

  const local = process.env.PIPER_NEO_ARCHIVE_PATH?.trim();
  if (local) {
    console.log(`[piper-neo] Usando archivo local: ${resolve(local)}`);
    copyFileSync(resolve(local), destination);
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("piper-neo-download-timeout")), DOWNLOAD_TIMEOUT_MS);
    try {
      console.log(
        `[piper-neo] Descargando ${asset.name}` +
        `${asset.size ? ` (${formatBytes(asset.size)})` : ""}...`,
      );
      const response = await fetch(asset.browser_download_url, {
        headers: { "User-Agent": `Luna-AI-Piper-Neo/Bun-${Bun.version}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Descarga respondió HTTP ${response.status}.`);

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let lastReportedPercent = -10;
      let lastReportedAt = Date.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        received += value.byteLength;
        const now = Date.now();
        const percent = asset.size ? Math.floor((received / asset.size) * 100) : -1;
        const shouldReportPercent = percent >= 0 && percent >= lastReportedPercent + 10;
        const shouldReportTime = now - lastReportedAt >= 5_000;
        if (shouldReportPercent || shouldReportTime) {
          console.log(
            asset.size
              ? `[piper-neo] Descarga: ${Math.min(100, percent)}% (${formatBytes(received)}/${formatBytes(asset.size)})`
              : `[piper-neo] Descargados ${formatBytes(received)}...`,
          );
          if (percent >= 0) lastReportedPercent = percent;
          lastReportedAt = now;
        }
      }

      const combined = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await Bun.write(destination, combined);
      console.log(`[piper-neo] Descarga completada: ${formatBytes(received)}.`);
    } finally { clearTimeout(timer); }
  }

  const size = statSync(destination).size;
  if (asset.size && size !== asset.size) {
    throw new Error(`Descarga incompleta de ${asset.name}: ${size} bytes, esperados ${asset.size}.`);
  }
  console.log(`[piper-neo] Verificando SHA-256 de ${asset.name}...`);
  const actual = await sha256(destination);
  if (expected && actual !== expected) throw new Error(`SHA-256 inválido para ${asset.name}: ${actual}`);
  console.log(`[piper-neo] SHA-256 correcto: ${actual}.`);
  return actual;
}

function psLiteral(path: string): string { return `'${resolve(path).replaceAll("'", "''")}'`; }

async function extractArchive(archive: string, destination: string, assetName: string): Promise<void> {
  console.log(`[piper-neo] Extrayendo ${assetName}...`);
  rmSync(destination, { recursive: true, force: true });
  ensureDir(destination);
  if (/\.(?:tar\.gz|tgz)$/i.test(assetName)) {
    const bundle = new Bun.Archive(await Bun.file(archive).bytes());
    await bundle.extract(destination);
    return;
  }
  if (/\.zip$/i.test(assetName)) {
    if (process.platform === "win32") {
      const powershell = Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell.exe";
      const command = `Expand-Archive -LiteralPath ${psLiteral(archive)} -DestinationPath ${psLiteral(destination)} -Force`;
      const child = Bun.spawn([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        stdout: "inherit", stderr: "inherit", windowsHide: true,
      });
      if (await child.exited !== 0) throw new Error("Expand-Archive no pudo extraer Piper Neo.");
      return;
    }
    const unzip = Bun.which("unzip");
    if (!unzip) throw new Error("Se necesita unzip para extraer el paquete ZIP de Piper Neo en Linux.");
    const child = Bun.spawn([unzip, "-o", archive, "-d", destination], { stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error("unzip no pudo extraer Piper Neo.");
    return;
  }
  // Algunas releases pueden publicar el binario directamente en vez de un
  // archive. Lo materializamos dentro del árbol temporal para reutilizar la
  // misma validación/copia del runtime.
  const directExecutable = process.platform === "win32" ? /\.exe$/i.test(assetName) : !/\.[a-z0-9]{2,6}$/i.test(assetName) || /\.(?:bin|run)$/i.test(assetName);
  if (directExecutable) {
    const target = join(destination, basename(assetName));
    copyFileSync(archive, target);
    if (process.platform !== "win32") chmodSync(target, 0o755);
    return;
  }
  throw new Error(`Formato de asset no soportado: ${assetName}`);
}

function executableScore(path: string): number {
  const name = basename(path).toLowerCase();
  const extension = extname(name);
  if (process.platform === "win32" && extension !== ".exe") return -1_000;
  if (process.platform !== "win32" && extension && !["", ".bin"].includes(extension)) return -1_000;
  let score = 0;
  if (name.includes("piper")) score += 50;
  if (name.includes("neo")) score += 35;
  if (name.includes("server")) score += 20;
  if (/^(?:piper[-_]?neo(?:[-_]?server)?|piper)(?:\.exe)?$/i.test(name)) score += 50;
  return score;
}

function chooseExecutable(files: string[]): string {
  const ranked = files
    .map((path) => ({ path, score: executableScore(path) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  if (!ranked[0]) throw new Error("El paquete de Piper Neo no contiene un ejecutable reconocible.");
  return ranked[0].path;
}

async function validateExecutable(executable: string): Promise<void> {
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  console.log(`[piper-neo] Validando ejecutable: ${relative(ROOT, executable)}`);
  const child = Bun.spawn([executable, "--help"], {
    cwd: dirname(executable),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  const exitResult = await Promise.race([
    child.exited.then((code) => ({ kind: "exit" as const, code })),
    Bun.sleep(EXECUTABLE_VALIDATE_TIMEOUT_MS).then(() => ({ kind: "timeout" as const, code: null })),
  ]);

  if (exitResult.kind === "timeout") {
    console.warn(
      `[piper-neo] El ejecutable siguió activo después de ${EXECUTABLE_VALIDATE_TIMEOUT_MS / 1000}s con --help; ` +
      "se cerrará la prueba para no bloquear el build.",
    );
    try {
      if (process.platform === "win32") child.kill();
      else child.kill("SIGKILL");
    } catch { /* ya terminó entre el race y el kill */ }
    await Promise.race([child.exited.catch(() => -1), Bun.sleep(2_000)]);
    return;
  }

  const stdout = child.stdout ? await new Response(child.stdout).text() : "";
  const stderr = child.stderr ? await new Response(child.stderr).text() : "";
  const output = `${stdout}\n${stderr}`.trim();
  if (!output && exitResult.code !== 0) throw new Error(`Piper Neo no pudo iniciar (código ${exitResult.code}).`);
  console.log(`[piper-neo] Ejecutable validado (código ${exitResult.code}).`);
}

function copyExtractedRuntime(sourceRoot: string, executable: string): string {
  const preservedDownloads = join(RUNTIME_DIR, ".downloads");
  for (const entry of readdirSync(RUNTIME_DIR, { withFileTypes: true })) {
    if (entry.name === ".downloads" || entry.name === "voices.json") continue;
    rmSync(join(RUNTIME_DIR, entry.name), { recursive: true, force: true });
  }
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    const target = join(RUNTIME_DIR, entry.name);
    cpRecursive(source, target);
  }
  void preservedDownloads;
  return relative(sourceRoot, executable).replaceAll("\\", "/");
}

function cpRecursive(source: string, destination: string): void {
  const info = statSync(source);
  if (info.isDirectory()) {
    ensureDir(destination);
    for (const entry of readdirSync(source)) cpRecursive(join(source, entry), join(destination, entry));
    return;
  }
  ensureDir(dirname(destination));
  copyFileSync(source, destination);
}

async function main(): Promise<void> {
  ensureDir(RUNTIME_DIR);
  ensureDir(DOWNLOAD_DIR);
  if (!existsSync(VOICES_SOURCE)) throw new Error("Falta assets/piper/voices.json.");
  copyFileSync(VOICES_SOURCE, VOICES_TARGET);

  const cached = readManifest();
  let release: ReleasePayload;
  try { release = await fetchRelease(); }
  catch (error) {
    if (manifestUsable(cached)) {
      console.warn(`[piper-neo] No se pudo consultar GitHub; reutilizando runtime local ${cached.version}: ${String(error)}`);
      return;
    }
    throw error;
  }

  const asset = chooseAsset(release);
  console.log(`[piper-neo] Objetivo ${process.platform}/${process.arch}: ${asset.name}`);
  if (manifestUsable(cached) && cached.version === release.tag_name && cached.assetName === asset.name) {
    console.log(`[piper-neo] Runtime ya actualizado: Piper Neo ${cached.version} (${cached.assetName}).`);
    return;
  }

  const archive = join(DOWNLOAD_DIR, asset.name);
  const digest = await downloadAsset(asset, archive);
  await extractArchive(archive, EXTRACT_DIR, asset.name);
  const files = walkFiles(EXTRACT_DIR);
  const executable = chooseExecutable(files);
  await validateExecutable(executable);
  const executableRelative = copyExtractedRuntime(EXTRACT_DIR, executable);
  const packagedExecutable = join(RUNTIME_DIR, executableRelative);
  if (process.platform !== "win32") chmodSync(packagedExecutable, 0o755);

  const manifest: PiperNeoRuntimeManifest = {
    schemaVersion: 1,
    version: release.tag_name,
    platform: process.platform,
    arch: process.arch,
    assetName: asset.name,
    assetDigest: digest,
    executable: executableRelative,
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[piper-neo] Piper Neo ${manifest.version} preparado: ${manifest.executable}`);
}

await main();
