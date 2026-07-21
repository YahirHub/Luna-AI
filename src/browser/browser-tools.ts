import type { ToolDefinition } from "../ai.ts";

export const BROWSER_AGENT_TOOL_NAMES = [
  "browser_open",
  "browser_snapshot",
  "browser_read",
  "browser_get_html",
  "browser_eval",
  "browser_console",
  "browser_errors",
  "browser_network_requests",
  "browser_network_request",
  "browser_extract_assets",
  "browser_download_assets",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_press",
  "browser_wait",
  "browser_get_text",
  "browser_get_url",
  "browser_screenshot",
  "browser_pdf",
  "browser_download",
  "browser_auth_profiles",
  "browser_request_user_input",
  "browser_fill_secret",
  "browser_auth_confirm",
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
      name: "browser_get_html",
      description: "Obtiene y guarda el HTML renderizado de toda la página o de un selector. Úsalo para auditorías DOM, scraping estructural y reconstrucción de sitios.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Selector o referencia. Predeterminado: html." },
          filename: { type: "string", description: "Nombre .html opcional dentro de la carpeta del agente." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_eval",
      description: "Ejecuta JavaScript en la página activa para inspeccionar DOM, estado o datos que no aparezcan en accesibilidad. No debe leer contraseñas, cookies ni secretos.",
      parameters: {
        type: "object",
        properties: { script: { type: "string" }, filename: { type: "string", description: "Archivo .json/.txt opcional donde guardar la salida completa." } },
        required: ["script"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_console",
      description: "Lee o limpia los mensajes de consola de la página para detectar errores y comportamiento JavaScript.",
      parameters: { type: "object", properties: { clear: { type: "boolean" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_errors",
      description: "Lee o limpia los errores de página y excepciones JavaScript.",
      parameters: { type: "object", properties: { clear: { type: "boolean" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_network_requests",
      description: "Lista solicitudes de red observadas por el navegador, con filtros opcionales. Útil para descubrir APIs, recursos, imágenes y errores HTTP.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string" },
          resource_types: { type: "string", description: "Tipos separados por coma, por ejemplo xhr,fetch,img." },
          method: { type: "string" },
          status: { type: "string" },
          clear: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_network_request",
      description: "Obtiene el detalle completo de una solicitud de red por su requestId.",
      parameters: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_extract_assets",
      description: "Extrae del DOM todas las imágenes, srcset, favicons, estilos, scripts y enlaces internos y guarda un manifest JSON en el workdir.",
      parameters: { type: "object", properties: { filename: { type: "string" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_download_assets",
      description: "Descarga al workdir imágenes y favicons públicos encontrados en la página actual. Devuelve un manifest con éxitos y errores.",
      parameters: {
        type: "object",
        properties: {
          max_files: { type: "integer", minimum: 1, maximum: 150 },
          include_external: { type: "boolean", description: "Permite CDNs/hosts externos públicos. Predeterminado true." },
          folder: { type: "string", description: "Subcarpeta de descarga. Predeterminado browser/downloads/assets." },
        },
        additionalProperties: false,
      },
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
      name: "browser_pdf",
      description: "Guarda la página actual completa como PDF dentro del workdir del agente.",
      parameters: { type: "object", properties: { filename: { type: "string" } }, additionalProperties: false },
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
      name: "browser_auth_profiles",
      description: "Lista perfiles de credenciales guardados por el sistema para este usuario de Luna. Devuelve solo referencias opacas, URL y nombre de usuario; nunca contraseñas. Úsala cuando una sesión haya expirado o necesites elegir entre varias cuentas del mismo sitio.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL o dominio opcional para filtrar cuentas." },
          username: { type: "string", description: "Correo/usuario opcional para filtrar una cuenta concreta." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_request_user_input",
      description: "Pausa esta misma ejecución de navegador para pedir al sistema un dato que falta. La sesión de agent-browser permanece abierta y la tool no retorna hasta que el usuario responda o cancele. Para password u otp el valor se captura fuera del LLM y solo se devuelve una referencia segura.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["username", "password", "otp", "text"] },
          field_name: { type: "string", description: "Nombre humano del dato solicitado, por ejemplo correo, contraseña o código de verificación." },
          url: { type: "string", description: "Sitio al que pertenece el dato, cuando aplique." },
          username: { type: "string", description: "Usuario/correo conocido. Es obligatorio cuando kind=password para asociar la contraseña a la cuenta correcta." },
          message: { type: "string", description: "Explicación breve de por qué se necesita el dato." },
        },
        required: ["kind", "field_name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_fill_secret",
      description: "Rellena un campo sin exponer el valor al LLM. Usa secret_ref para OTP/secretos de un solo uso o credential_ref para inyectar la contraseña de una credencial temporal/persistente en un formulario que browser_auth_login no pueda manejar automáticamente.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          secret_ref: { type: "string", description: "Referencia browser-secret-* para OTP u otro secreto temporal." },
          credential_ref: { type: "string", description: "Referencia browser-cred-* o browser-profile-* cuya contraseña debe inyectarse sin revelarla al agente." },
        },
        required: ["selector"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_auth_confirm",
      description: "Confirma que un login manual realizado con credential_ref tuvo éxito y guarda/reemplaza la credencial de forma cifrada para futuras reautenticaciones. Llámala solo después de verificar que ya se accedió a la cuenta.",
      parameters: {
        type: "object",
        properties: { credential_ref: { type: "string" } },
        required: ["credential_ref"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_auth_login",
      description: "Inicia sesión con una credencial temporal o un perfil cifrado guardado por el sistema. Puedes pasar credential_ref directamente, o url+username para que el sistema resuelva una cuenta persistente. La contraseña nunca se entrega al LLM.",
      parameters: {
        type: "object",
        properties: {
          credential_ref: { type: "string", description: "Referencia browser-cred-* temporal o browser-profile-* persistente." },
          url: { type: "string", description: "URL/dominio para buscar una credencial persistente cuando no hay referencia." },
          username: { type: "string", description: "Correo/usuario para seleccionar una cuenta persistente concreta." },
        },
        additionalProperties: false,
      },
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
