import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

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


const REQUIRED_LINUX_RUNTIME_LIBRARIES = ["libgomp.so.1"] as const;

type RuntimeDependencyName = (typeof REQUIRED_LINUX_RUNTIME_LIBRARIES)[number];

type LinuxPackageDownloader = (
  filename: RuntimeDependencyName,
  destinationDirectory: string,
  environment: NodeJS.ProcessEnv,
) => Promise<string | null>;

type LinuxRuntimeDependencyOptions = {
  candidates?: Partial<Record<RuntimeDependencyName, string[]>>;
  environment?: NodeJS.ProcessEnv;
  searchSystem?: boolean;
  packageDownloader?: LinuxPackageDownloader;
  allowPackageDownload?: boolean;
};

type DebianPackageDefinition = {
  filename: string;
  urls: readonly string[];
  sha256: string;
};

const DEBIAN_LIBGOMP_PACKAGES: Partial<Record<NodeJS.Architecture, DebianPackageDefinition>> = {
  x64: {
    filename: "libgomp1_12.2.0-14+deb12u1_amd64.deb",
    urls: [
      "https://deb.debian.org/debian/pool/main/g/gcc-12/libgomp1_12.2.0-14+deb12u1_amd64.deb",
      "https://ftp.debian.org/debian/pool/main/g/gcc-12/libgomp1_12.2.0-14+deb12u1_amd64.deb",
    ],
    sha256: "48fec46bda7f5b1638b9e959889bfbc20491247d402d120bb152687eb48143d7",
  },
  arm64: {
    filename: "libgomp1_12.2.0-14+deb12u1_arm64.deb",
    urls: [
      "https://deb.debian.org/debian/pool/main/g/gcc-12/libgomp1_12.2.0-14+deb12u1_arm64.deb",
      "https://ftp.debian.org/debian/pool/main/g/gcc-12/libgomp1_12.2.0-14+deb12u1_arm64.deb",
    ],
    sha256: "a48b70dd1a95585466b40bd94564bce56ebcb2566e49ccdb6441e996aaab2098",
  },
};

function decodeOutput(value: Uint8Array | undefined): string {
  return value ? new TextDecoder().decode(value).trim() : "";
}

