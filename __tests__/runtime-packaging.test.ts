import { describe, expect, it } from "bun:test";

describe("empaquetado del runtime multimedia", () => {
  it("copia whisper.cpp junto al ejecutable compilado", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
      scripts: Record<string, string>;
    };
    const source = await Bun.file(new URL("../scripts/package-runtime.ts", import.meta.url)).text();
    const linuxRuntimeSource = await Bun.file(
      new URL("../scripts/whisper-linux-libs.ts", import.meta.url),
    ).text();

    expect(packageJson.scripts.build).toContain("package:runtime");
    expect(source).toContain('"dist", "runtime", "whisper"');
    expect(source).toContain('"dist", "runtime", "twemoji"');
    expect(source).toContain("Assets Twemoji copiados");
    expect(source).toContain("manifest.json");
    expect(source).toContain("ensureLinuxSharedLibraryAliases");
    expect(source).toContain("ensureLinuxRuntimeDependencies");
    expect(linuxRuntimeSource).toContain("libgomp.so.1");
    expect(linuxRuntimeSource).toContain("deb.debian.org");
    expect(linuxRuntimeSource).toContain("DEBIAN_LIBGOMP_PACKAGES");
  });
});
