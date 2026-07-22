import { isApiSearchAvailable } from "./search-storage.ts";
import { loadAgentConfig } from "../agent-config.ts";

export const BROWSER_SEARCH_FALLBACK_URL = "https://www.dogpile.com/";

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
    `Realiza la búsqueda con browser-agent. Abre ${BROWSER_SEARCH_FALLBACK_URL} como buscador predeterminado, ejecuta allí la consulta y abre las fuentes originales que aparezcan en los resultados.`,
    "Dogpile solo sirve para descubrir resultados: verifica los datos en las páginas originales y basa la respuesta final en esas fuentes, no en el agregador.",
    "",
    prompt.trim(),
  ].join("\n");
}
