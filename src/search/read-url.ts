import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ToolDefinition } from "../ai.ts";
import { debugError, debugInfo, debugLog } from "../debug.ts";

const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 2_000_000;
const DEFAULT_MAX_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const READ_URL_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "api-search.read-url",
    description:
      "Lee una URL http/https encontrada mediante web_search y extrae texto legible. " +
      "Úsala para verificar una fuente antes de responder; no admite hosts locales ni redes privadas.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL completa http:// o https:// que se debe consultar.",
        },
        max_chars: {
          type: "integer",
          minimum: 1_000,
          maximum: 50_000,
          description: "Máximo de caracteres legibles a devolver. Predeterminado: 20000.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a = 0, b = 0] = parts;
  const c = parts[2] ?? 0;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split("%")[0] ?? "";
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

async function validatePublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("La URL no es válida.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Solo se permiten URLs http:// o https://.");
  }
  if (url.username || url.password) {
    throw new Error("No se permiten credenciales dentro de la URL.");
  }

  const hostname = url.hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("No se permiten hosts locales o internos.");
  }

  const directIp = isIP(hostname) ? hostname : null;
  const addresses = directIp
    ? [{ address: directIp }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("La URL resuelve a una red privada, local o reservada.");
  }

  return url;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function extractMeta(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeHtmlEntities(match[1]).trim();
  }
  return undefined;
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}


function decodeEmbeddedEscapes(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

function collectJsonStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > 12 || output.length >= 2_000) return;
  if (typeof value === "string") {
    const clean = decodeEmbeddedEscapes(value).replace(/\s+/g, " ").trim();
    if (clean.length >= 2 && clean.length <= 20_000) output.push(clean);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, output, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectJsonStrings(child, output, depth + 1);
  }
}


function primitiveText(value: unknown): string | null {
  if (typeof value === "string") return decodeEmbeddedEscapes(value).replace(/\s+/g, " ").trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function collectStructuredPricingRecords(value: unknown, output: string[], depth = 0): void {
  if (depth > 12 || output.length >= 500 || !value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredPricingRecords(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const entries = Object.entries(record).flatMap(([key, child]) => {
    const text = primitiveText(child);
    return text ? [{ key, text }] : [];
  });
  const normalizedKeys = entries.map(({ key }) => key.toLowerCase().replace(/[^a-z0-9]+/g, " "));
  const hasModel = normalizedKeys.some((key) => /\b(model|name|id|sku)\b/.test(key));
  const hasPriceField = normalizedKeys.some((key) => /\b(price|pricing|input|output|cache|prompt|completion|cost)\b/.test(key));
  const hasMoney = entries.some(({ text }) => /(?:US\$|USD\s*|\$)\s*\d|\b\d+(?:[.,]\d+)?\s*(?:USD|dollars?)\b/i.test(text));
  if ((hasModel && hasPriceField) || (hasPriceField && hasMoney)) {
    output.push(entries.map(({ key, text }) => `${key}: ${text}`).join(" | "));
  }

  for (const child of Object.values(record)) {
    collectStructuredPricingRecords(child, output, depth + 1);
  }
}

function priceRelevantContexts(value: string, maxContexts = 80): string[] {
  const decoded = decodeEmbeddedEscapes(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const pattern = /(?:US\$|USD\s*|\$)\s*\d+(?:[.,]\d+)?|\b(?:input|output|cached?\s*input|cache\s*(?:hit|miss)|pricing|price|precio|entrada|salida)\b/gi;
  const contexts: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(decoded)) !== null && contexts.length < maxContexts) {
    const start = Math.max(0, match.index - 220);
    const end = Math.min(decoded.length, match.index + match[0].length + 360);
    const context = decoded.slice(start, end).trim();
    const key = context.toLowerCase();
    if (context.length >= 20 && !seen.has(key)) {
      seen.add(key);
      contexts.push(context);
    }
  }
  return contexts;
}

function extractEmbeddedPageText(html: string): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const clean = decodeEmbeddedEscapes(value)
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!clean || clean.length < 2) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    sections.push(clean);
  };

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const isStructured = /application\/(?:ld\+json|json)/i.test(attrs) || /id=["']__NEXT_DATA__["']/i.test(attrs);
    if (isStructured) {
      try {
        const parsed = JSON.parse(decodeHtmlEntities(body));
        const records: string[] = [];
        collectStructuredPricingRecords(parsed, records);
        for (const record of records) add(record);
        const strings: string[] = [];
        collectJsonStrings(parsed, strings);
        for (const value of strings) {
          if (/\b(?:pricing|price|input|output|cache|tokens?|model|precio|entrada|salida)\b/i.test(value) || /(?:US\$|USD\s*|\$)\s*\d/.test(value)) add(value);
        }
      } catch {
        for (const context of priceRelevantContexts(body, 30)) add(context);
      }
      continue;
    }
    // Next.js, Docusaurus y otros generadores suelen incrustar el contenido
    // renderizado en scripts aunque el body inicial esté casi vacío.
    if (/__next|self\.__next_f|docusaurus|pricing|price|input|output|cache|tokens?/i.test(body)) {
      for (const context of priceRelevantContexts(body, 30)) add(context);
    }
  }

  for (const context of priceRelevantContexts(html, 50)) add(context);
  return sections.slice(0, 120).join("\n");
}

