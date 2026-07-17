import { describe, expect, it } from "bun:test";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  buildAudioContextText,
  buildImageContextText,
  getMediaCaption,
  getMediaKind,
  isAllowedAudioMime,
  isAllowedImageMime,
  isWithinSizeLimit,
} from "../src/media.ts";

describe("formatos multimedia", () => {
  it("acepta JPEG y PNG para OCR", () => {
    expect(isAllowedImageMime("image/jpeg")).toBe(true);
    expect(isAllowedImageMime("IMAGE/PNG")).toBe(true);
  });

  it("rechaza formatos que los decodificadores embebidos no procesan", () => {
    expect(isAllowedImageMime("image/webp")).toBe(false);
    expect(isAllowedImageMime("image/gif")).toBe(false);
    expect(isAllowedImageMime("application/pdf")).toBe(false);
  });

  it("acepta notas OGG/Opus con parámetros MIME", () => {
    expect(isAllowedAudioMime("audio/ogg; codecs=opus")).toBe(true);
    expect(isAllowedAudioMime("audio/opus")).toBe(true);
    expect(isAllowedAudioMime("audio/mpeg")).toBe(false);
  });
});

describe("límites", () => {
  it("acepta el tamaño exacto y rechaza un byte adicional", () => {
    const limit = 12 * 1024 * 1024;
    expect(isWithinSizeLimit(limit, limit)).toBe(true);
    expect(isWithinSizeLimit(limit + 1, limit)).toBe(false);
  });

  it("rechaza números negativos y no finitos", () => {
    expect(isWithinSizeLimit(-1)).toBe(false);
    expect(isWithinSizeLimit(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("detección y contexto", () => {
  it("detecta imagen, audio y pie de imagen", () => {
    const image = {
      message: { imageMessage: { caption: "  revisa esta factura  " } },
    } as unknown as WAMessage;
    const audio = { message: { audioMessage: {} } } as unknown as WAMessage;

    expect(getMediaKind(image)).toBe("image");
    expect(getMediaCaption(image)).toBe("revisa esta factura");
    expect(getMediaKind(audio)).toBe("audio");
  });

  it("marca la transcripción como entrada local", () => {
    expect(buildAudioContextText("  comprar leche  ")).toBe(
      "[Transcripción de audio generada por el sistema]\ncomprar leche",
    );
  });

  it("coloca primero la intención del usuario y después el OCR", () => {
    expect(buildImageContextText("Total: $120", "¿cuándo vence?")).toBe(
      "[Mensaje del usuario adjunto a la imagen]\n¿cuándo vence?\n\n" +
        "[Texto extraído de la imagen por el sistema]\nTotal: $120",
    );
  });

  it("marca explícitamente cuando el OCR no produjo contenido", () => {
    expect(buildImageContextText("", "describe el problema")).toBe(
      "[Mensaje del usuario adjunto a la imagen]\ndescribe el problema\n\n" +
        "[La extracción de texto de la imagen no produjo contenido legible]",
    );
  });
});
