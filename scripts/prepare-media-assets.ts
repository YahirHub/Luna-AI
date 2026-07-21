import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  ensureLinuxRuntimeDependencies,
  ensureLinuxSharedLibraryAliases,
  walkRuntimeFiles,
} from "./whisper-linux-libs.ts";

const ROOT = process.cwd();
const RUNTIME_DIR = join(ROOT, "assets", "runtime");
const WHISPER_DIR = join(RUNTIME_DIR, "whisper");
const WHISPER_BIN_DIR = join(WHISPER_DIR, "bin");
const WHISPER_DOWNLOAD_DIR = join(WHISPER_DIR, ".downloads");
const WHISPER_MANIFEST_PATH = join(WHISPER_DIR, "manifest.json");
const WHISPER_MODEL_FILENAME = "ggml-base-q5_1.bin";
const WHISPER_MODEL_PATH = join(WHISPER_DIR, "models", WHISPER_MODEL_FILENAME);
const WHISPER_MODEL_SHA256 = "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898";
const WHISPER_RELEASE_API = "https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest";
const FFMPEG_DIR = join(RUNTIME_DIR, "ffmpeg");
const FFMPEG_DOWNLOAD_DIR = join(FFMPEG_DIR, ".downloads");
const FFMPEG_MANIFEST_PATH = join(FFMPEG_DIR, "manifest.json");
const FFMPEG_RELEASE_TAG = process.env.FFMPEG_STATIC_RELEASE_TAG?.trim() || "b6.1.1";
const FFMPEG_RELEASE_API = `https://api.github.com/repos/eugeneware/ffmpeg-static/releases/tags/${encodeURIComponent(FFMPEG_RELEASE_TAG)}`;
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

type ByteStreamReadResult = {
  done: boolean;
  value?: Uint8Array;
};

type ByteStreamReader = {
  read(): Promise<ByteStreamReadResult>;
  cancel(reason?: unknown): Promise<void>;
};
const DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_RETRIES_PER_SOURCE = 2;
const OBSOLETE_WHISPER_MODELS: readonly string[] = ["ggml-tiny-q5_1.bin"];

const DEFAULT_MODEL_URLS = [
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb45af861ab5e5297d23694b7d46e090c02c/ggml-base-q5_1.bin",
  "https://whisper.ggerganov.com/ggml-model-whisper-base-q5_1.bin",
];

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
  digest?: string | null;
  size?: number;
};

type GitHubRelease = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};

export type WhisperRuntimeManifest = {
  schemaVersion: 1;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  assetName: string;
  assetDigest: string;
  executable: string;
  model: string;
  libraryDirs: string[];
  preparedAt: string;
};

export type FfmpegRuntimeManifest = {
  schemaVersion: 1;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  assetName: string;
  assetDigest: string;
  executable: string;
  preparedAt: string;
};

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // El archivo no existía o ya fue eliminado.
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function formatProgress(downloaded: number, total?: number): string {
  if (!total || total <= 0) return formatBytes(downloaded);
  const percentage = Math.min(100, (downloaded / total) * 100);
  return `${percentage.toFixed(1)}% (${formatBytes(downloaded)} / ${formatBytes(total)})`;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

async function isVerifiedFile(path: string, expectedSha256: string): Promise<boolean> {
  return existsSync(path) && (await sha256(path)) === expectedSha256.toLowerCase();
}

function parseSha256Digest(digest: string | null | undefined, assetName: string): string {
  const match = digest?.match(/^sha256:([a-f0-9]{64})$/i);
  if (!match?.[1]) {
    throw new Error(`GitHub no publicó un SHA-256 verificable para ${assetName}.`);
  }
  return match[1].toLowerCase();
}

function platformAssetName(platform = process.platform, arch = process.arch): string {
  if (platform === "win32" && arch === "x64") return "whisper-bin-x64.zip";
  if (platform === "win32" && arch === "ia32") return "whisper-bin-Win32.zip";
  if (platform === "linux" && arch === "x64") return "whisper-bin-ubuntu-x64.tar.gz";
  if (platform === "linux" && arch === "arm64") return "whisper-bin-ubuntu-arm64.tar.gz";
  throw new Error(`whisper.cpp no publica un binario CLI compatible con ${platform}/${arch}.`);
}

function parseTotalSize(response: Response, resumedBytes: number): number | undefined {
  const contentRange = response.headers.get("content-range");
  const rangeMatch = contentRange?.match(/\/([0-9]+)$/);
  if (rangeMatch?.[1]) {
    const total = Number(rangeMatch[1]);
    return Number.isFinite(total) && total > 0 ? total : undefined;
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (!Number.isFinite(contentLength) || contentLength <= 0) return undefined;
  return response.status === 206 ? resumedBytes + contentLength : contentLength;
}

async function readWithIdleTimeout(
  reader: ByteStreamReader,
  controller: AbortController,
): Promise<ByteStreamReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`La descarga no recibió datos durante ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} segundos.`));
        }, DOWNLOAD_IDLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = writeSync(fd, chunk, offset, chunk.byteLength - offset, null);
    if (written <= 0) throw new Error("No se pudo escribir el siguiente bloque en disco.");
    offset += written;
  }
}

