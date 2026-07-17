import type { ToolDefinition } from "./ai.ts";
import type { AuthManager } from "./auth.ts";
import {
  WHISPER_MODEL_CATALOG,
  deleteDownloadedWhisperModelsExcept,
  downloadWhisperModel,
  getWhisperModel,
  isWhisperModelAvailable,
  loadWhisperConfig,
  saveWhisperConfig,
  type WhisperConfig,
  type WhisperDownloadProgress,
} from "./whisper-config.ts";

export const USER_ADMIN_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "admin_list_users",
      description:
        "Lista las cuentas registradas, su rol, estado de bloqueo y sesión. Solo está disponible para administradores autenticados.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "admin_start_add_user",
      description:
        "Inicia de forma segura la creación de una cuenta de usuario. No recibe la contraseña: después de esta llamada el sistema se la pedirá al administrador en un mensaje separado.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "Nombre de usuario nuevo; solo letras, números y guion bajo.",
          },
        },
        required: ["username"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "admin_ban_user",
      description:
        "Bloquea una cuenta existente y cierra sus sesiones. Nunca la uses contra la propia cuenta administradora activa.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "Usuario que se bloqueará." },
        },
        required: ["username"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "admin_unban_user",
      description: "Desbloquea una cuenta existente.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "Usuario que se desbloqueará." },
        },
        required: ["username"],
        additionalProperties: false,
      },
    },
  },
];

