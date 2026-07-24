import { isApiSearchAvailable } from "./search-storage.ts";
import { loadAgentConfig } from "../agent-config.ts";

export const BROWSER_SEARCH_FALLBACK_URL = "https://www.dogpile.com/";
export const WIKIMEDIA_COMMONS_SEARCH_URL = "https://commons.wikimedia.org/wiki/Special:MediaSearch";
export const INTERNET_ARCHIVE_SEARCH_URL = "https://archive.org/advancedsearch.php";

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function isGeneralWebSearchIntent(message: string): boolean {
  const text = normalize(message);
  if (!text.trim()) return false;
  const searchVerb = /\b(?:busca|buscar|investiga|investigar|averigua|consulta|consultar|encuentra|encontrar|verifica|verificar|compara|comparar|precio|precios|noticia|noticias|actual|actuales|reciente|recientes)\b/.test(text);
  const explicitWeb = /\b(?:internet|web|online|en linea|fuentes|sitios|paginas|resultados)\b/.test(text);
  return searchVerb || explicitWeb;
}

export function isApiSearchCapabilityAvailable(): boolean {
  const config = loadAgentConfig();
  return Boolean(config.webSearchEnabled && config.researchSubagentEnabled && isApiSearchAvailable());
}

export function shouldActivateBrowserSearchFallback(message: string): boolean {
  return !isApiSearchCapabilityAvailable() && isGeneralWebSearchIntent(message);
}

export function buildDogpileSearchFallbackPrompt(prompt: string): string {
  return [
    "[SISTEMA: api-search no está disponible en esta ejecución porque no hay un proveedor utilizable o la capacidad de investigación está deshabilitada.]",
    "Usa fuentes públicas resistentes a automatización según el tipo de contenido:",
    `- Búsqueda web general: ${BROWSER_SEARCH_FALLBACK_URL} para descubrir enlaces; después abre y verifica las fuentes originales.`,
    `- Imágenes/medios reutilizables: ${WIKIMEDIA_COMMONS_SEARCH_URL}; conserva página File:, autor/creator, licencia y URL directa cuando estén disponibles.`,
    `- Video, audio, libros y otros objetos públicos: ${INTERNET_ARCHIVE_SEARCH_URL}; abre el item original y prioriza sus enlaces /download/ directos cuando la misión requiera el archivo.`,
    "Dogpile, Wikimedia Commons e Internet Archive son fuentes de descubrimiento/hosting; la respuesta final debe distinguir claramente la fuente original y no inventar licencia, autoría ni contenido visual.",
    "Si la tarea solo necesita localizar/descargar un archivo público y el orquestador dispone de public_media_search/public_media_download, esa ruta directa es preferible al navegador.",
    "",
    prompt.trim(),
  ].join("\n");
}
