import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { once } from "node:events";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { validatePublicUrl } from "../search/read-url.ts";
import { debugError, debugInfo, debugLog } from "../debug.ts";

const REQUEST_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 5;
const MAX_INSPECT_BYTES = 3_000_000;
const DEFAULT_DOWNLOAD_BYTES = 80 * 1024 * 1024;
const ABSOLUTE_DOWNLOAD_LIMIT = 200 * 1024 * 1024;

export type PublicMediaSource = "auto" | "archive" | "wikimedia";
export type PublicMediaType = "any" | "image" | "video" | "audio";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type UrlValidator = (rawUrl: string) => Promise<URL>;

export interface PublicWebRuntimeOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  validateUrl?: UrlValidator;
}

export interface PublicMediaCandidate {
  source: "archive.org" | "wikimedia-commons";
  title: string;
  page_url: string;
  direct_url?: string;
  mime?: string;
  size_bytes?: number;
  width?: number;
  height?: number;
  duration?: string;
  creator?: string;
  license?: string;
  license_url?: string;
  description?: string;
  identifier?: string;
}

function cleanText(value: unknown, max = 600): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extensionOf(name: string): string {
  return extname(name.split("?", 1)[0] ?? "").toLowerCase();
}

const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".webm", ".ogv", ".m4v", ".mov", ".mkv",
  ".mp3", ".ogg", ".opus", ".m4a", ".wav", ".flac",
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".svg",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogv", ".m4v", ".mov", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".ogg", ".opus", ".m4a", ".wav", ".flac"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".svg"]);

function extensionMatches(type: PublicMediaType, name: string, mime = ""): boolean {
  const ext = extensionOf(name);
  if (type === "video") return VIDEO_EXTENSIONS.has(ext) || mime.startsWith("video/");
  if (type === "audio") return AUDIO_EXTENSIONS.has(ext) || mime.startsWith("audio/");
  if (type === "image") return IMAGE_EXTENSIONS.has(ext) || mime.startsWith("image/");
  return MEDIA_EXTENSIONS.has(ext) || /^(?:video|audio|image)\//.test(mime);
}

function encodeArchivePath(value: string): string {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function fetchPublicResponse(
  rawUrl: string,
  init: RequestInit,
  options: PublicWebRuntimeOptions = {},
): Promise<{ response: Response; finalUrl: URL }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const validateUrl = options.validateUrl ?? validatePublicUrl;
  let current = await validateUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error("cancelled"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const headers = new Headers(init.headers);
      if (!headers.has("User-Agent")) headers.set("User-Agent", "LunaAI-PublicWeb/1.0");
      const response = await fetchImpl(current, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location) throw new Error("La redirección no indicó un destino.");
        current = await validateUrl(new URL(location, current).toString());
        continue;
      }
      return { response, finalUrl: current };
    }
    throw new Error(`La URL excedió ${MAX_REDIRECTS} redirecciones.`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("La solicitud fue cancelada o excedió el tiempo límite.");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function readJson(rawUrl: string, options: PublicWebRuntimeOptions = {}): Promise<unknown> {
  const { response } = await fetchPublicResponse(rawUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
  }, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} al consultar ${rawUrl}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_INSPECT_BYTES) throw new Error("La respuesta JSON supera 3 MB.");
  const text = await response.text();
  if (text.length > MAX_INSPECT_BYTES) throw new Error("La respuesta JSON supera 3 MB.");
  return JSON.parse(text);
}

function archiveMediaType(type: PublicMediaType): string | null {
  if (type === "video") return "movies";
  if (type === "audio") return "audio";
  if (type === "image") return "image";
  return null;
}

function archiveFileScore(file: Record<string, unknown>, type: PublicMediaType): number {
  const name = typeof file.name === "string" ? file.name : "";
  const mime = typeof file.mime === "string" ? file.mime.toLowerCase() : "";
  if (!extensionMatches(type, name, mime)) return -10_000;
  if (/__ia_thumb|\.torrent$|_meta\.|_files\.xml$|_archive\.torrent$/i.test(name)) return -10_000;
  const ext = extensionOf(name);
  let score = file.source === "original" ? 60 : 30;
  if (type === "video" && ext === ".mp4") score += 40;
  if (type === "video" && ext === ".webm") score += 25;
  if (type === "audio" && ext === ".mp3") score += 35;
  if (type === "image" && [".jpg", ".jpeg", ".png", ".webp"].includes(ext)) score += 30;
  const size = numberValue(file.size) ?? Number.MAX_SAFE_INTEGER;
  // Para mensajería preferimos una variante razonablemente pequeña cuando hay
  // varias copias equivalentes, sin convertir el tamaño en criterio absoluto.
  if (size <= 10 * 1024 * 1024) score += 12;
  else if (size <= 50 * 1024 * 1024) score += 8;
  else if (size <= 150 * 1024 * 1024) score += 3;
  return score;
}

