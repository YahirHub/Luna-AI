declare module "@twemoji/parser" {
  export interface EmojiEntity {
    type: "emoji";
    text: string;
    url: string;
    indices: [number, number];
  }

  export type AssetType = "png" | "svg";

  export interface ParsingOptions {
    buildUrl?: (codepoints: string, assetType: AssetType) => string;
    assetType?: AssetType;
  }

  export function parse(text: string, options?: ParsingOptions): EmojiEntity[];
  export function toCodePoints(unicodeSurrogates: string): string[];
}
