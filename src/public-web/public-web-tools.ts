import type { ToolDefinition } from "../ai.ts";

export const PUBLIC_WEB_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "public_media_search",
      description:
        "Busca contenido público sin abrir un navegador. Usa directamente Internet Archive y/o Wikimedia Commons y devuelve URLs de página, archivos directos y metadata útil. " +
        "Prefiérela a browser_agent para buscar imágenes, video, audio o material descargable público.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Qué contenido público se desea encontrar." },
          source: { type: "string", enum: ["auto", "archive", "wikimedia"], description: "Fuente. auto elige según el tipo de medio." },
          media_type: { type: "string", enum: ["any", "image", "video", "audio"], description: "Tipo de medio buscado." },
          limit: { type: "integer", minimum: 1, maximum: 10, description: "Máximo de candidatos. Predeterminado: 5." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "public_web_extract_urls",
      description:
        "Inspecciona HTML/JSON público por HTTP sin browser-agent y extrae localmente URLs/enlaces/medios coincidentes, sin inyectar todo el código fuente al LLM. " +
        "Úsala para localizar .mp4, .webm, imágenes, embeds, assets o endpoints directos en una página pública estática.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL pública http/https que debe inspeccionarse." },
          kind: { type: "string", enum: ["all", "links", "media"], description: "Filtra todos los enlaces o solo candidatos de medios." },
          contains: { type: "string", description: "Texto opcional que debe aparecer en la URL extraída, por ejemplo .mp4, download o video." },
          max_matches: { type: "integer", minimum: 1, maximum: 100, description: "Máximo de coincidencias. Predeterminado: 30." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "public_media_download",
      description:
        "Descarga directamente una URL pública http/https al workdir sin navegador. Revalida redirecciones, bloquea redes privadas y limita el tamaño. " +
        "Después usa message_send con la ruta devuelta para entregar el archivo al usuario.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL directa del archivo público." },
          filename: { type: "string", description: "Nombre opcional del archivo dentro de downloads/public/." },
          max_mb: { type: "integer", minimum: 1, maximum: 200, description: "Límite de descarga para este archivo. Predeterminado: 80 MB." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];