async function streamDownload(url: string, temporary: string, label: string): Promise<void> {
  const existingBytes = existsSync(temporary) ? statSync(temporary).size : 0;
  const headers: Record<string, string> = {
    Accept: "application/octet-stream",
    "Accept-Encoding": "identity",
    "Cache-Control": "no-cache",
    "User-Agent": `Luna-AI-media-assets/Bun-${Bun.version}`,
  };
  if (existingBytes > 0) headers.Range = `bytes=${existingBytes}-`;

  const controller = new AbortController();
  let timeoutReason: "connect" | "total" | undefined;
  const totalTimer = setTimeout(() => {
    timeoutReason = "total";
    controller.abort();
  }, DOWNLOAD_TOTAL_TIMEOUT_MS);
  const connectTimer = setTimeout(() => {
    timeoutReason = "connect";
    controller.abort();
  }, DOWNLOAD_CONNECT_TIMEOUT_MS);
  let reader: ByteStreamReader | undefined;
  let fd: number | undefined;

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers,
      signal: controller.signal,
      keepalive: false,
      decompress: false,
    } as RequestInit & { decompress: boolean });
    clearTimeout(connectTimer);

    if (response.status === 416 && existingBytes > 0) return;
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }

    const canResume = existingBytes > 0 && response.status === 206;
    const resumedBytes = canResume ? existingBytes : 0;
    if (existingBytes > 0 && !canResume) {
      console.log(`[media-assets] ${label}: el servidor no aceptó reanudación; reiniciando.`);
    } else if (canResume) {
      console.log(`[media-assets] ${label}: reanudando desde ${formatBytes(existingBytes)}...`);
    }

    const totalSize = parseTotalSize(response, resumedBytes);
    const openedFd = openSync(temporary, canResume ? "a" : "w");
    fd = openedFd;
    const responseReader: ByteStreamReader = response.body.getReader();
    reader = responseReader;
    let downloaded = resumedBytes;
    let lastPrintedAt = 0;
    let lastPrintedBytes = downloaded;
    process.stdout.write(`[media-assets] ${label}: ${formatProgress(downloaded, totalSize)}`);

    while (true) {
      const { done, value } = await readWithIdleTimeout(responseReader, controller);
      if (done) break;
      if (!value?.byteLength) continue;
      writeAll(openedFd, value);
      downloaded += value.byteLength;

      const now = Date.now();
      if (now - lastPrintedAt >= 500 || downloaded - lastPrintedBytes >= 1024 ** 2) {
        process.stdout.write(`\r[media-assets] ${label}: ${formatProgress(downloaded, totalSize)}`);
        lastPrintedAt = now;
        lastPrintedBytes = downloaded;
      }
    }

    process.stdout.write(`\r[media-assets] ${label}: ${formatProgress(downloaded, totalSize)}\n`);
    if (totalSize && downloaded !== totalSize) {
      throw new Error(`Descarga incompleta: ${formatBytes(downloaded)} de ${formatBytes(totalSize)}.`);
    }
  } catch (error) {
    if (timeoutReason === "connect") {
      throw new Error(`No se recibió respuesta en ${DOWNLOAD_CONNECT_TIMEOUT_MS / 1000} segundos.`, { cause: error });
    }
    if (timeoutReason === "total") {
      throw new Error(`La descarga excedió ${DOWNLOAD_TOTAL_TIMEOUT_MS / 60_000} minutos.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    try {
      await reader?.cancel();
    } catch {
      // La respuesta ya terminó o fue abortada.
    }
    if (fd !== undefined) closeSync(fd);
  }
}

async function downloadVerified(
  urls: string[],
  destination: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  if (await isVerifiedFile(destination, expectedSha256)) {
    console.log(`[media-assets] Reutilizando ${label}: ${destination}`);
    return;
  }

  ensureDir(dirname(destination));
  const temporary = `${destination}.download`;
  let lastError: unknown;

  for (const url of urls) {
    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES_PER_SOURCE; attempt += 1) {
      console.log(
        `[media-assets] Descargando ${label} desde ${new URL(url).host} ` +
          `(intento ${attempt}/${DOWNLOAD_RETRIES_PER_SOURCE})...`,
      );
      try {
        await streamDownload(url, temporary, label);
        const actualSha = await sha256(temporary);
        if (actualSha !== expectedSha256.toLowerCase()) {
          removeFile(temporary);
          throw new Error(`SHA-256 inválido: ${actualSha}`);
        }
        removeFile(destination);
        renameSync(temporary, destination);
        console.log(`[media-assets] ${label} verificado: ${actualSha}`);
        return;
      } catch (error) {
        lastError = error;
        console.warn(`[media-assets] Falló ${new URL(url).host}: ${String(error)}`);
        if (attempt < DOWNLOAD_RETRIES_PER_SOURCE) await Bun.sleep(attempt * 1500);
      }
    }
  }

  throw new Error(`No se pudo descargar ${label}: ${String(lastError)}`);
}

async function fetchLatestWhisperRelease(): Promise<GitHubRelease> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_CONNECT_TIMEOUT_MS);
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `Luna-AI-media-assets/Bun-${Bun.version}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(WHISPER_RELEASE_API, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`GitHub API respondió HTTP ${response.status}.`);
    const value = await response.json() as Partial<GitHubRelease>;
    if (!value.tag_name || !Array.isArray(value.assets)) {
      throw new Error("GitHub devolvió una release de whisper.cpp inválida.");
    }
    return value as GitHubRelease;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFfmpegRelease(): Promise<GitHubRelease> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_CONNECT_TIMEOUT_MS);
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `Luna-AI-media-assets/Bun-${Bun.version}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(FFMPEG_RELEASE_API, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`GitHub API respondió HTTP ${response.status}.`);
    const value = await response.json() as Partial<GitHubRelease>;
    if (!value.tag_name || !Array.isArray(value.assets)) throw new Error("GitHub devolvió una release de FFmpeg inválida.");
    return value as GitHubRelease;
  } finally { clearTimeout(timer); }
}

function ffmpegAssetName(platform = process.platform, arch = process.arch): string {
  const supported = (platform === "linux" && ["x64", "arm64", "arm", "ia32"].includes(arch))
    || (platform === "win32" && arch === "x64");
  if (!supported) throw new Error(`No existe un FFmpeg estático configurado para ${platform}/${arch}.`);
  return `ffmpeg-${platform}-${arch}.gz`;
}

function readFfmpegManifest(): FfmpegRuntimeManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(FFMPEG_MANIFEST_PATH, "utf8")) as FfmpegRuntimeManifest;
    return parsed?.schemaVersion === 1 ? parsed : null;
  } catch { return null; }
}

function ffmpegManifestIsUsable(manifest: FfmpegRuntimeManifest | null): manifest is FfmpegRuntimeManifest {
  return Boolean(manifest && manifest.platform === process.platform && manifest.arch === process.arch && existsSync(join(FFMPEG_DIR, manifest.executable)));
}

async function validateFfmpegRuntime(manifest: FfmpegRuntimeManifest): Promise<void> {
  const executable = join(FFMPEG_DIR, manifest.executable);
  const child = Bun.spawn([executable, "-hide_banner", "-version"], { cwd: FFMPEG_DIR, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const stdoutPromise = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
  const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) throw new Error(`El runtime de FFmpeg no puede iniciar: ${(stderr || stdout || `código ${exitCode}`).trim().slice(-1500)}`);
}

async function prepareFfmpegBinary(): Promise<void> {
  const assetName = ffmpegAssetName();
  const cached = readFfmpegManifest();
  let release: GitHubRelease;
  try { release = await fetchFfmpegRelease(); }
  catch (error) {
    if (ffmpegManifestIsUsable(cached)) {
      if (process.platform !== "win32") chmodSync(join(FFMPEG_DIR, cached.executable), 0o755);
      await validateFfmpegRuntime(cached);
      console.warn(`[media-assets] No se pudo consultar FFmpeg; reutilizando runtime local: ${String(error)}`);
      return;
    }
    throw error;
  }
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) throw new Error(`La release ${release.tag_name} no contiene ${assetName}.`);
  const digest = parseSha256Digest(asset.digest, asset.name);
  if (ffmpegManifestIsUsable(cached) && cached.version === release.tag_name && cached.assetName === asset.name && cached.assetDigest === digest) {
    if (process.platform !== "win32") chmodSync(join(FFMPEG_DIR, cached.executable), 0o755);
    await validateFfmpegRuntime(cached);
    console.log(`[media-assets] Reutilizando FFmpeg ${release.tag_name} (${asset.name}).`);
    return;
  }
  ensureDir(FFMPEG_DOWNLOAD_DIR);
  const archive = join(FFMPEG_DOWNLOAD_DIR, asset.name);
  const local = process.env.FFMPEG_STATIC_ARCHIVE_PATH?.trim();
  if (local) {
    const source = resolve(local);
    if (!(await isVerifiedFile(source, digest))) throw new Error(`FFMPEG_STATIC_ARCHIVE_PATH no coincide con ${release.tag_name}.`);
    copyFileSync(source, archive);
  } else {
    await downloadVerified([asset.browser_download_url], archive, digest, asset.name);
  }
  const executableName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  ensureDir(FFMPEG_DIR);
  writeFileSync(join(FFMPEG_DIR, executableName), gunzipSync(readFileSync(archive)));
  if (process.platform !== "win32") chmodSync(join(FFMPEG_DIR, executableName), 0o755);
  const manifest: FfmpegRuntimeManifest = {
    schemaVersion: 1, version: release.tag_name, platform: process.platform, arch: process.arch,
    assetName: asset.name, assetDigest: digest, executable: executableName, preparedAt: new Date().toISOString(),
  };
  writeFileSync(FFMPEG_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await validateFfmpegRuntime(manifest);
  console.log(`[media-assets] FFmpeg ${release.tag_name} preparado para ${process.platform}/${process.arch}.`);
}

function readManifest(): WhisperRuntimeManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(WHISPER_MANIFEST_PATH, "utf8")) as WhisperRuntimeManifest;
    return parsed?.schemaVersion === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function expectedModelRelativePath(): string {
  return relative(WHISPER_DIR, WHISPER_MODEL_PATH).replaceAll("\\", "/");
}

function manifestIsUsable(manifest: WhisperRuntimeManifest | null): manifest is WhisperRuntimeManifest {
  if (!manifest) return false;
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return false;
  return existsSync(join(WHISPER_DIR, manifest.executable))
    && existsSync(WHISPER_MODEL_PATH);
}

function updateManifestModel(manifest: WhisperRuntimeManifest): WhisperRuntimeManifest {
  const model = expectedModelRelativePath();
  if (manifest.model === model) return manifest;
  const updated = { ...manifest, model, preparedAt: new Date().toISOString() };
  writeFileSync(WHISPER_MANIFEST_PATH, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

function quotePowerShellLiteral(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

async function extractArchive(archivePath: string, destination: string, assetName: string): Promise<void> {
  rmSync(destination, { recursive: true, force: true });
  ensureDir(destination);

  if (assetName.endsWith(".tar.gz")) {
    const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
    await archive.extract(destination);
    return;
  }

  if (assetName.endsWith(".zip") && process.platform === "win32") {
    const powershell = Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell.exe";
    const command = `Expand-Archive -LiteralPath ${quotePowerShellLiteral(resolve(archivePath))} ` +
      `-DestinationPath ${quotePowerShellLiteral(resolve(destination))} -Force`;
    const child = Bun.spawn([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      stdout: "inherit",
      stderr: "inherit",
      windowsHide: true,
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Expand-Archive terminó con código ${exitCode}.`);
    return;
  }

  throw new Error(`No existe un extractor compatible para ${assetName} en ${process.platform}.`);
}

