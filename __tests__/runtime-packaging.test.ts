import { describe, expect, it } from "bun:test";

describe("empaquetado del runtime multimedia", () => {
  it("copia whisper.cpp junto al ejecutable compilado", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
      scripts: Record<string, string>;
      trustedDependencies?: string[];
    };
    const source = await Bun.file(new URL("../scripts/package-runtime.ts", import.meta.url)).text();
    const linuxRuntimeSource = await Bun.file(
      new URL("../scripts/whisper-linux-libs.ts", import.meta.url),
    ).text();
    const browserPrepareSource = await Bun.file(
      new URL("../scripts/prepare-agent-browser.ts", import.meta.url),
    ).text();
    const browserRuntimeSource = await Bun.file(
      new URL("../src/browser/browser-runtime.ts", import.meta.url),
    ).text();

    expect(packageJson.scripts.build).toContain("prepare:browser");
    expect(packageJson.scripts.build).toContain("package:runtime");
    expect(packageJson.scripts.dev).toContain("prepare:browser");
    expect(packageJson.scripts.start).toContain("prepare:browser");
    expect(packageJson.scripts.postinstall).toContain("prepare:browser");
    expect(packageJson.trustedDependencies).toContain("agent-browser");
    expect(source).toContain('"dist", "runtime", "whisper"');
    expect(source).toContain('"dist", "runtime", "twemoji"');
    expect(source).toContain("Assets Twemoji copiados");
    expect(source).toContain("agent-browser nativo copiado");
    expect(source).toContain('"assets", "runtime", "agent-browser"');
    expect(source).toContain('"node_modules", "agent-browser", "bin"');
    expect(browserPrepareSource).toContain("agent-browser install");
    expect(browserPrepareSource).toContain("postinstall oficial");
    expect(browserPrepareSource).toContain("releases/download");
    expect(browserPrepareSource).toContain("Chrome for Testing reutilizado");
    expect(browserPrepareSource).toContain("LUNA_AGENT_BROWSER_USE_SYSTEM_BROWSER");
    expect(browserRuntimeSource).toContain('"assets", "runtime", "agent-browser"');
    expect(browserRuntimeSource).toContain("AGENT_BROWSER_EXECUTABLE_PATH");
    expect(browserRuntimeSource).toContain("resolveManagedAgentBrowserChrome");
    expect(browserRuntimeSource).toContain("BrowserCommandTimeoutError");
    expect(browserRuntimeSource).toContain("command_timeout");
    expect(browserRuntimeSource).toContain("openWithRecovery");
    expect(browserRuntimeSource).toContain("session_rotated");
    expect(source).toContain("manifest.json");
    expect(source).toContain("ensureLinuxSharedLibraryAliases");
    expect(source).toContain("ensureLinuxRuntimeDependencies");
    expect(linuxRuntimeSource).toContain("libgomp.so.1");
    expect(linuxRuntimeSource).toContain("deb.debian.org");
    expect(linuxRuntimeSource).toContain("DEBIAN_LIBGOMP_PACKAGES");
  });
});
