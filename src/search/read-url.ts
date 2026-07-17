import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ToolDefinition } from "../ai.ts";

const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 2_000_000;
const DEFAULT_MAX_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;

export const READ_URL_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "read_url",
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

function htmlToReadableText(html: string): {
  title?: string;
  description?: string;
  text: string;
} {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1]
    ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
    : undefined;
  const description = extractMeta(html, "description") ?? extractMeta(html, "og:description");

  const withoutNoise = html
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe|form|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|hr)\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ");

  const text = decodeHtmlEntities(withoutNoise)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

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
  fetchImpl?: typeof fetch;
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
  try {
    return await readUrl(url, maxChars, { signal });
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
