import type { LunaModule } from "../types.ts";
export const BROWSER_MODULE: LunaModule = {
  id: "browser", name: "Navegador", description: "Navegación interactiva y scraping profundo con browser-agent", category: "internet",
  access: "authenticated", scope: "hybrid",
  tools: [
    { name: "browser_agent" }, { name: "browser_request_credential" }, { name: "browser_credentials_list" },
    { name: "browser_credentials_save" }, { name: "browser_credentials_delete" },
  ],
  prompt: { summary: "browser-agent navega dominios, inspecciona HTML/DOM/red/consola y descarga recursos.", keywords: ["dominio", "sitio web", "scrapea", "scraping", "html", "dom", "favicon", "captura", "inicia sesion", "inicia sesión", "descarga imagen"], patterns: [/(analiza|revisa|recorre|scrap|navega|audita|descarga|favicon|html).{0,100}https?:\/\//i, /https?:\/\/.{0,100}(analiza|revisa|recorre|scrap|navega|audita|descarga|favicon|html)/i], instructions: [
    "Usa browser_agent cuando haya que recorrer un dominio específico, seguir enlaces internos, inspeccionar HTML/DOM/consola/red, iniciar sesión, tomar capturas o descargar assets.",
    "No pidas contraseñas por adelantado: deja que browser-web navegue y solicite datos humanos solo cuando sean realmente necesarios.",
    "Las credenciales persistentes se manejan por referencias opacas; nunca repitas ni expongas la contraseña.",
    "Después de browser_agent revisa resultados y artefactos antes de declarar éxito; un login solo es exitoso si se confirmó la página final.",
  ] },
};
