import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  agentBrowserGenericName,
  agentBrowserNativeName,
  resolveManagedAgentBrowserChrome,
  resolveSystemBrowserExecutable,
  supportsManagedAgentBrowserChrome,
} from "../src/browser/browser-discovery.ts";

const root = process.cwd();
const packageDir = join(root, "node_modules", "agent-browser");
const packageJsonPath = join(packageDir, "package.json");
const nativeName = agentBrowserNativeName();
const genericName = agentBrowserGenericName();
const nodeModulesBinary = join(packageDir, "bin", nativeName);
const preparedDir = join(root, "assets", "runtime", "agent-browser");
const preparedBinary = join(preparedDir, genericName);
const preparedManifestPath = join(preparedDir, "manifest.json");

type PreparedManifest = {
  schemaVersion: 1;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  nativeName: string;
  genericName: string;
  preparedAt: string;
};

function rootAgentBrowserVersion(): string {
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const raw = rootPackage.dependencies?.["agent-browser"]?.trim();
  if (!raw) throw new Error("La dependencia agent-browser no está declarada en package.json.");
  const exact = raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u)?.[0];
  if (!exact) throw new Error(`No se pudo determinar la versión de agent-browser desde ${JSON.stringify(raw)}.`);
  return exact;
}

function installedAgentBrowserVersion(): string {
  if (!existsSync(packageJsonPath)) return rootAgentBrowserVersion();
  const installed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return installed.version?.trim() || rootAgentBrowserVersion();
}

function expectedManifest(): PreparedManifest {
  return {
    schemaVersion: 1,
    version: installedAgentBrowserVersion(),
    platform: process.platform,
    arch: process.arch,
    nativeName,
    genericName,
    preparedAt: new Date().toISOString(),
  };
}

function preparedBinaryMatchesCurrentPlatform(): boolean {
  if (!existsSync(preparedBinary) || !existsSync(preparedManifestPath)) return false;
  try {
    const current = JSON.parse(readFileSync(preparedManifestPath, "utf8")) as Partial<PreparedManifest>;
    const expected = expectedManifest();
    return current.schemaVersion === 1
      && current.version === expected.version
      && current.platform === expected.platform
      && current.arch === expected.arch
      && current.nativeName === expected.nativeName
      && current.genericName === expected.genericName;
  } catch {
    return false;
  }
}

function writePreparedManifest(): void {
  mkdirSync(preparedDir, { recursive: true });
  writeFileSync(preparedManifestPath, `${JSON.stringify(expectedManifest(), null, 2)}\n`, "utf8");
}

