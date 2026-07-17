import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
});