function findWhisperExecutable(files: string[]): string {
  const expected = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const executable = files.find((path) => basename(path).toLowerCase() === expected.toLowerCase());
  if (!executable) throw new Error(`El paquete oficial no contiene ${expected}.`);
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  return executable;
}

function libraryDirectories(files: string[]): string[] {
  const extensions = process.platform === "win32" ? new Set([".dll"]) : new Set([".so", ".dylib"]);
  return [...new Set(
    files
      .filter((path) => extensions.has(extname(path).toLowerCase()) || basename(path).includes(".so."))
      .map((path) => relative(WHISPER_DIR, dirname(path)).replaceAll("\\", "/")),
  )].sort();
}

async function repairWhisperRuntime(manifest: WhisperRuntimeManifest): Promise<WhisperRuntimeManifest> {
  const aliases = ensureLinuxSharedLibraryAliases(WHISPER_BIN_DIR);
  for (const alias of aliases) {
    console.log(`[media-assets] Alias Linux restaurado: ${relative(WHISPER_DIR, alias)}`);
  }
  const dependencies = await ensureLinuxRuntimeDependencies(WHISPER_DIR);
  for (const dependency of dependencies) {
    console.log(`[media-assets] Dependencia Linux incluida: ${relative(WHISPER_DIR, dependency)}`);
  }

  const files = walkRuntimeFiles(WHISPER_DIR);
  const libraryDirs = libraryDirectories(files);
  const updated = {
    ...manifest,
    model: expectedModelRelativePath(),
    libraryDirs,
    preparedAt: aliases.length > 0 || dependencies.length > 0 || manifest.model !== expectedModelRelativePath()
      ? new Date().toISOString()
      : manifest.preparedAt,
  };

  if (JSON.stringify(updated) !== JSON.stringify(manifest)) {
    writeFileSync(WHISPER_MANIFEST_PATH, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  }
  return updated;
}

async function validateWhisperRuntime(manifest: WhisperRuntimeManifest): Promise<void> {
  if (process.platform !== "linux") return;

  const executable = join(WHISPER_DIR, manifest.executable);
  const libraryDirs = manifest.libraryDirs.map((path) => join(WHISPER_DIR, path));
  const libraryPath = libraryDirs.join(":");
  const child = Bun.spawn([executable, "--help"], {
    cwd: dirname(executable),
    env: {
      ...process.env,
      PATH: [libraryPath, process.env.PATH ?? ""].filter(Boolean).join(":"),
      LD_LIBRARY_PATH: [libraryPath, process.env.LD_LIBRARY_PATH ?? ""].filter(Boolean).join(":"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
  const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `código ${exitCode}`;
    throw new Error(`El runtime Linux de whisper.cpp no puede iniciar: ${detail.slice(-1_500)}`);
  }
}

async function prepareWhisperBinary(): Promise<void> {
  const assetName = platformAssetName();
  const cachedManifest = readManifest();
  let release: GitHubRelease;

  try {
    release = await fetchLatestWhisperRelease();
  } catch (error) {
    if (manifestIsUsable(cachedManifest)) {
      const updatedManifest = await repairWhisperRuntime(updateManifestModel(cachedManifest));
      await validateWhisperRuntime(updatedManifest);
      console.warn(`[media-assets] No se pudo consultar la release latest; usando ${updatedManifest.version}: ${String(error)}`);
      return;
    }
    throw error;
  }

  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) throw new Error(`La release ${release.tag_name} no contiene ${assetName}.`);
  const assetSha256 = parseSha256Digest(asset.digest, asset.name);

  if (
    manifestIsUsable(cachedManifest)
    && cachedManifest.version === release.tag_name
    && cachedManifest.assetName === asset.name
    && cachedManifest.assetDigest === assetSha256
  ) {
    const updatedManifest = await repairWhisperRuntime(updateManifestModel(cachedManifest));
    await validateWhisperRuntime(updatedManifest);
    console.log(`[media-assets] Reutilizando whisper.cpp ${release.tag_name} (${asset.name}).`);
    return;
  }

  ensureDir(WHISPER_DOWNLOAD_DIR);
  const archivePath = join(WHISPER_DOWNLOAD_DIR, asset.name);
  const localArchive = process.env.WHISPER_CPP_ARCHIVE_PATH?.trim();
  if (localArchive) {
    const source = resolve(localArchive);
    if (!(await isVerifiedFile(source, assetSha256))) {
      throw new Error(`WHISPER_CPP_ARCHIVE_PATH no coincide con el digest de ${release.tag_name}.`);
    }
    copyFileSync(source, archivePath);
  } else {
    await downloadVerified([asset.browser_download_url], archivePath, assetSha256, asset.name);
  }

  console.log(`[media-assets] Extrayendo whisper.cpp ${release.tag_name}...`);
  await extractArchive(archivePath, WHISPER_BIN_DIR, asset.name);
  const files = walkRuntimeFiles(WHISPER_BIN_DIR);
  const executable = findWhisperExecutable(files);
  const manifest: WhisperRuntimeManifest = {
    schemaVersion: 1,
    version: release.tag_name,
    platform: process.platform,
    arch: process.arch,
    assetName: asset.name,
    assetDigest: assetSha256,
    executable: relative(WHISPER_DIR, executable).replaceAll("\\", "/"),
    model: expectedModelRelativePath(),
    libraryDirs: libraryDirectories(files),
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(WHISPER_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const repairedManifest = await repairWhisperRuntime(manifest);
  await validateWhisperRuntime(repairedManifest);
  console.log(`[media-assets] whisper.cpp ${release.tag_name} preparado para ${process.platform}/${process.arch}.`);
}

function cleanupObsoleteWhisperModels(): void {
  const modelsDir = dirname(WHISPER_MODEL_PATH);
  for (const filename of OBSOLETE_WHISPER_MODELS) {
    if (filename === WHISPER_MODEL_FILENAME) continue;
    const obsoletePath = join(modelsDir, filename);
    if (!existsSync(obsoletePath)) continue;
    removeFile(obsoletePath);
    console.log(`[media-assets] Eliminado modelo obsoleto ${filename}.`);
  }
}

async function prepareWhisperModel(): Promise<void> {
  const localModel = process.env.WHISPER_MODEL_PATH?.trim();
  if (localModel) {
    const source = resolve(localModel);
    if (!(await isVerifiedFile(source, WHISPER_MODEL_SHA256))) {
      throw new Error(`WHISPER_MODEL_PATH no coincide con el SHA-256 esperado.`);
    }
    ensureDir(dirname(WHISPER_MODEL_PATH));
    if (source !== resolve(WHISPER_MODEL_PATH)) copyFileSync(source, WHISPER_MODEL_PATH);
    cleanupObsoleteWhisperModels();
    console.log(`[media-assets] Modelo local verificado y reutilizado: ${source}`);
    return;
  }

  const overrideUrl = process.env.WHISPER_MODEL_URL?.trim();
  await downloadVerified(
    overrideUrl ? [overrideUrl] : DEFAULT_MODEL_URLS,
    WHISPER_MODEL_PATH,
    WHISPER_MODEL_SHA256,
    WHISPER_MODEL_FILENAME,
  );
  cleanupObsoleteWhisperModels();
}

function copyDependencyAsset(source: string, destination: string): void {
  if (!existsSync(source)) throw new Error(`Falta el asset instalado: ${source}. Ejecuta bun install.`);
  ensureDir(dirname(destination));
  copyFileSync(source, destination);
  console.log(`[media-assets] Copiado ${basename(destination)}`);
}

await prepareFfmpegBinary();
await prepareWhisperModel();
await prepareWhisperBinary();
copyDependencyAsset(
  join(ROOT, "node_modules", "tesseract-wasm", "dist", "tesseract-core.wasm"),
  join(RUNTIME_DIR, "tesseract", "tesseract-core.wasm"),
);
copyDependencyAsset(
  join(ROOT, "node_modules", "tesseract-wasm", "dist", "tesseract-core-fallback.wasm"),
  join(RUNTIME_DIR, "tesseract", "tesseract-core-fallback.wasm"),
);
copyDependencyAsset(
  join(ROOT, "node_modules", "@tesseract.js-data", "spa", "4.0.0_best_int", "spa.traineddata.gz"),
  join(RUNTIME_DIR, "ocr", "spa.traineddata.gz"),
);
