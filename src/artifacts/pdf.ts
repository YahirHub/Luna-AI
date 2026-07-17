import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";

const WIN_ANSI_EXTENDED: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

type PdfFont = "F1" | "F2" | "F3";

interface TextBlock {
  kind: "text";
  text: string;
  size: number;
  font: PdfFont;
  lineHeight: number;
  spaceAfter: number;
  indent?: number;
}

interface RuleBlock {
  kind: "rule";
  spaceBefore: number;
  spaceAfter: number;
}

interface TableBlock {
  kind: "table";
  rows: string[][];
  spaceBefore: number;
  spaceAfter: number;
}

type MarkdownBlock = TextBlock | RuleBlock | TableBlock;

function toWinAnsi(value: string): string {
  const normalized = value
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/≠/g, "!=")
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/×/g, "x")
    .replace(/÷/g, "/");
  let output = "";
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0x3f;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      output += String.fromCharCode(code);
    } else {
      output += String.fromCharCode(WIN_ANSI_EXTENDED[code] ?? 0x3f);
    }
  }
  return output;
}

function pdfEscape(value: string): string {
  return toWinAnsi(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function number(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\\\|/g, "|")
    .replace(/[*_~`]/g, "")
    .trim();
}

function splitTableRow(raw: string): string[] {
  let line = raw.trim();
  if (line.startsWith("|")) line = line.slice(1);
  if (line.endsWith("|")) line = line.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      current += character;
      continue;
    }
    if (character === "|") {
      cells.push(cleanInlineMarkdown(current));
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(cleanInlineMarkdown(current));
  return cells;
}

function isTableSeparator(raw: string): boolean {
  const cells = splitTableRow(raw);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function looksLikeTableRow(raw: string): boolean {
  const line = raw.trim();
  return line.includes("|") && splitTableRow(line).length >= 2;
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const blocks: MarkdownBlock[] = [];
  let inCode = false;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();

    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      continue;
    }

    if (!inCode && looksLikeTableRow(raw) && isTableSeparator(lines[index + 1] ?? "")) {
      const rows: string[][] = [splitTableRow(raw)];
      index += 2;
      while (index < lines.length && looksLikeTableRow(lines[index] ?? "")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "table", rows, spaceBefore: 5, spaceAfter: 11 });
      continue;
    }

    if (inCode) {
      blocks.push({ kind: "text", text: raw, size: 8, font: "F2", lineHeight: 10, spaceAfter: 0 });
      continue;
    }

    if (!trimmed) {
      blocks.push({ kind: "text", text: "", size: 10, font: "F1", lineHeight: 8, spaceAfter: 0 });
    } else if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: "rule", spaceBefore: 3, spaceAfter: 9 });
    } else if (trimmed.startsWith("# ")) {
      blocks.push({ kind: "text", text: cleanInlineMarkdown(trimmed.slice(2)), size: 18, font: "F3", lineHeight: 22, spaceAfter: 8 });
    } else if (trimmed.startsWith("## ")) {
      blocks.push({ kind: "text", text: cleanInlineMarkdown(trimmed.slice(3)), size: 14, font: "F3", lineHeight: 18, spaceAfter: 6 });
    } else if (trimmed.startsWith("### ")) {
      blocks.push({ kind: "text", text: cleanInlineMarkdown(trimmed.slice(4)), size: 12, font: "F3", lineHeight: 16, spaceAfter: 4 });
    } else if (/^[-*+]\s+/.test(trimmed)) {
      blocks.push({ kind: "text", text: `• ${cleanInlineMarkdown(trimmed.replace(/^[-*+]\s+/, ""))}`, size: 10, font: "F1", lineHeight: 13, spaceAfter: 2, indent: 10 });
    } else if (/^\d+[.)]\s+/.test(trimmed)) {
      blocks.push({ kind: "text", text: cleanInlineMarkdown(trimmed), size: 10, font: "F1", lineHeight: 13, spaceAfter: 2, indent: 10 });
    } else if (trimmed.startsWith(">")) {
      blocks.push({ kind: "text", text: cleanInlineMarkdown(trimmed.replace(/^>\s?/, "")), size: 9, font: "F1", lineHeight: 12, spaceAfter: 4, indent: 12 });
    } else {
      blocks.push({ kind: "text", text: cleanInlineMarkdown(raw), size: 10, font: "F1", lineHeight: 13, spaceAfter: 4 });
    }
  }

  return blocks;
}

function approximateTextWidth(value: string, size: number, font: PdfFont): number {
  const factor = font === "F2" ? 0.6 : font === "F3" ? 0.54 : 0.5;
  return value.length * size * factor;
}

function breakLongWord(word: string, maxWidth: number, size: number, font: PdfFont): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of word) {
    const candidate = current + character;
    if (current && approximateTextWidth(candidate, size, font) > maxWidth) {
      chunks.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [word];
}

function wrapText(value: string, maxWidth: number, size: number, font: PdfFont): string[] {
  if (!value) return [""];
  const output: string[] = [];
  for (const paragraph of value.split("\n")) {
    if (!paragraph) {
      output.push("");
      continue;
    }
    const words = paragraph.split(/\s+/).flatMap((word) =>
      approximateTextWidth(word, size, font) > maxWidth
        ? breakLongWord(word, maxWidth, size, font)
        : [word]
    );
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && approximateTextWidth(candidate, size, font) > maxWidth) {
        output.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) output.push(current);
  }
  return output.length ? output : [""];
}

class PdfLayout {
  readonly pageWidth = 612;
  readonly pageHeight = 792;
  readonly margin = 48;
  readonly footerHeight = 22;
  readonly pages: string[][] = [[]];
  private y = this.pageHeight - this.margin;

  private get bottom(): number {
    return this.margin + this.footerHeight;
  }

  private get currentPage(): string[] {
    return this.pages[this.pages.length - 1] as string[];
  }

  private newPage(): void {
    this.pages.push([]);
    this.y = this.pageHeight - this.margin;
  }

  private ensureSpace(height: number): void {
    if (this.y - height < this.bottom) this.newPage();
  }

  private addText(text: string, x: number, y: number, size: number, font: PdfFont): void {
    this.currentPage.push(`BT /${font} ${number(size)} Tf ${number(x)} ${number(y)} Td (${pdfEscape(text)}) Tj ET`);
  }

  addTextBlock(block: TextBlock): void {
    const indent = block.indent ?? 0;
    const maxWidth = this.pageWidth - this.margin * 2 - indent;
    const lines = wrapText(block.text, maxWidth, block.size, block.font);
    for (const line of lines) {
      this.ensureSpace(block.lineHeight);
      if (line) this.addText(line, this.margin + indent, this.y - block.size, block.size, block.font);
      this.y -= block.lineHeight;
    }
    this.y -= block.spaceAfter;
  }

  addRule(block: RuleBlock): void {
    this.ensureSpace(block.spaceBefore + block.spaceAfter + 2);
    this.y -= block.spaceBefore;
    this.currentPage.push(`q 0.72 G 0.6 w ${number(this.margin)} ${number(this.y)} m ${number(this.pageWidth - this.margin)} ${number(this.y)} l S Q`);
    this.y -= block.spaceAfter;
  }

  private tableColumnWidths(rows: string[][], count: number): number[] {
    const available = this.pageWidth - this.margin * 2;
    const minimum = count >= 8 ? 30 : count >= 6 ? 38 : 48;
    const absoluteMinimum = Math.min(minimum, available / count);
    const base = Array.from({ length: count }, () => absoluteMinimum);
    const remaining = Math.max(0, available - absoluteMinimum * count);
    const weights = Array.from({ length: count }, (_, column) => {
      const longest = Math.max(...rows.map((row) => (row[column] ?? "").length), 4);
      return Math.min(42, Math.max(6, longest));
    });
    const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
    const widths = base.map((value, index) => value + remaining * ((weights[index] ?? 0) / totalWeight));
    const correction = available - widths.reduce((sum, value) => sum + value, 0);
    widths[widths.length - 1] = (widths[widths.length - 1] ?? 0) + correction;
    return widths;
  }

  private wrapRow(row: string[], widths: number[], header: boolean): string[][] {
    const font: PdfFont = header ? "F3" : "F1";
    const fontSize = header ? 7.4 : 7.2;
    return widths.map((width, index) => wrapText(row[index] ?? "", Math.max(10, width - 8), fontSize, font));
  }

  private rowHeight(wrapped: string[][]): number {
    return Math.max(1, ...wrapped.map((cell) => cell.length)) * 9 + 8;
  }

  private drawTableRow(row: string[], widths: number[], header: boolean): number {
    const wrapped = this.wrapRow(row, widths, header);
    const height = this.rowHeight(wrapped);
    const top = this.y;
    const bottom = top - height;
    const tableWidth = widths.reduce((sum, value) => sum + value, 0);

    if (header) {
      this.currentPage.push(`q 0.92 g ${number(this.margin)} ${number(bottom)} ${number(tableWidth)} ${number(height)} re f Q`);
    }
    this.currentPage.push(`q 0.68 G 0.55 w ${number(this.margin)} ${number(bottom)} ${number(tableWidth)} ${number(height)} re S Q`);

    let x = this.margin;
    for (let column = 0; column < widths.length; column++) {
      const width = widths[column] ?? 0;
      if (column > 0) {
        this.currentPage.push(`q 0.78 G 0.45 w ${number(x)} ${number(bottom)} m ${number(x)} ${number(top)} l S Q`);
      }
      const font: PdfFont = header ? "F3" : "F1";
      const size = header ? 7.4 : 7.2;
      const lines = wrapped[column] ?? [""];
      lines.forEach((line, lineIndex) => {
        if (line) this.addText(line, x + 4, top - 6 - size - lineIndex * 9, size, font);
      });
      x += width;
    }

    this.y = bottom;
    return height;
  }

  addTable(block: TableBlock): void {
    if (!block.rows.length) return;
    const columnCount = Math.max(...block.rows.map((row) => row.length));
    if (columnCount < 2) return;
    const rows = block.rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ""));
    const widths = this.tableColumnWidths(rows, columnCount);
    const header = rows[0] as string[];
    const headerHeight = this.rowHeight(this.wrapRow(header, widths, true));
    const firstBody = rows[1];
    const firstBodyHeight = firstBody ? this.rowHeight(this.wrapRow(firstBody, widths, false)) : 0;

    this.ensureSpace(block.spaceBefore + headerHeight + Math.min(firstBodyHeight, 45));
    this.y -= block.spaceBefore;
    this.drawTableRow(header, widths, true);

    for (const row of rows.slice(1)) {
      const height = this.rowHeight(this.wrapRow(row, widths, false));
      if (this.y - height < this.bottom) {
        this.newPage();
        this.drawTableRow(header, widths, true);
      }
      this.drawTableRow(row, widths, false);
    }
    this.y -= block.spaceAfter;
  }

  finalize(): string[][] {
    this.pages.forEach((page, index) => {
      const label = `Página ${index + 1} de ${this.pages.length}`;
      const width = approximateTextWidth(label, 8, "F1");
      page.push(`BT /F1 8 Tf ${number(this.pageWidth - this.margin - width)} ${number(this.margin - 2)} Td (${pdfEscape(label)}) Tj ET`);
    });
    return this.pages;
  }
}

export function createPdfFromMarkdown(markdown: string): Buffer {
  const layout = new PdfLayout();
  for (const block of parseMarkdown(markdown)) {
    if (block.kind === "text") layout.addTextBlock(block);
    else if (block.kind === "rule") layout.addRule(block);
    else layout.addTable(block);
  }
  const pages = layout.finalize();

  const objects: string[] = [];
  const add = (content: string): number => {
    objects.push(content);
    return objects.length;
  };
  const catalogId = add("");
  const pagesId = add("");
  const fontRegularId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontMonoId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const fontBoldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pageIds: number[] = [];

  for (const page of pages) {
    const stream = page.join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${layout.pageWidth} ${layout.pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontMonoId} 0 R /F3 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  const chunks = [Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1")];
  const offsets = [0];
  let offset = chunks[0]?.length ?? 0;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "latin1");
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

export function writePdfArtifact(workspace: WorkspaceManager, jid: string, markdownPath: string, outputPath: string): string {
  const markdown = workspace.readText(jid, markdownPath, 1_000_000);
  const target = workspace.resolvePath(jid, outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, createPdfFromMarkdown(markdown), { mode: 0o600 });
  return workspace.relativePath(jid, target);
}