export async function searchInternetArchive(
  query: string,
  type: PublicMediaType,
  limit: number,
  options: PublicWebRuntimeOptions = {},
): Promise<PublicMediaCandidate[]> {
  const params = new URLSearchParams();
  const mediaType = archiveMediaType(type);
  params.set("q", mediaType ? `(${query}) AND mediatype:${mediaType}` : query);
  for (const field of ["identifier", "title", "description", "creator", "mediatype", "downloads", "date"]) params.append("fl[]", field);
  params.append("sort[]", "downloads desc");
  params.set("rows", String(Math.max(limit * 2, 8)));
  params.set("page", "1");
  params.set("output", "json");
  const searchUrl = `https://archive.org/advancedsearch.php?${params.toString()}`;
  const payload = await readJson(searchUrl, options) as Record<string, unknown>;
  const response = payload.response as Record<string, unknown> | undefined;
  const docs = Array.isArray(response?.docs) ? response!.docs as Array<Record<string, unknown>> : [];
  const candidates: PublicMediaCandidate[] = [];

  for (const doc of docs) {
    if (candidates.length >= limit) break;
    const identifier = typeof doc.identifier === "string" ? doc.identifier.trim() : "";
    if (!identifier) continue;
    try {
      const metadataPayload = await readJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, options) as Record<string, unknown>;
      const metadata = (metadataPayload.metadata && typeof metadataPayload.metadata === "object")
        ? metadataPayload.metadata as Record<string, unknown>
        : {};
      const files = Array.isArray(metadataPayload.files) ? metadataPayload.files as Array<Record<string, unknown>> : [];
      const selected = files
        .map((file) => ({ file, score: archiveFileScore(file, type) }))
        .filter((entry) => entry.score > -10_000)
        .sort((a, b) => b.score - a.score)[0]?.file;
      const fileName = typeof selected?.name === "string" ? selected.name : undefined;
      const mime = typeof selected?.mime === "string" ? selected.mime : undefined;
      const creator = cleanText(metadata.creator ?? doc.creator);
      const title = cleanText(metadata.title ?? doc.title, 300) ?? identifier;
      const candidate: PublicMediaCandidate = {
        source: "archive.org",
        title,
        page_url: `https://archive.org/details/${encodeURIComponent(identifier)}`,
        identifier,
        creator,
        description: cleanText(metadata.description ?? doc.description),
        license: cleanText(metadata.license ?? metadata.rights, 300),
        license_url: typeof metadata.licenseurl === "string" ? metadata.licenseurl : undefined,
        duration: cleanText(metadata.runtime ?? selected?.length, 80),
      };
      if (fileName) {
        candidate.direct_url = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeArchivePath(fileName)}`;
        candidate.mime = mime;
        candidate.size_bytes = numberValue(selected?.size);
      }
      candidates.push(candidate);
    } catch (error) {
      debugLog("public-web.archive", "metadata_skipped", { identifier, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return candidates;
}

function commonsMetadataValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return cleanText(record.value, 800);
}

export async function searchWikimediaCommons(
  query: string,
  type: PublicMediaType,
  limit: number,
  options: PublicWebRuntimeOptions = {},
): Promise<PublicMediaCandidate[]> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: String(Math.max(limit * 2, 8)),
    prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata",
    origin: "*",
  });
  const payload = await readJson(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, options) as Record<string, unknown>;
  const queryData = payload.query as Record<string, unknown> | undefined;
  const pages = Array.isArray(queryData?.pages) ? queryData!.pages as Array<Record<string, unknown>> : [];
  const candidates: PublicMediaCandidate[] = [];
  for (const page of pages) {
    if (candidates.length >= limit) break;
    const title = typeof page.title === "string" ? page.title : "Archivo de Wikimedia Commons";
    const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] as Record<string, unknown> | undefined : undefined;
    const directUrl = typeof info?.url === "string" ? info.url : undefined;
    const mime = typeof info?.mime === "string" ? info.mime.toLowerCase() : "";
    if (type !== "any" && directUrl && !extensionMatches(type, directUrl, mime)) continue;
    const extmetadata = info?.extmetadata && typeof info.extmetadata === "object"
      ? info.extmetadata as Record<string, unknown>
      : {};
    const descriptionUrl = typeof info?.descriptionurl === "string"
      ? info.descriptionurl
      : `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    candidates.push({
      source: "wikimedia-commons",
      title: title.replace(/^File:/i, ""),
      page_url: descriptionUrl,
      direct_url: directUrl,
      mime: mime || undefined,
      size_bytes: numberValue(info?.size),
      width: numberValue(info?.width),
      height: numberValue(info?.height),
      creator: commonsMetadataValue(extmetadata.Artist) ?? commonsMetadataValue(extmetadata.Credit),
      description: commonsMetadataValue(extmetadata.ImageDescription) ?? commonsMetadataValue(extmetadata.ObjectName),
      license: commonsMetadataValue(extmetadata.LicenseShortName) ?? commonsMetadataValue(extmetadata.UsageTerms),
      license_url: commonsMetadataValue(extmetadata.LicenseUrl),
    });
  }
  return candidates;
}

