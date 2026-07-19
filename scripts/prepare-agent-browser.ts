import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  agentBrowserGenericName,
  agentBrowserNativeName,
  resolveManagedAgentBrowserChrome,
  resolveSystemBrowserExecutable,
} from "../src/browser/browser-discovery.ts";

const root = process.cwd();
const packageDir = join(root, "node_modules", "agent-browser");
const packageJsonPath = join(packageDir, "package.json");
const nativeName = agentBrowserNativeName();
const genericName = agentBrowserGenericName();
const nodeModulesBinary = join(packageDir, "bin", nativeName);
const preparedDir = join(root, "assets", "runtime", "agent-browser");
const preparedBinary = join(preparedDir, genericName);

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
    console.log(`[agent-browser] Binario nativo preparado desde node_modules: ${preparedBinary}`);
  } else if (!existsSync(preparedBinary)) {
    await downloadNativeBinary(preparedBinary);
    console.log(`[agent-browser] Binario nativo descargado a: ${preparedBinary}`);
  } else {
    console.log(`[agent-browser] Reutilizando binario nativo preparado: ${preparedBinary}`);
  }

  if (process.platform !== "win32") {
    chmodSync(preparedBinary, 0o755);
  }
  return preparedBinary;
}

async function ensureBrowser(binary: string): Promise<void> {
  // agent-browser está probado contra su Chrome for Testing administrado. Lo
  // preferimos sobre Chrome/Edge/Brave del usuario para que desarrollo y el
  // binario compilado utilicen el mismo runtime predecible.
  const managedBrowser = resolveManagedAgentBrowserChrome();
  if (managedBrowser) {
    console.log(`[agent-browser] Chrome for Testing reutilizado: ${managedBrowser}`);
    return;
  }

  const systemBrowser = resolveSystemBrowserExecutable();
  if (process.env.LUNA_AGENT_BROWSER_USE_SYSTEM_BROWSER === "1" && systemBrowser) {
    console.log(`[agent-browser] LUNA_AGENT_BROWSER_USE_SYSTEM_BROWSER=1; usando navegador del sistema: ${systemBrowser}`);
    return;
  }

  if (process.env.LUNA_AGENT_BROWSER_SKIP_INSTALL === "1") {
    if (systemBrowser) {
      console.warn(`[agent-browser] Se omite Chrome for Testing por LUNA_AGENT_BROWSER_SKIP_INSTALL=1. Fallback disponible: ${systemBrowser}`);
      return;
    }
    console.warn("[agent-browser] No se detectó navegador administrado y LUNA_AGENT_BROWSER_SKIP_INSTALL=1. Se omite la instalación automática.");
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
console.log("[agent-browser] Runtime de navegación listo.");
