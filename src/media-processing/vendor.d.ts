declare module "tesseract-wasm" {
  export type OcrImageData = {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };

  export interface OCREngine {
    loadModel(model: Uint8Array | ArrayBuffer): void;
    loadImage(image: OcrImageData): void;
    clearImage(): void;
    getText(onProgress?: (progress: number) => void): string;
    setVariable(name: string, value: string): void;
    destroy(): void;
  }

  export function supportsFastBuild(): boolean;
  export function createOCREngine(options?: {
    wasmBinary?: Uint8Array | ArrayBuffer;
  }): Promise<OCREngine>;
}
