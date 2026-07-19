import type { ToolDefinition } from "../ai.ts";

export const BROWSER_AGENT_TOOL_NAMES = [
  "browser_open",
  "browser_snapshot",
  "browser_read",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_press",
  "browser_wait",
  "browser_get_text",
  "browser_get_url",
  "browser_screenshot",
  "browser_download",
  "browser_auth_login",
  "browser_close",
] as const;

export const BROWSER_AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "browser_open",
      description: "Abre o navega a una URL en la sesión aislada del navegador.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description: "Obtiene el árbol de accesibilidad de la página con referencias @eN. Úsalo después de navegar o cuando cambie la página.",
      parameters: {
        type: "object",
        properties: {
          interactive: { type: "boolean", description: "Solo elementos interactivos. Predeterminado true." },
          compact: { type: "boolean", description: "Reduce nodos estructurales vacíos. Predeterminado true." },
          depth: { type: "integer", minimum: 1, maximum: 12 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_read",
      description: "Lee el contenido textual renderizado de la pestaña activa. Útil para extraer métricas y contenido sin visión.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Hace clic en una referencia @eN o selector. No uses esta herramienta para compras, pagos, borrados, publicaciones o cambios de seguridad sin confirmación explícita del usuario.",
      parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_fill",
      description: "Limpia y rellena un campo de formulario con texto no secreto.",
      parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, required: ["selector", "text"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "Escribe texto en un elemento sin limpiarlo primero.",
      parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, required: ["selector", "text"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_press",
      description: "Presiona una tecla como Enter, Tab o Escape.",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_wait",
      description: "Espera por milisegundos, texto, URL, estado de carga o selector.",
      parameters: {
        type: "object",
        properties: {
          milliseconds: { type: "integer", minimum: 1, maximum: 60000 },
          selector: { type: "string" },
          text: { type: "string" },
          url: { type: "string" },
          load: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_get_text",
      description: "Obtiene el texto de una referencia o selector concreto.",
      parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_get_url",
      description: "Obtiene la URL actual.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description: "Guarda una captura PNG en el workdir del agente y devuelve su ruta relativa para que el agente principal pueda enviarla por WhatsApp.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Nombre opcional .png, sin rutas externas." },
          full: { type: "boolean" },
          annotate: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_download",
      description: "Descarga un archivo haciendo clic en un elemento y lo guarda en el workdir del agente.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" }, filename: { type: "string" } },
        required: ["selector", "filename"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_auth_login",
      description: "Inicia sesión usando una credential_ref segura capturada por el sistema. La contraseña nunca se entrega al LLM ni debe solicitarse en argumentos de esta herramienta.",
      parameters: { type: "object", properties: { credential_ref: { type: "string" } }, required: ["credential_ref"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_close",
      description: "Cierra la sesión activa del navegador. Úsalo al terminar la tarea.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];