export const WHISPER_ADMIN_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "whisper_status",
      description:
        "Consulta la configuración global actual de Whisper y si el modelo activo está disponible localmente.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "whisper_list_models",
      description:
        "Lista los modelos oficiales de whisper.cpp con tamaño, idioma y estado local. Úsala antes de recomendar o seleccionar un modelo.",
      parameters: {
        type: "object",
        properties: {
          only_available: {
            type: "boolean",
            description: "Si es true, muestra únicamente modelos ya disponibles localmente.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "whisper_update_config",
      description:
        "Actualiza uno o varios parámetros globales de Whisper. Solo puede activar un modelo que ya esté disponible; si falta, usa whisper_download_model después de una petición o confirmación explícita del administrador.",
      parameters: {
        type: "object",
        properties: {
          model_id: { type: "string", description: "ID exacto del modelo ya disponible." },
          language: { type: "string", description: "Código ISO, auto o en." },
          translate_to_english: { type: "boolean" },
          threads: { type: "number", description: "0 automático o 1-32." },
          best_of: { type: "number", description: "1-10." },
          beam_size: { type: "number", description: "1-10." },
          temperature: { type: "number", description: "0-1." },
          no_speech_threshold: { type: "number", description: "0-1." },
          max_audio_seconds: { type: "number", description: "30-600." },
          timeout_seconds: { type: "number", description: "60-3600." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "whisper_download_model",
      description:
        "Descarga un modelo oficial y opcionalmente lo activa. Llámala únicamente cuando el administrador haya pedido explícitamente la descarga o haya confirmado el tamaño; confirmed debe ser true.",
      parameters: {
        type: "object",
        properties: {
          model_id: { type: "string", description: "ID exacto del catálogo oficial." },
          activate: { type: "boolean", description: "Activa el modelo al terminar; predeterminado true." },
          confirmed: { type: "boolean", description: "Debe ser true tras consentimiento explícito del administrador." },
        },
        required: ["model_id", "confirmed"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "whisper_cleanup_models",
      description:
        "Elimina modelos descargados que no estén activos. Es destructiva y solo debe llamarse con confirmación explícita; confirmed debe ser true.",
      parameters: {
        type: "object",
        properties: {
          confirmed: { type: "boolean" },
        },
        required: ["confirmed"],
        additionalProperties: false,
      },
    },
  },
];

export const ADMIN_TOOLS: ToolDefinition[] = [
  ...USER_ADMIN_TOOLS,
  ...WHISPER_ADMIN_TOOLS,
];

function formatWhisperConfig(config: WhisperConfig): string {
  const model = getWhisperModel(config.modelId);
  return [
    "🎙️ CONFIGURACIÓN GLOBAL DE WHISPER",
    `Modelo: ${config.modelId} (${model?.displaySize ?? "tamaño desconocido"})`,
    `Disponible: ${isWhisperModelAvailable(config.modelId) ? "sí" : "no"}`,
    `Idioma: ${config.language}`,
    `Traducir al inglés: ${config.translateToEnglish ? "sí" : "no"}`,
    `Hilos: ${config.threads === 0 ? "automático" : config.threads}`,
    `Best-of: ${config.bestOf}`,
    `Beam size: ${config.beamSize}`,
    `Temperatura: ${config.temperature}`,
    `Umbral sin voz: ${config.noSpeechThreshold}`,
    `Duración máxima: ${config.maxAudioSeconds} segundos`,
    `Timeout: ${config.timeoutSeconds} segundos`,
  ].join("\n");
}

function normalizeUsernameArg(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function executeUserAdminTool(
  toolName: string,
  args: Record<string, unknown>,
  authManager: AuthManager,
  adminJid: string,
): Promise<string> {
  const currentUsername = authManager.getUsername(adminJid);
  if (!currentUsername || !authManager.isAdmin(currentUsername)) {
    return "Error: esta herramienta requiere una sesión administradora activa.";
  }

  switch (toolName) {
    case "admin_list_users": {
      const users = authManager.getUserList();
      if (users.length === 0) return "No hay usuarios registrados.";
      const lines = users.map((user, index) => {
        const role = user.role === "admin" ? "administrador" : "usuario";
        const status = user.banned
          ? "baneado"
          : authManager.getJid(user.username)
            ? "en línea"
            : "desconectado";
        return `${index + 1}. ${user.username} — ${role} — ${status}`;
      });
      return `👥 USUARIOS REGISTRADOS\n${lines.join("\n")}`;
    }

    case "admin_start_add_user": {
      const username = normalizeUsernameArg(args.username);
      if (!username || username.length < 2 || !/^[a-z0-9_]+$/.test(username)) {
        return "Error: el nombre debe tener al menos 2 caracteres y usar solo letras, números o guion bajo.";
      }
      if (authManager.findUser(username)) {
        return `Error: el usuario '${username}' ya existe.`;
      }
      authManager.setPendingAction(adminJid, {
        type: "adduser",
        step: "awaiting-password",
        username,
      });
      return `✅ Flujo seguro iniciado para crear '${username}'. El sistema pedirá ahora la contraseña en un mensaje separado; la cuenta todavía no existe.`;
    }

    case "admin_ban_user": {
      const username = normalizeUsernameArg(args.username);
      if (!username) return "Error: indica el usuario que deseas bloquear.";
      if (username === currentUsername) return "Error: no puedes bloquear tu propia cuenta administradora activa.";
      const user = authManager.findUser(username);
      if (!user) return `Error: el usuario '${username}' no existe.`;
      if (user.banned) return `Error: el usuario '${username}' ya está bloqueado.`;
      authManager.banUser(username);
      return `✅ Usuario '${username}' bloqueado y sesiones cerradas.`;
    }

    case "admin_unban_user": {
      const username = normalizeUsernameArg(args.username);
      if (!username) return "Error: indica el usuario que deseas desbloquear.";
      const user = authManager.findUser(username);
      if (!user) return `Error: el usuario '${username}' no existe.`;
      if (!user.banned) return `Error: el usuario '${username}' no está bloqueado.`;
      authManager.unbanUser(username);
      return `✅ Usuario '${username}' desbloqueado.`;
    }

    default:
      return `Error: herramienta administrativa desconocida '${toolName}'.`;
  }
}

function assignIfDefined<T extends keyof WhisperConfig>(
  patch: Partial<WhisperConfig>,
  key: T,
  value: unknown,
): void {
  if (value !== undefined) {
    patch[key] = value as WhisperConfig[T];
  }
}

export async function executeWhisperAdminTool(
  toolName: string,
  args: Record<string, unknown>,
  onProgress?: (progress: WhisperDownloadProgress) => void | Promise<void>,
): Promise<string> {
  switch (toolName) {
    case "whisper_status":
      return formatWhisperConfig(loadWhisperConfig());

    case "whisper_list_models": {
      const onlyAvailable = args.only_available === true;
      const models = WHISPER_MODEL_CATALOG.filter(
        (entry) => !onlyAvailable || isWhisperModelAvailable(entry.id),
      );
      if (models.length === 0) return "No hay modelos Whisper disponibles localmente.";
      const lines = models.map((entry, index) => {
        const language = entry.multilingual ? "multilingüe" : "solo inglés";
        const status = isWhisperModelAvailable(entry.id) ? "disponible" : "no descargado";
        const notes = entry.notes ? ` · ${entry.notes}` : "";
        return `${index + 1}. ${entry.id} — ${entry.displaySize} — ${language} — ${status}${notes}`;
      });
      return `📦 MODELOS WHISPER\n${lines.join("\n")}`;
    }

    case "whisper_update_config": {
      const current = loadWhisperConfig();
      const patch: Partial<WhisperConfig> = {};
      if (args.model_id !== undefined) {
        const modelId = typeof args.model_id === "string" ? args.model_id.trim() : "";
        if (!getWhisperModel(modelId)) return `Error: modelo Whisper desconocido '${modelId}'.`;
        if (!isWhisperModelAvailable(modelId)) {
          return `Error: el modelo '${modelId}' no está disponible. Consulta su tamaño y descárgalo con whisper_download_model después de una confirmación explícita.`;
        }
        patch.modelId = modelId;
      }
      assignIfDefined(patch, "language", args.language);
      assignIfDefined(patch, "translateToEnglish", args.translate_to_english);
      assignIfDefined(patch, "threads", args.threads);
      assignIfDefined(patch, "bestOf", args.best_of);
      assignIfDefined(patch, "beamSize", args.beam_size);
      assignIfDefined(patch, "temperature", args.temperature);
      assignIfDefined(patch, "noSpeechThreshold", args.no_speech_threshold);
      assignIfDefined(patch, "maxAudioSeconds", args.max_audio_seconds);
      assignIfDefined(patch, "timeoutSeconds", args.timeout_seconds);
      if (Object.keys(patch).length === 0) {
        return "Error: no se recibió ningún parámetro de Whisper para actualizar.";
      }
      const saved = saveWhisperConfig({ ...current, ...patch });
      return `✅ Configuración global de Whisper actualizada.\n${formatWhisperConfig(saved)}`;
    }

    case "whisper_download_model": {
      const modelId = typeof args.model_id === "string" ? args.model_id.trim() : "";
      const definition = getWhisperModel(modelId);
      if (!definition) return `Error: modelo Whisper desconocido '${modelId}'.`;
      if (args.confirmed !== true) {
        return `Error: falta confirmación explícita para descargar ${modelId} (${definition.displaySize}).`;
      }
      if (!isWhisperModelAvailable(modelId)) {
        await downloadWhisperModel(modelId, onProgress);
      }
      const activate = args.activate !== false;
      if (!activate) {
        return `✅ Modelo Whisper ${modelId} disponible localmente; no se cambió el modelo activo.`;
      }
      const current = loadWhisperConfig();
      const saved = saveWhisperConfig({
        ...current,
        modelId,
        language: definition.multilingual ? current.language : "en",
      });
      return `✅ Modelo Whisper ${modelId} descargado y activado globalmente.\n${formatWhisperConfig(saved)}`;
    }

    case "whisper_cleanup_models": {
      if (args.confirmed !== true) {
        return "Error: falta confirmación explícita para eliminar modelos descargados.";
      }
      const current = loadWhisperConfig();
      const deleted = deleteDownloadedWhisperModelsExcept(current.modelId);
      return `✅ Limpieza completada: ${deleted} modelo(s) inactivo(s) eliminado(s). El modelo activo ${current.modelId} se conservó.`;
    }

    default:
      return `Error: herramienta Whisper desconocida '${toolName}'.`;
  }
}
