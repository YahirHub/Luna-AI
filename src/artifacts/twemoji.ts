import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseTwemoji } from "@twemoji/parser";

export type EmojiInlineRun =
  | { kind: "text"; text: string }
  | { kind: "emoji"; text: string; codepoint: string };

interface Point {
  x: number;
  y: number;
}

interface CubicSegment {
  c1: Point;
  c2: Point;
  end: Point;
}

const svgCommandCache = new Map<string, string | null>();

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Number(value.toFixed(5));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function emojiAssetCandidates(codepoint: string): string[] {
  const filename = `${codepoint}.svg`;
  const executableDir = dirname(process.execPath);
  return [
    join(process.cwd(), "assets", "twemoji", filename),
    join(process.cwd(), "runtime", "twemoji", filename),
    join(process.cwd(), "dist", "runtime", "twemoji", filename),
    join(executableDir, "runtime", "twemoji", filename),
  ];
}

function loadEmojiSvg(codepoint: string): string | null {
  for (const candidate of emojiAssetCandidates(codepoint)) {
    if (!existsSync(candidate)) continue;
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // Probar la siguiente ubicación disponible.
    }
  }
  return null;
}

function codepointFromUrl(url: string): string | null {
  const match = url.match(/\/([0-9a-f-]+)\.svg(?:[?#].*)?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function parseEmojiRuns(value: string): EmojiInlineRun[] {
  const entities = parseTwemoji(value, { assetType: "svg" });
  if (!entities.length) return [{ kind: "text", text: value }];

  const runs: EmojiInlineRun[] = [];
  let cursor = 0;
  for (const entity of entities) {
    const [start, end] = entity.indices;
    if (start > cursor) runs.push({ kind: "text", text: value.slice(cursor, start) });
    const codepoint = codepointFromUrl(entity.url);
    if (codepoint) {
      runs.push({ kind: "emoji", text: entity.text, codepoint });
    } else {
      runs.push({ kind: "text", text: entity.text });
    }
    cursor = end;
  }
  if (cursor < value.length) runs.push({ kind: "text", text: value.slice(cursor) });
  return runs;
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    if (match[1]) attributes[match[1]] = match[2] ?? "";
  }
  return attributes;
}

function colorToRgb(fill: string | undefined): [number, number, number] | null {
  const value = (fill ?? "#000").trim().toLowerCase();
  if (value === "none") return null;
  const named: Record<string, string> = {
    red: "#ff0000",
    green: "#008000",
    navy: "#000080",
    azure: "#007fff",
    black: "#000000",
    white: "#ffffff",
  };
  const normalized = named[value] ?? value;
  const short = normalized.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) {
    return [
      parseInt(`${short[1]}${short[1]}`, 16) / 255,
      parseInt(`${short[2]}${short[2]}`, 16) / 255,
      parseInt(`${short[3]}${short[3]}`, 16) / 255,
    ];
  }
  const full = normalized.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!full) return [0, 0, 0];
  return [parseInt(full[1]!, 16) / 255, parseInt(full[2]!, 16) / 255, parseInt(full[3]!, 16) / 255];
}

