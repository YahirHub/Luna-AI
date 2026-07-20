import type { ToolDefinition } from "./ai.ts";

/**
 * Herramientas de control disponibles para cualquier usuario autenticado.
 * Son equivalentes naturales de comandos existentes; no exponen parámetros
 * internos de resiliencia, reintentos o backoff.
 */
export const USER_CONTROL_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "control_help",
      description:
        "Muestra las capacidades y comandos disponibles para el usuario actual. Úsala cuando pregunte qué puedes hacer, qué comandos hay o pida ayuda del bot.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "control_ping",
      description: "Comprueba que Luna está respondiendo. Equivale al comando ping.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "control_get_id",
      description: "Devuelve el identificador JID del usuario actual.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "control_cancel",
      description:
        "Cancela la operación interactiva o tarea activa del usuario: subagentes, configuración de proveedor, búsqueda, agente, Whisper o selección de modelo.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "conversation_clear",
      description:
        "Reinicia el historial de conversación del usuario, conservando su memoria persistente y workdir. Úsala solo cuando el usuario pida explícitamente limpiar, borrar o reiniciar la conversación.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "account_password_change_start",
      description:
        "Inicia el cambio seguro de contraseña de la cuenta autenticada. Úsala cuando el usuario pida cambiar su propia contraseña pero no haya incluido la nueva contraseña en el mismo mensaje. La contraseña se capturará en el siguiente mensaje fuera del LLM.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "model_status",
      description: "Consulta el modelo LLM global activo actualmente para todos los chats.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "model_list",
      description:
        "Actualiza y lista los modelos disponibles del proveedor LLM activo, indicando el modelo global actualmente seleccionado.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "model_set",
      description:
        "Cambia el modelo LLM global para todos los chats, tareas y subagentes. Usa model_list si no conoces el ID exacto o si el nombre solicitado es ambiguo.",
      parameters: {
        type: "object",
        properties: {
          model_id: { type: "string", description: "ID exacto del modelo disponible." },
        },
        required: ["model_id"],
        additionalProperties: false,
      },
    },
  },
];

/** Herramientas naturales equivalentes a comandos globales solo de administrador. */
export const ADMIN_CONTROL_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "llm_provider_status",
      description:
        "Consulta el proveedor LLM global activo, sus endpoints y modelo predeterminado sin revelar la API key.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "llm_provider_use_opencode_free",
      description:
        "Restaura el proveedor integrado OpenCode Free y elimina la configuración personalizada. Úsala solo cuando el administrador lo pida explícitamente.",
      parameters: {
        type: "object",
        properties: { confirmed: { type: "boolean", description: "Debe ser true tras una petición explícita del administrador." } },
        required: ["confirmed"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "llm_provider_start_setup",
      description:
        "Inicia el mismo flujo seguro de /setup-provider para configurar o reemplazar el proveedor LLM global. La API key se solicitará después en un mensaje separado y no debe incluirse como argumento.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "search_admin_status",
      description:
        "Consulta los motores de búsqueda configurados, cuáles están activos, el predeterminado, el orden de fallback y el resultado de la última prueba, sin revelar API keys.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "search_admin_set_enabled",
      description: "Activa o desactiva un motor de búsqueda ya configurado.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["tavily", "brave", "exa", "linkup", "firecrawl", "serpapi", "zenserp"] },
          enabled: { type: "boolean" },
        },
        required: ["provider", "enabled"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_admin_set_default",
      description: "Establece el motor de búsqueda predeterminado. Debe tener API key y estar activo.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["tavily", "brave", "exa", "linkup", "firecrawl", "serpapi", "zenserp"] },
        },
        required: ["provider"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_admin_set_fallback_order",
      description:
        "Cambia el orden de fallback de los motores de búsqueda. Indica los IDs en el orden deseado; los proveedores omitidos se colocan después conservando el orden predeterminado.",
      parameters: {
        type: "object",
        properties: {
          providers: {
            type: "array",
            items: { type: "string", enum: ["tavily", "brave", "exa", "linkup", "firecrawl", "serpapi", "zenserp"] },
            minItems: 1,
          },
        },
        required: ["providers"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_admin_test",
      description: "Prueba la conexión de un motor de búsqueda específico o de todos los motores activos.",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "ID del motor o 'all' para probar todos los activos.",
            enum: ["all", "tavily", "brave", "exa", "linkup", "firecrawl", "serpapi", "zenserp"],
          },
        },
        required: ["provider"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_admin_start_set_api_key",
      description:
        "Inicia un flujo seguro para configurar o reemplazar la API key de un motor de búsqueda. La clave se pedirá en el siguiente mensaje y nunca debe incluirse como argumento de esta herramienta.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["tavily", "brave", "exa", "linkup", "firecrawl", "serpapi", "zenserp"] },
        },
        required: ["provider"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_admin_remove_api_key",
      description:
        "Elimina la API key guardada de un motor y lo desactiva. Es destructiva y requiere petición explícita del administrador.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["tavily", "brave", "exa", "linkup", "firecrawl", "serpapi", "zenserp"] },
          confirmed: { type: "boolean" },
        },
        required: ["provider", "confirmed"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_config_status",
      description:
        "Consulta la configuración global equivalente a /config: acceso web, subagente investigador, profundidad predeterminada y timeout de seguridad del investigador.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_config_update",
      description:
        "Actualiza por lenguaje natural una o varias opciones de /config. No controla reintentos ni parámetros internos de resiliencia.",
      parameters: {
        type: "object",
        properties: {
          web_search_enabled: { type: "boolean" },
          research_subagent_enabled: { type: "boolean" },
          default_search_depth: { type: "string", enum: ["standard", "deep"] },
          researcher_timeout_minutes: { type: "integer", enum: [5, 10, 15, 30] },
        },
        additionalProperties: false,
      },
    },
  },
];

export const CONTROL_TOOLS: ToolDefinition[] = [
  ...USER_CONTROL_TOOLS,
  ...ADMIN_CONTROL_TOOLS,
];
