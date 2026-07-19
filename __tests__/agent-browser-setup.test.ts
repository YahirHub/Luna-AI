import { describe, expect, it } from "bun:test";
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
});
