import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFfmpegRuntime } from "../src/media-processing/ffmpeg-native.ts";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("runtime nativo de FFmpeg", () => {
  it("carga únicamente un runtime de la plataforma y arquitectura actuales", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-ffmpeg-runtime-"));
    temporaryDirs.push(root);
    const executableName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    writeFileSync(join(root, executableName), "test");
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      version: "b6.1.1",
      platform: process.platform,
      arch: process.arch,
      assetName: `ffmpeg-${process.platform}-${process.arch}.gz`,
      assetDigest: "a".repeat(64),
      executable: executableName,
      preparedAt: new Date(0).toISOString(),
    }));

    const runtime = loadFfmpegRuntime([root]);
    expect(runtime.root).toBe(root);
    expect(runtime.executable).toBe(join(root, executableName));
  });

  it("rechaza manifiestos de otra arquitectura", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-ffmpeg-wrong-arch-"));
    temporaryDirs.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "ffmpeg"), "test");
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      version: "b6.1.1",
      platform: process.platform,
      arch: process.arch === "x64" ? "arm64" : "x64",
      assetName: "ffmpeg-linux-x64.gz",
      assetDigest: "a".repeat(64),
      executable: "ffmpeg",
      preparedAt: new Date(0).toISOString(),
    }));

    expect(() => loadFfmpegRuntime([root])).toThrow("No se encontró el runtime de FFmpeg");
  });
});