export async function searchPublicMedia(
  query: string,
  source: PublicMediaSource,
  type: PublicMediaType,
  limit: number,
  options: PublicWebRuntimeOptions = {},
): Promise<PublicMediaCandidate[]> {
  const normalizedLimit = Math.max(1, Math.min(10, Math.trunc(limit || 5)));
  if (source === "archive") return searchInternetArchive(query, type, normalizedLimit, options);
  if (source === "wikimedia") return searchWikimediaCommons(query, type, normalizedLimit, options);

  const primary = type === "image" ? "wikimedia" : "archive";
  const secondary = primary === "archive" ? "wikimedia" : "archive";
  let first: PublicMediaCandidate[] = [];
  let firstError: unknown;
  try {
    first = primary === "archive"
      ? await searchInternetArchive(query, type, normalizedLimit, options)
      : await searchWikimediaCommons(query, type, normalizedLimit, options);
  } catch (error) {
    firstError = error;
    debugLog("public-web.search", "primary_source_failed", { primary, query, error: error instanceof Error ? error.message : String(error) });
  }
  if (first.length >= normalizedLimit) return first.slice(0, normalizedLimit);
  try {
    const remainder = Math.max(1, normalizedLimit - first.length);
    const second = secondary === "archive"
      ? await searchInternetArchive(query, type, remainder, options)
      : await searchWikimediaCommons(query, type, remainder, options);
    return [...first, ...second].slice(0, normalizedLimit);
  } catch (secondaryError) {
    if (first.length > 0) return first.slice(0, normalizedLimit);
    throw firstError ?? secondaryError;
  }
}

function decodeHtmlUrl(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .trim();
}

function isMediaCandidate(url: string): boolean {
  const pathname = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  return MEDIA_EXTENSIONS.has(extensionOf(pathname))
    || /(?:\/download\/|[?&](?:file|media|video|audio|image|src)=)/i.test(url);
}

