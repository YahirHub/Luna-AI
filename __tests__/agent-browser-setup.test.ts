import { describe, expect, it } from "bun:test";
import {
  agentBrowserGenericName,
  agentBrowserNativeName,
} from "../src/browser/browser-discovery.ts";

describe("preparación multiplataforma de agent-browser", () => {
  it("resuelve el binario nativo correcto para Windows x64", () => {
    expect(agentBrowserNativeName("win32", "x64", false)).toBe("agent-browser-win32-x64.exe");
    expect(agentBrowserGenericName("win32")).toBe("agent-browser.exe");
  });

  it("resuelve binarios glibc y musl de Linux", () => {
    expect(agentBrowserNativeName("linux", "x64", false)).toBe("agent-browser-linux-x64");
    expect(agentBrowserNativeName("linux", "x64", true)).toBe("agent-browser-linux-musl-x64");
    expect(agentBrowserNativeName("linux", "arm64", true)).toBe("agent-browser-linux-musl-arm64");
  });
});
