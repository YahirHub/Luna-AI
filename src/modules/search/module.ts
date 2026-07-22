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
      "Usa researcher_web/api-search para búsquedas rápidas, noticias, precios, comparaciones y verificación pública.",
      "No uses api-search para recorrer íntegramente un dominio, scraping completo, login o descarga de todos los recursos; para eso usa browser-agent.",
    ],
  },
};
