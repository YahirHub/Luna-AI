import { describe, expect, it } from "bun:test";
import { downsampleTo16k, estimateOggDurationSeconds, mixToMono } from "../src/media-processing/audio-utils.ts";

describe("mixToMono", () => {
  it("promedia canales sin modificar el canal original", () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([-1, 1, 1]);
    expect(Array.from(mixToMono([left, right]))).toEqual([0, 0.5, 0]);
  });

  it("usa la longitud del canal más corto", () => {
    expect(Array.from(mixToMono([
      new Float32Array([1, 2, 3]),
      new Float32Array([1, 2]),
    ]))).toEqual([1, 2]);
  });
});

describe("downsampleTo16k", () => {
  it("reduce 48 kHz a 16 kHz promediando cada bloque", () => {
    const input = new Float32Array([1, 2, 3, 4, 5, 6]);
    expect(Array.from(downsampleTo16k(input, 48_000))).toEqual([2, 5]);
  });

  it("no copia audio que ya está a 16 kHz", () => {
    const input = new Float32Array([0.25, -0.25]);
    expect(downsampleTo16k(input, 16_000)).toBe(input);
  });

  it("rechaza frecuencias que no pueden reducirse exactamente", () => {
    expect(() => downsampleTo16k(new Float32Array([1]), 44_100)).toThrow(
      "Frecuencia de audio no compatible",
    );
  });
});


describe("estimateOggDurationSeconds", () => {
  it("lee la posición granular final sin decodificar", () => {
    const bytes = new Uint8Array(28);
    bytes.set([0x4f, 0x67, 0x67, 0x53], 0);
    const granule = 96_000n;
    for (let i = 0; i < 8; i += 1) bytes[6 + i] = Number((granule >> BigInt(i * 8)) & 0xffn);
    bytes[26] = 1;
    bytes[27] = 0;
    expect(estimateOggDurationSeconds(bytes)).toBe(2);
  });

  it("rechaza una estructura Ogg incompleta", () => {
    expect(estimateOggDurationSeconds(new Uint8Array([0x4f, 0x67]))).toBeNull();
  });
});
