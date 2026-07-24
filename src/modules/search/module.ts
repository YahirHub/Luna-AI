import type { LunaModule } from "../types.ts";
import { isApiSearchCapabilityAvailable } from "../../search/search-routing.ts";

export const SEARCH_MODULE: LunaModule = {
  id: "search",
  name: "Búsqueda API",
  description: "Motores de búsqueda configurados en /setup-search",
  category: "internet",
  access: "authenticated",
  scope: "global",
  commands: [
    { name: "setup-search", description: "Configura motores de búsqueda y fallback", access: "admin" },
  ],
  tools: [
    { name: "researcher_web", availableWhen: () => isApiSearchCapabilityAvailable() },
    { name: "search_admin_status", access: "admin" },
    { name: "search_admin_set_enabled", access: "admin" },
    { name: "search_admin_set_default", access: "admin" },
    { name: "search_admin_set_fallback_order", access: "admin" },
    { name: "search_admin_test", access: "admin" },
    { name: "search_admin_start_set_api_key", access: "admin" },
    { name: "search_admin_remove_api_key", access: "admin" },
  ],
  prompt: {
    summary: "api-search hace búsquedas públicas rápidas mediante APIs configuradas.",
    availableWhen: () => isApiSearchCapabilityAvailable(),
    keywords: ["busca", "investiga", "precio", "noticia", "comparacion", "comparación", "actual", "verifica"],
    instructions: [
      "api-search está disponible porque existe al menos un proveedor configurado y habilitado.",
      "Usa researcher_web/api-search para búsquedas rápidas, noticias, precios, comparaciones y verificación pública. Como trabaja en background, tras lanzarlo continúa solo las partes independientes; la comparación o síntesis dependiente se completa automáticamente al regresar el resultado.",
      "Para contenido público descargable o extracción de URLs directas usa primero la capacidad public-web. Reserva browser-agent para JavaScript, interacción, login, CAPTCHA o cuando HTTP/API directa no sea suficiente.",
    ],
  },
};
