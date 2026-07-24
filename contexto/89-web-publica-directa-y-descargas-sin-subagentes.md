# 89 — Web pública directa y descargas sin subagentes

# Fecha

2026-07-24

# Objetivo

Reducir latencia y tokens evitando `browser-agent` cuando el orquestador puede resolver por HTTP/API una búsqueda, inspección de enlaces o descarga de contenido público. El navegador pasa a ser un escalamiento para interacción real, no la primera herramienta de descarga.

# Arquitectura implementada

## Ruta directa del orquestador

Se añadió el módulo `public-web` con tres herramientas:

- `public_media_search`: busca candidatos directamente en Internet Archive y Wikimedia Commons y devuelve metadata compacta, página del item y `direct_url` cuando existe.
- `public_web_extract_urls`: descarga HTML/JSON público con límites, analiza localmente atributos/enlaces y devuelve solamente coincidencias, evitando enviar todo el código al LLM.
- `public_media_download`: descarga una URL pública al workdir, controla redirecciones, bloquea destinos privados mediante el validador SSRF existente, limita tamaño y registra el archivo como artefacto. Después el orquestador usa `message_send`.

Para una solicitud del tipo `busca un video en archive.org y mándamelo`, el flujo esperado es:

1. `public_media_search`
2. elegir un candidato con `direct_url`
3. `public_media_download`
4. `message_send`

No se debe lanzar un subagente solo para abrir una URL `.mp4`, `.webm`, imagen u otro archivo directo.

## Fuentes públicas especializadas

- **Wikimedia Commons**: prioridad para imágenes y otros medios donde conviene conservar autor, licencia, página `File:` y URL directa. La integración usa la Action API (`generator=search` + `imageinfo`).
- **Internet Archive / archive.org**: prioridad para video, audio y objetos públicos. La integración usa `advancedsearch.php` para localizar items y `/metadata/{identifier}` para inspeccionar la lista real de archivos y elegir una variante descargable.
- **Dogpile**: se conserva para descubrimiento web general cuando api-search no está disponible; después deben verificarse las fuentes originales.

# Routing

`shouldPreferDirectPublicWeb()` detecta solicitudes públicas de búsqueda/descarga. En esa ruta el toolset inicial oculta `browser_agent`, `researcher_web` y `spawn_agents` para evitar una delegación innecesaria.

Esto no elimina capacidades: si HTTP/API falla, el modelo puede hacer `capability_load("browser")`, `capability_load("search")` o `capability_load("agents")` y continuar en la misma ejecución.

La ruta directa no sustituye al navegador cuando la misión requiere login, contraseña, OTP, CAPTCHA, clics, formularios, screenshot, JavaScript/DOM, consola o inspección de red. Si el usuario pide explícitamente un subagente, se respeta.

# Browser-agent

Se añadió `browser_find_html` al grupo lazy `inspect`. Busca texto, URLs o medios dentro del HTML ya renderizado de la página y devuelve únicamente coincidencias compactas. Así una SPA puede localizar `.mp4`, `download`, embeds o assets sin volcar decenas de KB de HTML al modelo.

# Seguridad y límites

- Solo HTTP/HTTPS públicos.
- Se reutiliza la protección SSRF de `validatePublicUrl` y se revalida cada redirección.
- Máximo 5 redirecciones.
- Inspección de texto/HTML limitada a 3 MB.
- Descarga predeterminada limitada a 80 MB y límite absoluto configurable de 200 MB por tool.
- Los archivos se escriben primero como `.part-*` y se renombran al completar la descarga.
- Una respuesta `text/html` se rechaza como descarga directa para evitar guardar una página de error como supuesto medio.

# Progressive disclosure

`public-web` forma parte del catálogo modular y solo se activa por intención. `browser_find_html` tampoco aumenta el toolset inicial de `browser-web`: pertenece al grupo `inspect` y se carga cuando hace falta.

# Pruebas

Se añadieron pruebas para:

- extracción local de URLs sin devolver todo el HTML;
- Internet Archive: búsqueda + metadata + selección de MP4 directo;
- Wikimedia Commons: URL directa, autor y licencia;
- descarga directa al workdir y registro del artefacto;
- routing directo frente a login/interacción;
- respeto a una petición explícita de browser-agent;
- ocultamiento inicial de subagentes y posibilidad de recuperarlos con `capability_load`;
- integración de `browser_find_html`;
- presencia de Dogpile, Wikimedia Commons e Internet Archive en los fallbacks especializados.

# Validación en entorno de entrega

El entorno de generación no dispone de Bun ni de `node_modules`, por lo que la suite completa debe ejecutarse en el host del proyecto con `bun install`, `bun run typecheck`, `bun run test` y `bun run build`. Se realizaron comprobaciones ejecutables con Node para routing, búsqueda simulada de Archive/Commons, extracción de URLs y descarga streaming al workdir.
