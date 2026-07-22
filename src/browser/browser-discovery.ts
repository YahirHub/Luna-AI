import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function isMuslLinux(): boolean {
  if (process.platform !== "linux") return false;
  return existsSync("/etc/alpine-release")
    || existsSync("/lib/ld-musl-x86_64.so.1")
    || existsSync("/lib/ld-musl-aarch64.so.1");
}

export function supportsManagedAgentBrowserChrome(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  // Chrome for Testing publica Linux únicamente para x64. En ARM64 Linux el
  // binario nativo de agent-browser sí existe, pero el navegador debe venir del
  // sistema (Chromium/Chrome compatible). macOS sí dispone de CfT ARM64.
  if (platform === "linux") return arch === "x64";
  if (platform === "win32") return arch === "x64";
  if (platform === "darwin") return arch === "x64" || arch === "arm64";
  return false;
}

export function agentBrowserNativeName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = platform === "linux" && isMuslLinux(),
): string {
  const supported = (
    (platform === "win32" && arch === "x64")
    || (platform === "darwin" && (arch === "x64" || arch === "arm64"))
    || (platform === "linux" && (arch === "x64" || arch === "arm64"))
  );
  if (!supported) {
    throw new Error(`agent-browser no publica un binario nativo compatible con ${platform}/${arch}.`);
  }

  const osKey = platform === "linux" && musl ? "linux-musl" : platform;
  const ext = platform === "win32" ? ".exe" : "";
  return `agent-browser-${osKey}-${arch}${ext}`;
}

export function agentBrowserGenericName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "agent-browser.exe" : "agent-browser";
}

function findOnPath(names: string[]): string | undefined {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      if (process.platform === "win32") {
        const hasExtension = /\.[a-z0-9]+$/i.test(name);
        const candidates = hasExtension ? [name] : extensions.map((extension) => `${name}${extension.toLowerCase()}`);
        for (const candidateName of candidates) {
          const candidate = join(directory, candidateName);
          if (existsSync(candidate)) return candidate;
        }
      } else {
        const candidate = join(directory, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

export function resolveSystemBrowserExecutable(): string | undefined {
  const explicit = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const candidates = [
      local && join(local, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      local && join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      local && join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    ].filter(Boolean) as string[];
    return candidates.find((candidate) => existsSync(candidate));
  }

  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  if (process.platform === "linux") {
    // Ubuntu distribuye Chromium como Snap. /snap/bin no siempre forma parte de
    // PATH en servicios systemd, CI o shells no interactivos, así que revisamos
    // rutas conocidas antes de buscar por nombre.
    const fixedCandidates = [
      "/snap/bin/chromium",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ];
    const fixed = fixedCandidates.find((candidate) => existsSync(candidate));
    if (fixed) return fixed;

    return findOnPath([
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "brave-browser",
      "brave",
      "microsoft-edge",
      "microsoft-edge-stable",
    ]);
  }
  return undefined;
}

function findExecutableRecursively(root: string, maxDepth: number): string | undefined {
  if (!existsSync(root) || maxDepth < 0) return undefined;
  const entries = (() => {
    try {
      return readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && ["chrome.exe", "chrome", "chromium", "chromium-browser"].includes(entry.name.toLowerCase())) {
      return path;
    }
  }
  if (maxDepth === 0) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findExecutableRecursively(join(root, entry.name), maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

export function resolveManagedAgentBrowserChrome(): string | undefined {
  if (!supportsManagedAgentBrowserChrome()) return undefined;
  const root = join(homedir(), ".agent-browser", "browsers");
  if (!existsSync(root)) return undefined;
  let directories: string[] = [];
  try {
    directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chrome-"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return undefined;
  }
  for (const directory of directories) {
    const executable = findExecutableRecursively(join(root, directory), 3);
    if (executable) return executable;
  }
  return undefined;
}
