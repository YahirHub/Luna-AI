import { describe, expect, it } from "bun:test";
import { readImageDimensions } from "../src/media-processing/image-utils.ts";

describe("readImageDimensions", () => {
  it("lee dimensiones PNG desde IHDR sin descomprimir", () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 640, false);
    view.setUint32(20, 480, false);
    expect(readImageDimensions(bytes, "image/png")).toEqual({ width: 640, height: 480 });
  });

  it("lee dimensiones JPEG desde un marcador SOF", () => {
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0,
      0x00, 0x11,
      0x08,
      0x00, 0x10,
      0x00, 0x20,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    expect(readImageDimensions(bytes, "image/jpeg")).toEqual({ width: 32, height: 16 });
  });

  it("rechaza cabeceras inválidas o formatos desconocidos", () => {
    expect(readImageDimensions(new Uint8Array([1, 2, 3]), "image/png")).toBeNull();
    expect(readImageDimensions(new Uint8Array(24), "image/webp")).toBeNull();
  });
});