function htmlToReadableText(html: string): {
  title?: string;
  description?: string;
  text: string;
} {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1] ? stripHtml(titleMatch[1]) : undefined;
  const description = extractMeta(html, "description") ?? extractMeta(html, "og:description");
  const embeddedText = extractEmbeddedPageText(html);

  const linksConverted = html.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, label: string) => {
      const cleanLabel = stripHtml(label) || href;
      return `[${cleanLabel}](${decodeHtmlEntities(href)})`;
    },
  );
  const markdown = linksConverted
    .replace(/<(del|s|strike)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, value: string) => `~~${stripHtml(value)}~~`)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe|form|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, value: string) => `\n# ${stripHtml(value)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, value: string) => `\n## ${stripHtml(value)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, value: string) => `\n### ${stripHtml(value)}\n`)
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_m, value: string) => `\n#### ${stripHtml(value)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, value: string) => `\n- ${stripHtml(value)}`)
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, value: string) => {
      const cells = [...value.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => stripHtml(match[1] ?? ""));
      return cells.length ? `\n| ${cells.join(" | ")} |` : `\n${stripHtml(value)}`;
    })
    .replace(/<(br|hr)\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|blockquote|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const visibleText = decodeHtmlEntities(markdown)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const text = [
    embeddedText ? "## Datos estructurados y fragmentos relevantes\n" + embeddedText : "",
    visibleText,
  ].filter(Boolean).join("\n\n");

  return { title, description, text };
}

async function readTextLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error("La página supera el límite de descarga de 2 MB.");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("La página supera el límite de descarga de 2 MB.");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export interface ReadUrlOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

export async function readUrl(
  rawUrl: string,
  maxChars = DEFAULT_MAX_CHARS,
  options: ReadUrlOptions = {},
): Promise<string> {
  let current = await validatePublicUrl(rawUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,text/plain,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
          "User-Agent": "LunaAI-Research/1.0",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("La redirección no indicó un destino.");
        current = await validatePublicUrl(new URL(location, current).toString());
        continue;
      }

      if (!response.ok) {
        throw new Error(`La página respondió HTTP ${response.status}.`);
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (
        contentType &&
        !contentType.includes("text/") &&
        !contentType.includes("json") &&
        !contentType.includes("xml") &&
        !contentType.includes("html")
      ) {
        throw new Error(`Tipo de contenido no compatible: ${contentType}.`);
      }

      const raw = await readTextLimited(response);
      const extracted = contentType.includes("html") || /<html|<body|<article/i.test(raw)
        ? htmlToReadableText(raw)
        : { text: raw.replace(/\s+/g, " ").trim() };
      if (!extracted.text) throw new Error("No se encontró texto legible en la página.");

      const limit = Math.min(50_000, Math.max(1_000, Math.trunc(maxChars)));
      const truncated = extracted.text.length > limit;
      const text = truncated ? `${extracted.text.slice(0, limit)}\n\n[Contenido truncado]` : extracted.text;
      return [
        `URL solicitada: ${rawUrl}`,
        `URL final: ${current.toString()}`,
        `Estado: ${response.status}`,
        contentType ? `Tipo: ${contentType}` : "",
        extracted.title ? `Título: ${extracted.title}` : "",
        extracted.description ? `Descripción: ${extracted.description}` : "",
        "",
        text,
      ].filter((line) => line !== "").join("\n");
    }
    throw new Error(`La página excedió ${MAX_REDIRECTS} redirecciones.`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("La lectura de la URL fue cancelada o excedió el tiempo límite.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function executeReadUrlTool(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return "Error: la URL es obligatoria.";
  const maxChars = typeof args.max_chars === "number" ? args.max_chars : DEFAULT_MAX_CHARS;
  const startedAt = Date.now();
  debugLog("api-search.read-url", "started", { url, maxChars });
  try {
    const content = await readUrl(url, maxChars, { signal });
    debugInfo("api-search.read-url", "completed", {
      url,
      maxChars,
      contentChars: content.length,
      durationMs: Date.now() - startedAt,
    });
    return content;
  } catch (error) {
    debugError("api-search.read-url", "failed", error, {
      url,
      maxChars,
      durationMs: Date.now() - startedAt,
    });
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
