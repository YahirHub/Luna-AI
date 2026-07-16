import { describe, it, expect } from "bun:test";
import { isAllowedImageMime, isWithinSizeLimit } from "../src/media.ts";

describe("isAllowedImageMime", () => {
  it("accepts image/jpeg", () => {
    expect(isAllowedImageMime("image/jpeg")).toBe(true);
  });

  it("accepts image/png", () => {
    expect(isAllowedImageMime("image/png")).toBe(true);
  });

  it("accepts image/webp", () => {
    expect(isAllowedImageMime("image/webp")).toBe(true);
  });

  it("accepts image/gif", () => {
    expect(isAllowedImageMime("image/gif")).toBe(true);
  });

  it("rejects application/pdf", () => {
    expect(isAllowedImageMime("application/pdf")).toBe(false);
  });

  it("rejects video/mp4", () => {
    expect(isAllowedImageMime("video/mp4")).toBe(false);
  });

  it("rejects text/plain", () => {
    expect(isAllowedImageMime("text/plain")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isAllowedImageMime("")).toBe(false);
  });

  it("rejects unknown image subtype", () => {
    expect(isAllowedImageMime("image/bmp")).toBe(false);
  });
});

describe("isWithinSizeLimit", () => {
  it("accepts file exactly at limit (10 MB)", () => {
    expect(isWithinSizeLimit(10 * 1024 * 1024)).toBe(true);
  });

  it("accepts small file (1 KB)", () => {
    expect(isWithinSizeLimit(1024)).toBe(true);
  });

  it("accepts zero bytes", () => {
    expect(isWithinSizeLimit(0)).toBe(true);
  });

  it("rejects file over limit (10 MB + 1 byte)", () => {
    expect(isWithinSizeLimit(10 * 1024 * 1024 + 1)).toBe(false);
  });

  it("rejects very large file (100 MB)", () => {
    expect(isWithinSizeLimit(100 * 1024 * 1024)).toBe(false);
  });

  it("handles typical image sizes", () => {
    // 500 KB JPEG
    expect(isWithinSizeLimit(500 * 1024)).toBe(true);
    // 5 MB PNG
    expect(isWithinSizeLimit(5 * 1024 * 1024)).toBe(true);
    // 15 MB TIFF-like (rejected since over 10 MB)
    expect(isWithinSizeLimit(15 * 1024 * 1024)).toBe(false);
  });
});