async function run(command: string[], label: string, stdin?: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    stdin: stdin === undefined ? "inherit" : "pipe",
    env: process.env,
  });
  if (stdin !== undefined && child.stdin) {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${label} terminó con código ${exitCode}.`);
}

async function tryDependencyPostinstall(): Promise<void> {
  const script = join(packageDir, "scripts", "postinstall.js");
  if (!existsSync(script)) return;
  console.log("[agent-browser] El binario nativo no está presente. Ejecutando el postinstall oficial del paquete...");
  await run([process.execPath, script], "postinstall de agent-browser");
}

async function downloadNativeBinary(destination: string): Promise<void> {
  const version = installedAgentBrowserVersion();
  const url = `https://github.com/vercel-labs/agent-browser/releases/download/v${version}/${nativeName}`;
  console.log(`[agent-browser] Descargando binario nativo ${nativeName} (${version})...`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`No se pudo descargar ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

async function ensureNativeBinary(): Promise<string> {
  mkdirSync(preparedDir, { recursive: true });

  if (!existsSync(nodeModulesBinary) && existsSync(packageDir)) {
    try {
      await tryDependencyPostinstall();
    } catch (error) {
      console.warn(`[agent-browser] El postinstall oficial no pudo preparar el binario: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (existsSync(nodeModulesBinary)) {
    copyFileSync(nodeModulesBinary, preparedBinary);
    writePreparedManifest();
    console.log(`[agent-browser] Binario nativo preparado para ${process.platform}/${process.arch}: ${preparedBinary}`);
  } else if (!preparedBinaryMatchesCurrentPlatform()) {
    await downloadNativeBinary(preparedBinary);
    writePreparedManifest();
    console.log(`[agent-browser] Binario nativo descargado para ${process.platform}/${process.arch}: ${preparedBinary}`);
  } else {
    console.log(`[agent-browser] Reutilizando binario nativo preparado para ${process.platform}/${process.arch}: ${preparedBinary}`);
  }

  if (process.platform !== "win32") chmodSync(preparedBinary, 0o755);
  return preparedBinary;
}

async function tryInstallSystemChromium(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  const existing = resolveSystemBrowserExecutable();
  if (existing) return existing;

  if (typeof process.getuid !== "function" || process.getuid() !== 0) return undefined;

  const apt = Bun.which("apt-get");
  if (apt) {
    console.log("[agent-browser] Instalando Chromium del sistema con APT para Linux...");
    await run([apt, "update"], "apt-get update");
    await run([
      apt,
      "install",
      "-y",
      "--no-install-recommends",
      "chromium",
      "fonts-liberation",
      "xdg-utils",
    ], "instalación de Chromium");
    return resolveSystemBrowserExecutable();
  }

  const apk = Bun.which("apk");
  if (apk) {
    console.log("[agent-browser] Instalando Chromium del sistema con APK para Linux...");
    await run([apk, "add", "--no-cache", "chromium", "font-liberation", "xdg-utils"], "instalación de Chromium");
    return resolveSystemBrowserExecutable();
  }

  const dnf = Bun.which("dnf");
  if (dnf) {
    console.log("[agent-browser] Instalando Chromium del sistema con DNF para Linux...");
    await run([dnf, "install", "-y", "chromium"], "instalación de Chromium");
    return resolveSystemBrowserExecutable();
  }

  return undefined;
}

async function ensureBrowser(binary: string): Promise<void> {
  const explicitBrowser = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
  if (explicitBrowser && existsSync(explicitBrowser)) {
    console.log(`[agent-browser] Navegador explícito reutilizado: ${explicitBrowser}`);
    return;
  }

  const managedSupported = supportsManagedAgentBrowserChrome();
  let systemBrowser = resolveSystemBrowserExecutable();

  // En Linux ARM64 Chrome for Testing no existe. El binario nativo de
  // agent-browser sí está soportado, por lo que usamos Chromium/Chrome del
  // sistema en lugar de intentar una descarga imposible.
  if (!managedSupported) {
    if (systemBrowser) {
      console.log(`[agent-browser] ${process.platform}/${process.arch} usa navegador del sistema: ${systemBrowser}`);
      return;
    }

    if (process.env.LUNA_AGENT_BROWSER_SKIP_INSTALL === "1") {
      console.warn(
        `[agent-browser] ${process.platform}/${process.arch} requiere un navegador del sistema y la instalación automática está desactivada.`,
      );
      return;
    }

    systemBrowser = await tryInstallSystemChromium();
    if (systemBrowser) {
      console.log(`[agent-browser] Chromium del sistema listo: ${systemBrowser}`);
      return;
    }

    throw new Error(
      `Chrome for Testing no está disponible para ${process.platform}/${process.arch}. `
      + "Instala Chromium/Chrome del sistema (por ejemplo: sudo apt install chromium) "
      + "o define AGENT_BROWSER_EXECUTABLE_PATH.",
    );
  }

  const managedBrowser = resolveManagedAgentBrowserChrome();
  if (managedBrowser) {
    console.log(`[agent-browser] Chrome for Testing reutilizado: ${managedBrowser}`);
    return;
  }

  if (process.env.LUNA_AGENT_BROWSER_USE_SYSTEM_BROWSER === "1" && systemBrowser) {
    console.log(`[agent-browser] LUNA_AGENT_BROWSER_USE_SYSTEM_BROWSER=1; usando navegador del sistema: ${systemBrowser}`);
    return;
  }

  if (process.env.LUNA_AGENT_BROWSER_SKIP_INSTALL === "1") {
    if (systemBrowser) {
      console.warn(`[agent-browser] Se omite Chrome for Testing. Fallback disponible: ${systemBrowser}`);
      return;
    }
    console.warn("[agent-browser] No se detectó navegador administrado y se omite la instalación automática.");
    return;
  }

  console.log("[agent-browser] Instalando Chrome for Testing administrado para un runtime reproducible...");
  const args = [binary, "install"];
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) {
    args.push("--with-deps");
  }
  await run(args, "agent-browser install");

  const installed = resolveManagedAgentBrowserChrome();
  if (!installed) {
    if (systemBrowser) {
      console.warn(`[agent-browser] No se localizó Chrome for Testing después de instalar. Se usará como fallback: ${systemBrowser}`);
      return;
    }
    throw new Error("agent-browser terminó la instalación, pero no se pudo localizar Chrome for Testing ni otro navegador compatible.");
  }
  console.log(`[agent-browser] Chrome for Testing listo: ${installed}`);
}

const binary = await ensureNativeBinary();
await ensureBrowser(binary);
console.log(`[agent-browser] Runtime de navegación listo para ${process.platform}/${process.arch}.`);