export function extractPublicUrls(
  raw: string,
  baseUrl: string,
  kind: "all" | "links" | "media" = "all",
  contains = "",
  maxMatches = 30,
): Array<{ url: string; source: string }> {
  const matches: Array<{ url: string; source: string }> = [];
  const seen = new Set<string>();
  const add = (rawCandidate: string, source: string): void => {
    let candidate = decodeHtmlUrl(rawCandidate);
    if (!candidate || candidate.startsWith("data:") || candidate.startsWith("javascript:") || candidate.startsWith("mailto:")) return;
    try { candidate = new URL(candidate, baseUrl).toString(); } catch { return; }
    if (!/^https?:\/\//i.test(candidate)) return;
    if (contains && !candidate.toLowerCase().includes(contains.toLowerCase())) return;
    if (kind === "media" && !isMediaCandidate(candidate)) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    matches.push({ url: candidate, source });
  };

  const attrPattern = /\b(href|src|poster|content|data-src|data-url|data-video|data-audio|data-download|data-original|srcset)\s*=\s*["']([^"']+)["']/gi;
  for (const match of raw.matchAll(attrPattern)) {
    if (matches.length >= maxMatches) break;
    const attr = (match[1] ?? "").toLowerCase();
    if (kind === "links" && attr !== "href") continue;
    const value = match[2] ?? "";
    if (attr === "srcset") {
      for (const item of value.split(",")) {
        if (matches.length >= maxMatches) break;
        add(item.trim().split(/\s+/, 1)[0] ?? "", attr);
      }
    } else {
      add(value, attr);
    }
  }
  // JSON/estado embebido frecuente en páginas modernas. Captura también URLs
  // relativas en claves conocidas, sin entregar el bloque completo al modelo.
  if (matches.length < maxMatches && kind !== "links") {
    const jsonUrlPattern = /["'](?:url|src|file|media|video|audio|download|contentUrl)["']\s*:\s*["']([^"']+)["']/gi;
    for (const match of raw.matchAll(jsonUrlPattern)) {
      if (matches.length >= maxMatches) break;
      add(match[1] ?? "", "json");
    }
  }
  if (matches.length < maxMatches) {
    const absolutePattern = /https?:\\?\/\\?\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%\\-]+/g;
    for (const match of raw.matchAll(absolutePattern)) {
      if (matches.length >= maxMatches) break;
      add(match[0], "raw");
    }
  }
  return matches.slice(0, maxMatches);
}

async function readPublicText(rawUrl: string, options: PublicWebRuntimeOptions = {}): Promise<{ text: string; finalUrl: string; contentType: string }> {
  const { response, finalUrl } = await fetchPublicResponse(rawUrl, {
    method: "GET",
    headers: { Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.2" },
  }, options);
  if (!response.ok) throw new Error(`La página respondió HTTP ${response.status}.`);
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type && !/(?:text|html|json|xml|javascript)/.test(type)) throw new Error(`La URL no contiene texto/HTML inspeccionable (${type}).`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_INSPECT_BYTES) throw new Error("La página supera el límite de inspección de 3 MB.");
  if (!response.body) return { text: "", finalUrl: finalUrl.toString(), contentType: type };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_INSPECT_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("La página supera el límite de inspección de 3 MB.");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(merged), finalUrl: finalUrl.toString(), contentType: type };
}

export async function inspectPublicUrls(
  rawUrl: string,
  kind: "all" | "links" | "media",
  contains: string,
  maxMatches: number,
  options: PublicWebRuntimeOptions = {},
): Promise<Record<string, unknown>> {
  const page = await readPublicText(rawUrl, options);
  const matches = extractPublicUrls(page.text, page.finalUrl, kind, contains, Math.max(1, Math.min(100, maxMatches)));
  return {
    requested_url: rawUrl,
    final_url: page.finalUrl,
    content_type: page.contentType,
    inspected_chars: page.text.length,
    match_count: matches.length,
    matches,
  };
}

function safeFilename(value: string): string {
  const cleaned = basename(value || "download.bin")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 180);
  return cleaned || "download.bin";
}

function filenameFromContentDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }
  return /filename=["']?([^"';]+)["']?/i.exec(value)?.[1]?.trim();
}

function extensionForMime(mime: string): string {
  const map: Record<string, string> = {
    "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/ogg": ".ogg",
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "application/pdf": ".pdf",
  };
  return map[mime.split(";", 1)[0]?.trim().toLowerCase() ?? ""] ?? "";
}

