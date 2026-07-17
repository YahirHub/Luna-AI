import { describe, expect, it } from "bun:test";

describe("proceso multimedia compilado", () => {
  it("aísla multimedia invocando el mismo ejecutable por IPC", async () => {
    const source = await Bun.file(
      new URL("../src/media-processing/client.ts", import.meta.url),
    ).text();

    expect(source).toContain('[process.execPath, "--media-worker"]');
    expect(source).toContain("ipc: (message)");
    expect(source).not.toContain("new Worker(");
  });

  it("compila un único entrypoint y despacha el modo multimedia internamente", async () => {
    const packageJson = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json() as { scripts?: { build?: string } };
    const indexSource = await Bun.file(
      new URL("../src/index.ts", import.meta.url),
    ).text();

    expect(packageJson.scripts?.build).toContain("bun build ./src/index.ts --compile");
    expect(packageJson.scripts?.build).toContain("package:runtime");
    expect(indexSource).toContain('process.argv.includes("--media-worker")');
    expect(indexSource).toContain('import("./media-processing/worker.ts")');
  });

  it("usa el ejecutable oficial de whisper.cpp y elimina Whisper WASM", async () => {
    const workerSource = await Bun.file(
      new URL("../src/media-processing/worker.ts", import.meta.url),
    ).text();
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).text();
    const prepareSource = await Bun.file(
      new URL("../scripts/prepare-media-assets.ts", import.meta.url),
    ).text();

    expect(workerSource).toContain("transcribeWithWhisperCli");
    expect(workerSource).not.toContain("WhisperWasmService");
    expect(packageJson).not.toContain("@timur00kh/whisper.wasm");
    expect(prepareSource).toContain("/releases/latest");
    expect(prepareSource).toContain("whisper-bin-ubuntu-arm64.tar.gz");
    expect(prepareSource).toContain("whisper-bin-x64.zip");
    expect(prepareSource).toContain("asset.digest");
  });
});
