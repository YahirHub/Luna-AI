import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLinuxRuntimeDependencies,
  ensureLinuxSharedLibraryAliases,
  linuxSharedLibraryAliases,
} from "../scripts/whisper-linux-libs.ts";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime Linux de whisper.cpp", () => {
  it("calcula los aliases SONAME de una biblioteca versionada", () => {
    expect(linuxSharedLibraryAliases("libwhisper.so.1.9.1")).toEqual([
      "libwhisper.so",
      "libwhisper.so.1",
    ]);
    expect(linuxSharedLibraryAliases("libggml.so.0")).toEqual(["libggml.so"]);
    expect(linuxSharedLibraryAliases("whisper-cli")).toEqual([]);
  });

  it("crea copias portables para los aliases que pueden perderse al empaquetar", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-whisper-linux-"));
    temporaryDirs.push(root);
    const versioned = join(root, "libwhisper.so.1.9.1");
    writeFileSync(versioned, "whisper-library");
    // Simula un extractor que convirtió el symlink en un archivo de texto.
    writeFileSync(join(root, "libwhisper.so.1"), "libwhisper.so.1.9.1");

    const created = ensureLinuxSharedLibraryAliases(root, "linux");

    expect(created).toContain(join(root, "libwhisper.so"));
    expect(created).toContain(join(root, "libwhisper.so.1"));
    expect(existsSync(join(root, "libwhisper.so"))).toBe(true);
    expect(existsSync(join(root, "libwhisper.so.1"))).toBe(true);
    expect(readFileSync(join(root, "libwhisper.so.1"), "utf8")).toBe("whisper-library");
  });
  it("incluye libgomp.so.1 dentro del runtime distribuible", async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-whisper-libgomp-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "luna-system-libgomp-"));
    temporaryDirs.push(root, sourceRoot);
    const source = join(sourceRoot, "libgomp.so.1.0.0");
    writeFileSync(source, "openmp-runtime");

    const copied = await ensureLinuxRuntimeDependencies(root, "linux", {
      candidates: { "libgomp.so.1": [source] },
      environment: {},
    });

    const destination = join(root, "system-libs", "libgomp.so.1");
    expect(copied).toEqual([destination]);
    expect(readFileSync(destination, "utf8")).toBe("openmp-runtime");
    expect(await ensureLinuxRuntimeDependencies(root, "linux", {
      candidates: { "libgomp.so.1": [source] },
      environment: {},
    })).toEqual([]);
  });

  it("descarga libgomp1 como respaldo cuando no está instalada", async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-whisper-libgomp-download-"));
    temporaryDirs.push(root);

    const copied = await ensureLinuxRuntimeDependencies(root, "linux", {
      environment: {},
      searchSystem: false,
      async packageDownloader(filename, destinationDirectory) {
        mkdirSync(destinationDirectory, { recursive: true });
        const destination = join(destinationDirectory, filename);
        writeFileSync(destination, "openmp-from-debian-package");
        return destination;
      },
    });

    const destination = join(root, "system-libs", "libgomp.so.1");
    expect(copied).toEqual([destination]);
    expect(readFileSync(destination, "utf8")).toBe("openmp-from-debian-package");
  });

});