function commandCandidates(filename: string): string[] {
  const candidates: string[] = [];

  const gcc = Bun.which("gcc");
  if (gcc) {
    const result = Bun.spawnSync([gcc, `-print-file-name=${filename}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const path = decodeOutput(result.stdout);
    if (result.exitCode === 0 && isAbsolute(path)) candidates.push(path);
  }

  const ldconfig = Bun.which("ldconfig");
  if (ldconfig) {
    const result = Bun.spawnSync([ldconfig, "-p"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) {
      const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = decodeOutput(result.stdout).match(
        new RegExp(`(?:^|\\n)\\s*${escaped}\\s+[^\\n]*=>\\s*(/[^\\n]+)`),
      );
      if (match?.[1]) candidates.push(match[1].trim());
    }
  }

  const triplet = process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
  candidates.push(
    `/usr/lib/${triplet}/${filename}`,
    `/lib/${triplet}/${filename}`,
    `/usr/lib64/${filename}`,
    `/lib64/${filename}`,
  );
  return candidates;
}

function resolveRuntimeDependency(
  filename: RuntimeDependencyName,
  options: LinuxRuntimeDependencyOptions,
): string | null {
  const environment = options.environment ?? process.env;
  const envName = filename === "libgomp.so.1" ? "LUNA_LIBGOMP_PATH" : "";
  const candidates = [
    envName ? environment[envName]?.trim() ?? "" : "",
    ...(options.candidates?.[filename] ?? []),
    ...(options.searchSystem === false ? [] : commandCandidates(filename)),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
    } catch {
      // Continúa con la siguiente ubicación compatible.
    }
  }
  return null;
}

function commandFailureDetail(result: {
  stdout?: Uint8Array;
  stderr?: Uint8Array;
  exitCode: number;
}): string {
  return decodeOutput(result.stderr) || decodeOutput(result.stdout) || `código ${result.exitCode}`;
}

function extractDebianLibrary(
  packagePath: string,
  filename: RuntimeDependencyName,
  destinationDirectory: string,
  temporaryDirectory: string,
): string | null {
  const dpkgDeb = Bun.which("dpkg-deb");
  if (!dpkgDeb) return null;

  const extractedDirectory = join(temporaryDirectory, "extracted");
  rmSync(extractedDirectory, { recursive: true, force: true });
  mkdirSync(extractedDirectory, { recursive: true });
  const extraction = Bun.spawnSync([dpkgDeb, "-x", packagePath, extractedDirectory], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (extraction.exitCode !== 0) {
    console.warn(
      `[media-assets] No se pudo extraer libgomp1: ${commandFailureDetail(extraction)}`,
    );
    return null;
  }

  const source = walkRuntimeFiles(extractedDirectory)
    .find((path) => basename(path) === filename);
  if (!source) {
    console.warn(`[media-assets] El paquete libgomp1 no contiene ${filename}.`);
    return null;
  }

  mkdirSync(destinationDirectory, { recursive: true });
  const destination = join(destinationDirectory, filename);
  copyFileSync(realpathSync(source), destination);
  return destination;
}

async function sha256File(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

async function downloadPinnedDebianPackage(
  definition: DebianPackageDefinition,
  destination: string,
): Promise<boolean> {
  for (const url of definition.urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      console.log(
        `[media-assets] Descargando ${definition.filename} desde ${new URL(url).hostname}...`,
      );
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "Luna-AI media runtime preparer" },
      });
      if (!response.ok) {
        console.warn(
          `[media-assets] Debian respondió HTTP ${response.status} al descargar libgomp1.`,
        );
        continue;
      }

      await Bun.write(destination, new Uint8Array(await response.arrayBuffer()));
      const digest = await sha256File(destination);
      if (digest !== definition.sha256) {
        rmSync(destination, { force: true });
        console.warn(
          `[media-assets] SHA-256 inválido para ${definition.filename}: ${digest}`,
        );
        continue;
      }
      return true;
    } catch (error) {
      console.warn(
        `[media-assets] No se pudo descargar libgomp1 desde ${new URL(url).hostname}: ${String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  return false;
}

/**
 * Obtiene libgomp1 sin instalarla globalmente:
 * 1. intenta `apt-get download`, que respeta los repositorios configurados;
 * 2. si APT no tiene índices utilizables, descarga un paquete Debian Bookworm
 *    fijado por arquitectura y SHA-256 desde deb.debian.org;
 * 3. extrae únicamente libgomp.so.1 dentro del runtime de Luna.
 */
export async function downloadDebianRuntimeDependency(
  filename: RuntimeDependencyName,
  destinationDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (filename !== "libgomp.so.1") return null;

  const dpkgDeb = Bun.which("dpkg-deb");
  if (!dpkgDeb) return null;

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "luna-libgomp-"));
  try {
    const apt = Bun.which("apt-get") ?? Bun.which("apt");
    if (apt) {
      const aptArguments = [apt];
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        aptArguments.push("-o", "APT::Sandbox::User=root");
      }
      aptArguments.push("download", "libgomp1");

      const download = Bun.spawnSync(aptArguments, {
        cwd: temporaryDirectory,
        env: { ...environment, DEBIAN_FRONTEND: "noninteractive" },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (download.exitCode === 0) {
        const aptPackagePath = walkRuntimeFiles(temporaryDirectory)
          .find((path) => path.endsWith(".deb"));
        if (aptPackagePath) {
          const destination = extractDebianLibrary(
            aptPackagePath,
            filename,
            destinationDirectory,
            temporaryDirectory,
          );
          if (destination) {
            console.log(
              `[media-assets] ${filename} obtenido con APT para ${process.arch}.`,
            );
            return destination;
          }
        }
      } else {
        console.warn(
          `[media-assets] APT no pudo descargar libgomp1; usando paquete fijado: ` +
            commandFailureDetail(download),
        );
      }
    }

    const definition = DEBIAN_LIBGOMP_PACKAGES[process.arch];
    if (!definition) return null;
    const packagePath = join(temporaryDirectory, definition.filename);
    if (!(await downloadPinnedDebianPackage(definition, packagePath))) return null;

    const destination = extractDebianLibrary(
      packagePath,
      filename,
      destinationDirectory,
      temporaryDirectory,
    );
    if (destination) {
      console.log(
        `[media-assets] ${filename} obtenido desde Debian Bookworm para ${process.arch}.`,
      );
    }
    return destination;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Los binarios oficiales Ubuntu de whisper.cpp usan OpenMP y requieren
 * libgomp.so.1. Se copia dentro del runtime distribuible para que un release
 * funcione también en instalaciones Linux mínimas sin instalar paquetes.
 */
export async function ensureLinuxRuntimeDependencies(
  root: string,
  platform: NodeJS.Platform = process.platform,
  options: LinuxRuntimeDependencyOptions = {},
): Promise<string[]> {
  if (platform !== "linux") return [];

  const existing = new Set(walkRuntimeFiles(root).map((path) => basename(path)));
  const destinationDirectory = join(root, "system-libs");
  const copied: string[] = [];

  for (const filename of REQUIRED_LINUX_RUNTIME_LIBRARIES) {
    if (existing.has(filename)) continue;

    const source = resolveRuntimeDependency(filename, options);
    if (source) {
      mkdirSync(destinationDirectory, { recursive: true });
      const destination = join(destinationDirectory, filename);
      copyFileSync(source, destination);
      copied.push(destination);
      continue;
    }

    const environment = options.environment ?? process.env;
    const packageDownloader = options.packageDownloader ?? downloadDebianRuntimeDependency;
    const downloaded = options.allowPackageDownload === false
      ? null
      : await packageDownloader(filename, destinationDirectory, environment);
    if (downloaded) {
      copied.push(downloaded);
      continue;
    }

    throw new Error(
      `No se encontró ${filename} para empaquetar whisper.cpp. ` +
        "Luna intentó APT y un paquete Debian fijado por arquitectura. " +
        "Instala libgomp1, comprueba el acceso a deb.debian.org o define LUNA_LIBGOMP_PATH.",
    );
  }

  return copied;
}