export async function downloadPublicMedia(
  rawUrl: string,
  workspace: WorkspaceManager,
  jid: string,
  requestedFilename: string,
  maxBytes: number,
  options: PublicWebRuntimeOptions = {},
): Promise<Record<string, unknown>> {
  const safeLimit = Math.max(1_000_000, Math.min(ABSOLUTE_DOWNLOAD_LIMIT, maxBytes || DEFAULT_DOWNLOAD_BYTES));
  const { response, finalUrl } = await fetchPublicResponse(rawUrl, { method: "GET", headers: { Accept: "*/*" } }, options);
  if (!response.ok) throw new Error(`La descarga respondió HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > safeLimit) throw new Error(`El archivo declara ${declared} bytes y supera el límite de ${safeLimit} bytes.`);
  const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0]?.trim().toLowerCase() ?? "application/octet-stream";
  if (contentType.includes("text/html")) throw new Error("La URL devolvió HTML en lugar de un archivo descargable directo.");

  const headerName = filenameFromContentDisposition(response.headers.get("content-disposition"));
  const urlName = basename(finalUrl.pathname) || "download";
  let filename = safeFilename(requestedFilename || headerName || urlName);
  if (!extname(filename)) filename = `${filename}${extensionForMime(contentType) || ".bin"}`;
  let relative = `downloads/public/${filename}`;
  let target = workspace.resolvePath(jid, relative, { allowDirectory: false });
  if (existsSync(target)) {
    const ext = extname(filename);
    const stem = ext ? filename.slice(0, -ext.length) : filename;
    relative = `downloads/public/${stem}-${Date.now()}${ext}`;
    target = workspace.resolvePath(jid, relative, { allowDirectory: false });
  }
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.part-${crypto.randomUUID().slice(0, 8)}`;
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  let total = 0;
  try {
    if (!response.body) throw new Error("La descarga no devolvió un cuerpo de datos.");
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > safeLimit) {
        await reader.cancel().catch(() => {});
        throw new Error(`La descarga excedió el límite de ${safeLimit} bytes.`);
      }
      if (!output.write(Buffer.from(value))) await once(output, "drain");
    }
    const closed = once(output, "close");
    output.end();
    await closed;
    renameSync(temporary, target);
    workspace.registerArtifact(jid, relative, "public-media", { temporary: false });
    return {
      ok: true,
      requested_url: rawUrl,
      final_url: finalUrl.toString(),
      path: relative,
      bytes: total,
      mime: contentType,
      note: "Archivo descargado. Usa message_send con path para entregarlo al usuario.",
    };
  } catch (error) {
    output.destroy();
    rmSync(temporary, { force: true });
    throw error;
  }
}

export async function executePublicWebTool(
  name: string,
  args: Record<string, unknown>,
  dependencies: { workspace: WorkspaceManager; jid: string; signal?: AbortSignal },
): Promise<string> {
  const startedAt = Date.now();
  try {
    if (name === "public_media_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return "Error: query es obligatorio.";
      const source: PublicMediaSource = ["auto", "archive", "wikimedia"].includes(String(args.source)) ? args.source as PublicMediaSource : "auto";
      const type: PublicMediaType = ["any", "image", "video", "audio"].includes(String(args.media_type)) ? args.media_type as PublicMediaType : "any";
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const results = await searchPublicMedia(query, source, type, limit, { signal: dependencies.signal });
      debugInfo("public-web.search", "completed", { query, source, type, results: results.length, durationMs: Date.now() - startedAt });
      return JSON.stringify({ query, source, media_type: type, result_count: results.length, results }, null, 2);
    }
    if (name === "public_web_extract_urls") {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return "Error: url es obligatoria.";
      const kind = ["all", "links", "media"].includes(String(args.kind)) ? args.kind as "all" | "links" | "media" : "all";
      const contains = typeof args.contains === "string" ? args.contains.trim() : "";
      const maxMatches = typeof args.max_matches === "number" ? args.max_matches : 30;
      const result = await inspectPublicUrls(url, kind, contains, maxMatches, { signal: dependencies.signal });
      debugInfo("public-web.inspect", "completed", { url, kind, durationMs: Date.now() - startedAt });
      return JSON.stringify(result, null, 2);
    }
    if (name === "public_media_download") {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return "Error: url es obligatoria.";
      const filename = typeof args.filename === "string" ? args.filename.trim() : "";
      const maxMb = typeof args.max_mb === "number" ? Math.max(1, Math.min(200, Math.trunc(args.max_mb))) : 80;
      const result = await downloadPublicMedia(url, dependencies.workspace, dependencies.jid, filename, maxMb * 1024 * 1024, { signal: dependencies.signal });
      debugInfo("public-web.download", "completed", { url, durationMs: Date.now() - startedAt, ...result });
      return JSON.stringify(result, null, 2);
    }
    return `Error: herramienta pública desconocida: ${name}`;
  } catch (error) {
    debugError("public-web", "tool_failed", error, { name, durationMs: Date.now() - startedAt });
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
