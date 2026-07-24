import type { LunaModule } from "../types.ts";
import { shouldActivateBrowserSearchFallback } from "../../search/search-routing.ts";

export const BROWSER_MODULE: LunaModule = {
  id: "browser",
  name: "Navegador",
  description: "Navegación interactiva y scraping profundo con browser-agent",
  category: "internet",
  access: "authenticated",
  scope: "hybrid",
  tools: [
    { name: "browser_agent" },
    // El propio browser-agent resuelve autenticación normal; administrar el
    // almacén de credenciales es una superficie poco frecuente y diferida.
    { name: "browser_request_credential", defer: true },
    { name: "browser_credentials_list", defer: true },
    { name: "browser_credentials_save", defer: true },
    { name: "browser_credentials_delete", defer: true },
  ],
  prompt: {
    summary: "browser-agent navega dominios, inspecciona HTML/DOM/red/consola y descarga recursos.",
    keywords: ["dominio", "sitio web", "scrapea", "scraping", "html", "dom", "favicon", "captura", "inicia sesion", "inicia sesión", "descarga imagen"],
    patterns: [
      /(analiza|revisa|recorre|scrap|navega|audita|descarga|favicon|html).{0,100}https?:\/\//i,
      /https?:\/\/.{0,100}(analiza|revisa|recorre|scrap|navega|audita|descarga|favicon|html)/i,
      /\b(?:abre|visita|ve a|entra a|navega).{0,80}https?:\/\//iu,
      /\b(?:abre|visita|ve a|entra a|navega).{0,80}\b[a-z0-9][a-z0-9.-]+\.[a-z]{2,}\b/iu,
    ],
    activateWhen: (message) => shouldActivateBrowserSearchFallback(message),
    instructions: [
      "Usa browser_agent para navegación/scraping interactivo, login, captura o páginas que requieran JavaScript. Para una búsqueda/descarga pública simple, prioriza primero la capacidad public-web; browser-agent es el escalamiento cuando HTTP/API directa no basta. Si api-search no está disponible, Dogpile sirve para web general, Wikimedia Commons para imágenes y Archive.org para video/audio/contenido público.",
      "No pidas contraseñas por adelantado ni asumas identidad: browser-web solicita datos humanos durante la navegación y verifica la página final antes de declarar éxito.",
      "Si necesitas administrar directamente el almacén de credenciales, carga completamente browser con capability_load.",
    ],
    loadInstructions: [
      "Las credenciales persistentes usan referencias opacas; nunca repitas ni expongas contraseñas.",
      "Si el usuario ordena login sin correo/usuario, no elijas una cuenta aunque browser_credentials_list devuelva una sola; deja que browser-web confirme la identidad.",
    ],
  },
};
