import { describe, expect, it } from "bun:test";
import { estimateOggDurationSeconds } from "../src/media-processing/audio-utils.ts";

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