function transformCommands(transform: string | undefined): string[] {
  if (!transform) return [];
  const output: string[] = [];
  for (const match of transform.matchAll(/(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g)) {
    const operation = match[1];
    const values = (match[2] ?? "")
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (values.some((value) => !Number.isFinite(value))) continue;

    if (operation === "matrix" && values.length >= 6) {
      output.push(`${values.slice(0, 6).map(formatNumber).join(" ")} cm`);
      continue;
    }
    if (operation === "translate" && values.length >= 1) {
      const tx = values[0] ?? 0;
      const ty = values[1] ?? 0;
      output.push(`1 0 0 1 ${formatNumber(tx)} ${formatNumber(ty)} cm`);
      continue;
    }
    if (operation === "scale" && values.length >= 1) {
      const sx = values[0] ?? 1;
      const sy = values[1] ?? sx;
      output.push(`${formatNumber(sx)} 0 0 ${formatNumber(sy)} 0 0 cm`);
      continue;
    }
    if (operation === "rotate" && values.length >= 1) {
      const angle = ((values[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const cx = values[1] ?? 0;
      const cy = values[2] ?? 0;
      const e = cx - cos * cx + sin * cy;
      const f = cy - sin * cx - cos * cy;
      output.push(
        `${formatNumber(cos)} ${formatNumber(sin)} ${formatNumber(-sin)} ${formatNumber(cos)} ${formatNumber(e)} ${formatNumber(f)} cm`,
      );
    }
  }
  return output;
}

function tokenizePath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const regex = /([a-zA-Z])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  for (const match of path.matchAll(regex)) {
    if (match[1]) tokens.push(match[1]);
    else if (match[2]) tokens.push(Number(match[2]));
  }
  return tokens;
}

function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const length = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  if (!length) return 0;
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  const ratio = Math.max(-1, Math.min(1, dot / length));
  return sign * Math.acos(ratio);
}

function arcToCubics(
  start: Point,
  rxValue: number,
  ryValue: number,
  rotationDegrees: number,
  largeArcFlag: number,
  sweepFlag: number,
  end: Point,
): CubicSegment[] {
  let rx = Math.abs(rxValue);
  let ry = Math.abs(ryValue);
  if (!rx || !ry || (start.x === end.x && start.y === end.y)) return [];

  const phi = (rotationDegrees * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const xPrime = cosPhi * dx + sinPhi * dy;
  const yPrime = -sinPhi * dx + cosPhi * dy;

  const lambda = xPrime * xPrime / (rx * rx) + yPrime * yPrime / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const xp2 = xPrime * xPrime;
  const yp2 = yPrime * yPrime;
  const denominator = rx2 * yp2 + ry2 * xp2;
  const numerator = Math.max(0, rx2 * ry2 - denominator);
  const sign = largeArcFlag === sweepFlag ? -1 : 1;
  const coefficient = denominator === 0 ? 0 : sign * Math.sqrt(numerator / denominator);
  const cxPrime = coefficient * ((rx * yPrime) / ry);
  const cyPrime = coefficient * (-(ry * xPrime) / rx);
  const cx = cosPhi * cxPrime - sinPhi * cyPrime + (start.x + end.x) / 2;
  const cy = sinPhi * cxPrime + cosPhi * cyPrime + (start.y + end.y) / 2;

  const ux = (xPrime - cxPrime) / rx;
  const uy = (yPrime - cyPrime) / ry;
  const vx = (-xPrime - cxPrime) / rx;
  const vy = (-yPrime - cyPrime) / ry;
  let startAngle = angleBetween(1, 0, ux, uy);
  let deltaAngle = angleBetween(ux, uy, vx, vy);
  if (!sweepFlag && deltaAngle > 0) deltaAngle -= Math.PI * 2;
  if (sweepFlag && deltaAngle < 0) deltaAngle += Math.PI * 2;

  const segmentCount = Math.max(1, Math.ceil(Math.abs(deltaAngle) / (Math.PI / 2)));
  const segmentAngle = deltaAngle / segmentCount;
  const segments: CubicSegment[] = [];

  const transform = (unitX: number, unitY: number): Point => ({
    x: cx + cosPhi * rx * unitX - sinPhi * ry * unitY,
    y: cy + sinPhi * rx * unitX + cosPhi * ry * unitY,
  });

  for (let index = 0; index < segmentCount; index++) {
    const endAngle = startAngle + segmentAngle;
    const alpha = (4 / 3) * Math.tan((endAngle - startAngle) / 4);
    const cosStart = Math.cos(startAngle);
    const sinStart = Math.sin(startAngle);
    const cosEnd = Math.cos(endAngle);
    const sinEnd = Math.sin(endAngle);
    segments.push({
      c1: transform(cosStart - alpha * sinStart, sinStart + alpha * cosStart),
      c2: transform(cosEnd + alpha * sinEnd, sinEnd - alpha * cosEnd),
      end: transform(cosEnd, sinEnd),
    });
    startAngle = endAngle;
  }
  return segments;
}

function pathToPdf(path: string): string[] {
  const tokens = tokenizePath(path);
  const output: string[] = [];
  let index = 0;
  let command = "";
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  let previousCubicControl: Point | null = null;
  let previousQuadraticControl: Point | null = null;

  const hasNumber = (): boolean => typeof tokens[index] === "number";
  const readNumber = (): number => {
    const value = tokens[index];
    index += 1;
    return typeof value === "number" ? value : 0;
  };
  const resetControls = (): void => {
    previousCubicControl = null;
    previousQuadraticControl = null;
  };

  while (index < tokens.length) {
    if (typeof tokens[index] === "string") {
      command = String(tokens[index]);
      index += 1;
    }
    if (!command) break;

    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    if (upper === "Z") {
      output.push("h");
      current = { ...subpathStart };
      resetControls();
      command = "";
      continue;
    }
    if (!hasNumber()) {
      command = "";
      continue;
    }

    if (upper === "M") {
      let first = true;
      while (hasNumber()) {
        const rawX = readNumber();
        const rawY = readNumber();
        const point = {
          x: relative ? current.x + rawX : rawX,
          y: relative ? current.y + rawY : rawY,
        };
        if (first) {
          output.push(`${formatNumber(point.x)} ${formatNumber(point.y)} m`);
          subpathStart = { ...point };
          first = false;
        } else {
          output.push(`${formatNumber(point.x)} ${formatNumber(point.y)} l`);
        }
        current = point;
        resetControls();
        if (typeof tokens[index] === "string") break;
      }
      command = relative ? "l" : "L";
      continue;
    }

    if (upper === "L") {
      while (hasNumber()) {
        const rawX = readNumber();
        const rawY = readNumber();
        current = {
          x: relative ? current.x + rawX : rawX,
          y: relative ? current.y + rawY : rawY,
        };
        output.push(`${formatNumber(current.x)} ${formatNumber(current.y)} l`);
        resetControls();
        if (typeof tokens[index] === "string") break;
      }
      continue;
    }

    if (upper === "H") {
      while (hasNumber()) {
        const rawX = readNumber();
        current = { x: relative ? current.x + rawX : rawX, y: current.y };
        output.push(`${formatNumber(current.x)} ${formatNumber(current.y)} l`);
        resetControls();
        if (typeof tokens[index] === "string") break;
      }
      continue;
    }

    if (upper === "V") {
      while (hasNumber()) {
        const rawY = readNumber();
        current = { x: current.x, y: relative ? current.y + rawY : rawY };
        output.push(`${formatNumber(current.x)} ${formatNumber(current.y)} l`);
        resetControls();
        if (typeof tokens[index] === "string") break;
      }
      continue;
    }

    if (upper === "C") {
      while (hasNumber()) {
        const values = Array.from({ length: 6 }, () => readNumber());
        const c1 = { x: relative ? current.x + values[0]! : values[0]!, y: relative ? current.y + values[1]! : values[1]! };
        const c2 = { x: relative ? current.x + values[2]! : values[2]!, y: relative ? current.y + values[3]! : values[3]! };
        const end = { x: relative ? current.x + values[4]! : values[4]!, y: relative ? current.y + values[5]! : values[5]! };
        output.push(`${formatNumber(c1.x)} ${formatNumber(c1.y)} ${formatNumber(c2.x)} ${formatNumber(c2.y)} ${formatNumber(end.x)} ${formatNumber(end.y)} c`);
        current = end;
        previousCubicControl = c2;
        previousQuadraticControl = null;
        if (typeof tokens[index] === "string") break;
      }
      continue;
    }

    if (upper === "S") {
      while (hasNumber()) {
        const values = Array.from({ length: 4 }, () => readNumber());
        const reflected = previousCubicControl
          ? { x: current.x * 2 - previousCubicControl.x, y: current.y * 2 - previousCubicControl.y }
          : { ...current };
        const c2 = { x: relative ? current.x + values[0]! : values[0]!, y: relative ? current.y + values[1]! : values[1]! };
        const end = { x: relative ? current.x + values[2]! : values[2]!, y: relative ? current.y + values[3]! : values[3]! };
        output.push(`${formatNumber(reflected.x)} ${formatNumber(reflected.y)} ${formatNumber(c2.x)} ${formatNumber(c2.y)} ${formatNumber(end.x)} ${formatNumber(end.y)} c`);
        current = end;
        previousCubicControl = c2;
        previousQuadraticControl = null;
        if (typeof tokens[index] === "string") break;
      }
      continue;
    }

    if (upper === "Q") {
      while (hasNumber()) {
        const values = Array.from({ length: 4 }, () => readNumber());
        const control = { x: relative ? current.x + values[0]! : values[0]!, y: relative ? current.y + values[1]! : values[1]! };
        const end = { x: relative ? current.x + values[2]! : values[2]!, y: relative ? current.y + values[3]! : values[3]! };
        const c1 = { x: current.x + (2 / 3) * (control.x - current.x), y: current.y + (2 / 3) * (control.y - current.y) };
        const c2 = { x: end.x + (2 / 3) * (control.x - end.x), y: end.y + (2 / 3) * (control.y - end.y) };
        output.push(`${formatNumber(c1.x)} ${formatNumber(c1.y)} ${formatNumber(c2.x)} ${formatNumber(c2.y)} ${formatNumber(end.x)} ${formatNumber(end.y)} c`);
        current = end;
        previousQuadraticControl = control;
        previousCubicControl = null;
        if (typeof tokens[index] === "string") break;
      }
      continue;
    }

    if (upper === "T") {
      while (hasNumber()) {
        const rawX = readNumber();
        const rawY = readNumber();
        const control = previousQuadraticControl
          ? { x: current.x * 2 - previousQuadraticControl.x, y: current.y * 2 - previousQuadraticControl.y }
          : { ...current };
        const end = { x: relative ? current.x + rawX : rawX, y: relative ? current.y + rawY : rawY };
        const c1 = { x: current.x + (2 / 3) * (control.x - current.x), y: current.y + (2 / 3) * (control.y - current.y) };
        const c2 = { x: end.x + (2 / 3) * (control.x - end.x), y: end.y + (2 / 3) * (control.y - end.y) };
        output.push(`${formatNumber(c1.x)} ${formatNumber(c1.y)} ${formatNumber(c2.x)} ${formatNumber(c2.y)} ${formatNumber(end.x)} ${formatNumber(end.y)} c`);
        current = end;
        previousQuadraticControl = control;
        previousCubicControl = null;
        if (typeof tokens[index] === "string") break;
      }
      continue;
    }

    if (upper === "A") {
      while (hasNumber()) {
        const rx = readNumber();
        const ry = readNumber();
        const rotation = readNumber();
        const largeArc = readNumber();
        const sweep = readNumber();
        const rawX = readNumber();
        const rawY = readNumber();
        const end = { x: relative ? current.x + rawX : rawX, y: relative ? current.y + rawY : rawY };
        const segments = arcToCubics(current, rx, ry, rotation, largeArc, sweep, end);
        if (!segments.length) {
          output.push(`${formatNumber(end.x)} ${formatNumber(end.y)} l`);
        } else {
          for (const segment of segments) {
            output.push(`${formatNumber(segment.c1.x)} ${formatNumber(segment.c1.y)} ${formatNumber(segment.c2.x)} ${formatNumber(segment.c2.y)} ${formatNumber(segment.end.x)} ${formatNumber(segment.end.y)} c`);
          }
        }
        current = end;
        resetControls();
        if (typeof tokens[index] === "string") break;
      }
      continue;
    }

    // Comando desconocido: evitar bucles infinitos.
    index += 1;
    resetControls();
  }

  return output;
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string[] {
  const k = 0.5522847498307936;
  return [
    `${formatNumber(cx + rx)} ${formatNumber(cy)} m`,
    `${formatNumber(cx + rx)} ${formatNumber(cy + k * ry)} ${formatNumber(cx + k * rx)} ${formatNumber(cy + ry)} ${formatNumber(cx)} ${formatNumber(cy + ry)} c`,
    `${formatNumber(cx - k * rx)} ${formatNumber(cy + ry)} ${formatNumber(cx - rx)} ${formatNumber(cy + k * ry)} ${formatNumber(cx - rx)} ${formatNumber(cy)} c`,
    `${formatNumber(cx - rx)} ${formatNumber(cy - k * ry)} ${formatNumber(cx - k * rx)} ${formatNumber(cy - ry)} ${formatNumber(cx)} ${formatNumber(cy - ry)} c`,
    `${formatNumber(cx + k * rx)} ${formatNumber(cy - ry)} ${formatNumber(cx + rx)} ${formatNumber(cy - k * ry)} ${formatNumber(cx + rx)} ${formatNumber(cy)} c`,
    "h",
  ];
}

function shapeToPdf(tag: string, attributes: Record<string, string>): string[] {
  const rgb = colorToRgb(attributes.fill);
  if (!rgb) return [];
  const output = ["q", ...transformCommands(attributes.transform)];
  output.push(`${formatNumber(rgb[0])} ${formatNumber(rgb[1])} ${formatNumber(rgb[2])} rg`);

  if (tag === "path" && attributes.d) {
    output.push(...pathToPdf(attributes.d));
  } else if (tag === "circle") {
    const cx = Number(attributes.cx ?? 0);
    const cy = Number(attributes.cy ?? 0);
    const radius = Number(attributes.r ?? 0);
    output.push(...ellipsePath(cx, cy, radius, radius));
  } else if (tag === "ellipse") {
    const cx = Number(attributes.cx ?? 0);
    const cy = Number(attributes.cy ?? 0);
    const rx = Number(attributes.rx ?? 0);
    const ry = Number(attributes.ry ?? 0);
    output.push(...ellipsePath(cx, cy, rx, ry));
  } else {
    return [];
  }

  output.push(attributes["fill-rule"] === "evenodd" ? "f*" : "f", "Q");
  return output;
}

function svgToPdfCommands(svg: string): string | null {
  const commands: string[] = [];
  const shapeRegex = /<(path|circle|ellipse)\b([^>]*)\/?\s*>/g;
  for (const match of svg.matchAll(shapeRegex)) {
    const tag = match[1];
    if (!tag) continue;
    const attributes = parseAttributes(match[2] ?? "");
    commands.push(...shapeToPdf(tag, attributes));
  }
  return commands.length ? commands.join("\n") : null;
}

function normalizedSvgCommands(codepoint: string): string | null {
  if (svgCommandCache.has(codepoint)) return svgCommandCache.get(codepoint) ?? null;
  const svg = loadEmojiSvg(codepoint);
  const commands = svg ? svgToPdfCommands(svg) : null;
  svgCommandCache.set(codepoint, commands);
  return commands;
}

function placeholderCommands(x: number, y: number, size: number, codepoint: string): string {
  const inset = size * 0.08;
  const inner = size - inset * 2;
  return [
    `q 0.72 G 0.7 w ${formatNumber(x + inset)} ${formatNumber(y + inset)} ${formatNumber(inner)} ${formatNumber(inner)} re S`,
    `${formatNumber(x + inset)} ${formatNumber(y + inset)} m ${formatNumber(x + size - inset)} ${formatNumber(y + size - inset)} l S`,
    `% twemoji-missing:${codepoint}`,
    "Q",
  ].join("\n");
}

export function renderTwemojiPdf(codepoint: string, x: number, y: number, size: number): string {
  const commands = normalizedSvgCommands(codepoint);
  if (!commands) return placeholderCommands(x, y, size, codepoint);
  const scale = size / 36;
  return [
    "q",
    `% twemoji:${codepoint}`,
    `${formatNumber(scale)} 0 0 ${formatNumber(-scale)} ${formatNumber(x)} ${formatNumber(y + size)} cm`,
    commands,
    "Q",
  ].join("\n");
}

export function emojiAwareCharacterCount(value: string): number {
  let count = 0;
  for (const run of parseEmojiRuns(value)) {
    count += run.kind === "emoji" ? 1 : Array.from(run.text).length;
  }
  return count;
}
