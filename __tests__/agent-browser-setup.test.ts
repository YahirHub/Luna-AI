import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentBrowserGenericName,
  agentBrowserNativeName,
  supportsManagedAgentBrowserChrome,
} from "../src/browser/browser-discovery.ts";

describe("preparación multiplataforma de agent-browser", () => {
  it("resuelve el binario nativo correcto para Windows x64", () => {
    expect(agentBrowserNativeName("win32", "x64", false)).toBe("agent-browser-win32-x64.exe");
    expect(agentBrowserGenericName("win32")).toBe("agent-browser.exe");
  });

  it("resuelve binarios glibc y musl de Linux x64 y ARM64", () => {
    expect(agentBrowserNativeName("linux", "x64", false)).toBe("agent-browser-linux-x64");
    expect(agentBrowserNativeName("linux", "arm64", false)).toBe("agent-browser-linux-arm64");
    expect(agentBrowserNativeName("linux", "x64", true)).toBe("agent-browser-linux-musl-x64");
    expect(agentBrowserNativeName("linux", "arm64", true)).toBe("agent-browser-linux-musl-arm64");
  });

  it("no intenta Chrome for Testing en Linux ARM64", () => {
    expect(supportsManagedAgentBrowserChrome("linux", "arm64")).toBe(false);
    expect(supportsManagedAgentBrowserChrome("linux", "x64")).toBe(true);
    expect(supportsManagedAgentBrowserChrome("darwin", "arm64")).toBe(true);
    expect(supportsManagedAgentBrowserChrome("win32", "x64")).toBe(true);
  });

  it("rechaza plataformas sin binario nativo publicado", () => {
    expect(() => agentBrowserNativeName("win32", "arm64", false)).toThrow();
  });

  it("prepara Chromium del sistema en el runner Linux ARM64 antes de bun install", () => {
    const root = join(import.meta.dir, "..");
    const workflow = readFileSync(join(root, ".github/workflows/build-release.yml"), "utf8");
    expect(workflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(workflow).toContain("Instalar Chromium ARM64 del sistema");
    expect(workflow).toContain("sudo snap install chromium");
    expect(workflow).toContain("AGENT_BROWSER_EXECUTABLE_PATH=$CHROMIUM_PATH");
    expect(workflow.indexOf("Instalar Chromium ARM64 del sistema")).toBeLessThan(
      workflow.indexOf("bun install", workflow.indexOf("build-linux-arm64:")),
    );
  });
});
