import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import {
  registerCommand,
  getCommands,
  parseCommand,
  dispatchCommand,
  isPositiveInteger,
} from "./commands.ts";
import { downloadAndSaveImage } from "./media.ts";
import { fetchFreeModels, chatCompletion, chatCompletionWithTools } from "./ai.ts";
import type { AiConfig } from "./ai.ts";
import { ContextManager } from "./context.ts";
import { AuthManager } from "./auth.ts";
import type { PendingAction } from "./auth.ts";
import {
  MemoryManager,
  MEMORY_TOOLS,
  executeMemoryTool,
} from "./memory.ts";
import {
  ReminderManager,
  REMINDER_TOOLS,
  executeReminderTool,
} from "./reminder.ts";

// ─── Estado global ───────────────────────────────────────────────

let aiConfig: AiConfig | null = null;
let contextManager: ContextManager | null = null;

/** Lista de modelos -free disponibles actualmente. */
let availableModels: string[] = [];

/** Gestor de autenticación y sesiones de usuario. */
const authManager = new AuthManager();

/** Gestor de memoria persistente del bot (por usuario). */
const memoryManager = new MemoryManager();

/** Gestor de recordatorios. */
const reminderManager = new ReminderManager();

/** Tools combinadas (memoria + recordatorios). */
const ALL_TOOLS = [...MEMORY_TOOLS, ...REMINDER_TOOLS];

/** Inicializa el módulo AI con la configuración. */
export function initAi(config: AiConfig): void {
  aiConfig = config;
  contextManager = new ContextManager("");
  contextManager.setMemoryManager(memoryManager);

  // Iniciar verificador de recordatorios
  reminderManager.startChecker(onReminderDue);

  fetchFreeModels(config)
    .then((models) => {
      availableModels = models;
      if (models.length > 0 && models[0] && contextManager) {
        contextManager.setDefaultModel(models[0]);
      }
    })
    .catch(() => {
      // Fallo silencioso — el usuario podrá recargar con !modelos
    });
}

/**
 * Actualiza la referencia al socket activo.
 * Se llama desde connection.ts cuando el socket se conecta/reconecta.
 */
export function setSocket(sock: WASocket): void {
  reminderManager.setSock(sock);
}

/** Callback cuando un recordatorio debe dispararse. */
async function onReminderDue(
  reminder: import("./reminder.ts").Reminder,
  sock: WASocket | null,
): Promise<void> {
  if (!sock || !aiConfig || !contextManager) {
    console.warn("[reminder] No se puede disparar: sock/aiConfig/contextManager no disponible");
    return;
  }

  const model = contextManager.getModel(reminder.jid);
  const memory = memoryManager.getContent(reminder.jid);

  // Hora actual real en CDMX (no la hora programada)
  const nowCDMX = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

  // Construir mensaje para la API pidiendo que prepare el recordatorio
  const reminderMessages: import("./ai.ts").ChatMessage[] = [
    {
      role: "system",
      content: [
        "Eres Luna, una amiga virtual mexicana.",
        "",
        `Hoy es ${nowCDMX}.`,
        "",
        "=== LO QUE RECUERDO DE ESTA PERSONA ===",
        memory || "No hay informacion guardada aun.",
        "=== FIN DE MI MEMORIA ===",
        "",
        "PREPARA UN MENSAJE CORTO Y AMIGABLE PARA RECORDARLE ALGO IMPORTANTE.",
        "Usa emojis, se cálida, como una amiga recordando algo.",
        "⚠️ NO uses Markdown. NO uses # ni ** ni * ni `.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `Es hora de recordar: ${reminder.text}`,
    },
  ];

  try {
    const response = await chatCompletion(reminderMessages, model, aiConfig);

    const finalText = `⏰ RECORDATORIO\n\n${response}`;

    // Simular escritura
    await sock.sendPresenceUpdate("composing", reminder.jid).catch(() => {});
    const delayMs = 2000 + Math.floor(Math.random() * 2000);
    await new Promise<void>((r) => setTimeout(r, delayMs));

    await sock.sendMessage(reminder.jid, { text: finalText });
    await sock.sendPresenceUpdate("paused", reminder.jid).catch(() => {});

    console.log(
      `[reminder] Recordatorio disparado para ${reminder.jid}: "${reminder.text}"`,
    );
  } catch (err) {
    console.error("[reminder] Error al enviar recordatorio via AI:", err);
    // Fallback: enviar texto plano con typing
    try {
      await sock.sendPresenceUpdate("composing", reminder.jid).catch(() => {});
      const delayMs = 2000 + Math.floor(Math.random() * 2000);
      await new Promise<void>((r) => setTimeout(r, delayMs));
      await sock.sendMessage(reminder.jid, {
        text: `⏰ RECORDATORIO\n\n${reminder.text}`,
      });
      await sock.sendPresenceUpdate("paused", reminder.jid).catch(() => {});
    } catch (sendErr) {
      console.error("[reminder] Error al enviar recordatorio fallback:", sendErr);
    }
  }
}

// ─── Simulación de escritura ─────────────────────────────────────

/**
 * Envía un mensaje de texto con simulación de "escribiendo...".
 * Retardo aleatorio de 3 a 5 segundos antes de enviar.
 */
async function sendWithTyping(
  sock: WASocket,
  jid: string,
  text: string,
): Promise<void> {
  await sock.sendPresenceUpdate("composing", jid).catch(() => {});
  const delay = 3000 + Math.floor(Math.random() * 2000); // 3–5 segundos
  await new Promise((r) => setTimeout(r, delay));
  await sock.sendMessage(jid, { text });
  await sock.sendPresenceUpdate("paused", jid).catch(() => {});
}

// ─── Registro de comandos ────────────────────────────────────────

registerCommand(
  "ayuda",
  "Muestra todos los comandos disponibles",
  () => {
    const cmds = getCommands();
    const lista = cmds
      .map((c) => `!${c.name} — ${c.description}`)
      .join("\n");

    return {
      text: [
        "🤖 COMANDOS DISPONIBLES",
        "",
        lista,
        "",
        "💬 También puedes hablarme directamente.",
        "   ¡Recuerdo la conversación!",
      ].join("\n"),
    };
  },
);

registerCommand(
  "ping",
  "Responde con pong",
  () => ({
    text: "🏓 pong",
  }),
);

registerCommand(
  "id",
  "Muestra tu identificador (JID)",
  (_cmd, senderJid) => ({
    text: `🆔 Tu JID: ${senderJid}`,
  }),
);

registerCommand(
  "cancelar",
  "Cancela la operación actual (selección de modelo, etc.)",
  (_cmd, senderJid) => {
    if (contextManager?.isAwaitingModelSelection(senderJid)) {
      contextManager.clearAwaitingModelSelection(senderJid);
      return { text: "❌ Selección de modelo cancelada." };
    }
    return { text: "❌ Operación cancelada." };
  },
);

registerCommand(
  "clear",
  "Reinicia la conversación borrando todo el historial",
  (_cmd, senderJid) => {
    contextManager?.clearConversation(senderJid);
    return { text: "🧹 Conversación reiniciada. Empezamos de cero." };
  },
);

registerCommand(
  "modelos",
  "Lista los modelos -free disponibles y permite seleccionar uno",
  async (_cmd, senderJid, _sock) => {
    if (!aiConfig) {
      return { text: "⚠️ El proveedor AI no está configurado." };
    }

    try {
      availableModels = await fetchFreeModels(aiConfig);
    } catch (err: unknown) {
      return {
        text: `❌ Error al obtener modelos: ${err instanceof Error ? err.message : "desconocido"}`,
      };
    }

    if (availableModels.length === 0) {
      return {
        text: "❌ No se encontraron modelos -free en el proveedor.",
      };
    }

    contextManager?.setAwaitingModelSelection(senderJid);

    // Mostrar modelos sin el sufijo "-free"
    const displayModels = availableModels.map((m) =>
      m.endsWith("-free") ? m.slice(0, -5) : m,
    );
    const list = displayModels
      .map((name, i) => `${i + 1}. ${name}`)
      .join("\n");
    const currentRaw = contextManager?.getModel(senderJid) ?? "";
    const currentDisplay = currentRaw.endsWith("-free")
      ? currentRaw.slice(0, -5)
      : currentRaw || "ninguno";

    return {
      text: [
        "📋 MODELOS DISPONIBLES",
        "",
        list,
        "",
        `📌 Actual: ${currentDisplay}`,
        "",
        "✏️ Responde con el NUMERO del modelo que quieras usar.",
      ].join("\n"),
    };
  },
);

// ─── Comandos de autenticación ────────────────────────────────────

registerCommand(
  "setup",
  "Crea la primera cuenta de administrador del bot",
  async (_cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu JID." };
    }
    if (authManager.userExists()) {
      return { text: "⚠️ Ya existe una cuenta de administrador. Usa !login para iniciar sesión." };
    }
    authManager.setPendingAction(senderJid, { type: "setup", step: "awaiting-username" });
    return {
      text: [
        "🛠️ CREAR CUENTA DE ADMINISTRADOR",
        "",
        "Ingresa el nombre de usuario para el administrador:",
      ].join("\n"),
    };
  },
);

registerCommand(
  "login",
  "Inicia sesión en el bot",
  async (_cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu JID." };
    }
    if (authManager.isLoggedIn(senderJid)) {
      const loggedUsername = authManager.getUsername(senderJid);
      return { text: `⚠️ Ya has iniciado sesión como ${loggedUsername ?? "desconocido"}.` };
    }
    authManager.setPendingAction(senderJid, { type: "login", step: "awaiting-username" });
    return {
      text: [
        "🔑 INICIO DE SESIÓN",
        "",
        "Ingresa tu nombre de usuario:",
      ].join("\n"),
    };
  },
);

registerCommand(
  "adduser",
  "Crea un nuevo usuario (solo administrador)",
  async (_cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu JID." };
    }
    const adjUsername = authManager.getUsername(senderJid);
    if (!adjUsername || !authManager.isAdmin(adjUsername)) {
      return { text: "⚠️ Solo el administrador puede crear usuarios." };
    }
    authManager.setPendingAction(senderJid, { type: "adduser", step: "awaiting-username" });
    return {
      text: [
        "👤 CREAR NUEVO USUARIO",
        "",
        "Ingresa el nombre de usuario para el nuevo usuario:",
      ].join("\n"),
    };
  },
);

registerCommand(
  "banuser",
  "Bloquea el acceso de un usuario (solo administrador)",
  async (cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu JID." };
    }
    const adjUsername = authManager.getUsername(senderJid);
    if (!adjUsername || !authManager.isAdmin(adjUsername)) {
      return { text: "⚠️ Solo el administrador puede banear usuarios." };
    }
    const target = cmd.args[0]?.toLowerCase();
    if (!target) {
      return { text: "⚠️ Uso: !banuser nombredeusuario" };
    }
    if (!authManager.findUser(target)) {
      return { text: `❌ Usuario '${target}' no encontrado.` };
    }
    if (target === adjUsername) {
      return { text: "⚠️ No puedes banearte a ti mismo." };
    }
    authManager.banUser(target);
    return { text: `🚫 Usuario ${target} ha sido baneado.` };
  },
);

registerCommand(
  "desban",
  "Desbloquea el acceso de un usuario (solo administrador)",
  async (cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu JID." };
    }
    const adjUsername = authManager.getUsername(senderJid);
    if (!adjUsername || !authManager.isAdmin(adjUsername)) {
      return { text: "⚠️ Solo el administrador puede desbanear usuarios." };
    }
    const target = cmd.args[0]?.toLowerCase();
    if (!target) {
      return { text: "⚠️ Uso: !desban nombredeusuario" };
    }
    if (!authManager.findUser(target)) {
      return { text: `❌ Usuario '${target}' no encontrado.` };
    }
    authManager.unbanUser(target);
    return { text: `✅ Usuario ${target} ha sido desbaneado.` };
  },
);

registerCommand(
  "userlist",
  "Muestra todos los usuarios registrados (solo administrador)",
  async (_cmd, senderJid) => {
    if (senderJid == null) {
      return { text: "❌ Error: no se pudo identificar tu JID." };
    }
    const ulUsername = authManager.getUsername(senderJid);
    if (!ulUsername || !authManager.isAdmin(ulUsername)) {
      return { text: "⚠️ Solo el administrador puede ver la lista de usuarios." };
    }
    const users = authManager.getUserList();
    if (users.length === 0) {
      return { text: "👥 No hay usuarios registrados." };
    }
    const lines = users.map((u, i) => {
      const roleIcon = u.role === "admin" ? "👑" : "👤";
      const roleName = u.role === "admin" ? "Administrador" : "Usuario";
      const jidOfUser = authManager.getJid(u.username);
      const status = u.banned
        ? "🔴 Baneado"
        : jidOfUser
          ? "🟢 En línea"
          : "⚪ Desconectado";
      return `${i + 1}. ${u.username} — ${roleIcon} ${roleName} — ${status}`;
    });
    return {
      text: ["👥 USUARIOS REGISTRADOS", "", ...lines].join("\n"),
    };
  },
);

// ─── Procesamiento de flujo interactivo de auth ─────────────────

/**
 * Procesa la entrada del usuario durante un flujo interactivo
 * de autenticación (login, setup, adduser).
 */
async function handlePendingAuthAction(
  sock: WASocket,
  jid: string,
  text: string,
): Promise<void> {
  const action = authManager.getPendingAction(jid);
  if (!action) return;

  switch (action.type) {
    case "setup":
      await handleSetupStep(sock, jid, text, action);
      break;
    case "login":
      await handleLoginStep(sock, jid, text, action);
      break;
    case "adduser":
      await handleAdduserStep(sock, jid, text, action);
      break;
  }
}

async function handleSetupStep(
  sock: WASocket,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  if (action.step === "awaiting-username") {
    const username = text.trim().toLowerCase();
    if (!username || username.length < 2 || !/^[a-z0-9_]+$/.test(username)) {
      await sendWithTyping(
        sock,
        jid,
        "❌ Nombre de usuario inválido. Usa solo letras, números y guion bajo (mín 2 caracteres).\n\nIntenta de nuevo:",
      );
      return;
    }
    if (authManager.findUser(username)) {
      await sendWithTyping(
        sock,
        jid,
        "❌ Ese nombre de usuario ya existe. Elige otro:",
      );
      return;
    }
    authManager.setPendingAction(jid, {
      type: "setup",
      step: "awaiting-password",
      username,
    });
    await sendWithTyping(sock, jid, `Ingresa la contraseña para ${username}:`);
    return;
  }

  // step === "awaiting-password"
  const password = text.trim();
  if (!password || password.length < 4) {
    await sendWithTyping(
      sock,
      jid,
      "❌ La contraseña debe tener al menos 4 caracteres.\n\nIntenta de nuevo:",
    );
    return;
  }
  const setupUsername = action.username;
  if (!setupUsername) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(sock, jid, "❌ Error interno. Intenta de nuevo con !setup.");
    return;
  }
  await authManager.createAdmin(setupUsername, password);
  await authManager.login(jid, setupUsername, password);
  authManager.clearPendingAction(jid);
  await sendWithTyping(
    sock,
    jid,
    `✅ Cuenta de administrador creada exitosamente. Bienvenido, ${setupUsername}.`,
  );
}

async function handleLoginStep(
  sock: WASocket,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  if (action.step === "awaiting-username") {
    const username = text.trim().toLowerCase();
    const user = authManager.findUser(username);
    if (!user) {
      await sendWithTyping(
        sock,
        jid,
        "❌ Usuario no encontrado. Intenta de nuevo:",
      );
      return;
    }
    if (user.banned) {
      authManager.clearPendingAction(jid);
      await sendWithTyping(
        sock,
        jid,
        "🚫 Tu cuenta ha sido baneada. Contacta al administrador.",
      );
      return;
    }
    authManager.setPendingAction(jid, {
      type: "login",
      step: "awaiting-password",
      username,
    });
    await sendWithTyping(sock, jid, "Ingresa tu contraseña:");
    return;
  }

  // step === "awaiting-password"
  const password = text.trim();
  const loginUsername = action.username;
  if (!loginUsername) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(sock, jid, "❌ Error interno. Intenta de nuevo con !login.");
    return;
  }
  // Verificar si fue baneado entre el paso de usuario y contraseña
  const userCheck = authManager.findUser(loginUsername);
  if (userCheck?.banned) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(
      sock,
      jid,
      "🚫 Tu cuenta ha sido baneada durante el inicio de sesión. Contacta al administrador.",
    );
    return;
  }
  const success = await authManager.login(jid, loginUsername, password);
  if (success) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(
      sock,
      jid,
      `✅ Inicio de sesión exitoso. Bienvenido, ${loginUsername}.`,
    );
  } else {
    await sendWithTyping(
      sock,
      jid,
      "❌ Contraseña incorrecta. Intenta de nuevo:",
    );
  }
}

async function handleAdduserStep(
  sock: WASocket,
  jid: string,
  text: string,
  action: PendingAction,
): Promise<void> {
  if (action.step === "awaiting-username") {
    const username = text.trim().toLowerCase();
    if (!username || username.length < 2 || !/^[a-z0-9_]+$/.test(username)) {
      await sendWithTyping(
        sock,
        jid,
        "❌ Nombre de usuario inválido. Usa solo letras, números y guion bajo (mín 2 caracteres).\n\nIntenta de nuevo:",
      );
      return;
    }
    if (authManager.findUser(username)) {
      await sendWithTyping(
        sock,
        jid,
        "❌ Ese nombre de usuario ya existe. Elige otro:",
      );
      return;
    }
    authManager.setPendingAction(jid, {
      type: "adduser",
      step: "awaiting-password",
      username,
    });
    await sendWithTyping(sock, jid, `Ingresa la contraseña para ${username}:`);
    return;
  }

  // step === "awaiting-password"
  const password = text.trim();
  if (!password || password.length < 4) {
    await sendWithTyping(
      sock,
      jid,
      "❌ La contraseña debe tener al menos 4 caracteres.\n\nIntenta de nuevo:",
    );
    return;
  }
  const addUsername = action.username;
  if (!addUsername) {
    authManager.clearPendingAction(jid);
    await sendWithTyping(sock, jid, "❌ Error interno. Intenta de nuevo con !adduser.");
    return;
  }
  await authManager.addUser(addUsername, password, "user");
  authManager.clearPendingAction(jid);
  await sendWithTyping(
    sock,
    jid,
    `✅ Usuario ${addUsername} creado exitosamente.`,
  );
}

// ─── Procesamiento de mensajes ───────────────────────────────────

export async function handleMessage(
  sock: WASocket,
  message: WAMessage,
): Promise<void> {
  const key = message.key;
  const remoteJid = key.remoteJid;
  const fromMe = key.fromMe;

  if (!remoteJid || fromMe) {
    return;
  }

  // Marcar como leído (2 palomitas azules) inmediatamente
  void sock.readMessages([key]).catch(() => {});

  const text =
    message.message?.conversation ??
    message.message?.extendedTextMessage?.text ??
    "";

  if (!text) {
    await handleMediaMessage(sock, message, remoteJid);
    return;
  }

  // ── Parsear comando ──────────────────────────────────────────────
  const command = parseCommand(text);

  // ── Acción pendiente de auth ─────────────────────────────────────
  const pendingAction = authManager.getPendingAction(remoteJid);
  if (pendingAction) {
    if (command && command.name === "cancelar") {
      authManager.clearPendingAction(remoteJid);
      contextManager?.clearAwaitingModelSelection(remoteJid);
      await sendWithTyping(sock, remoteJid, "❌ Operación cancelada.");
      return;
    }
    if (command) {
      // Envió un comando durante flujo — cancelar pending y seguir
      authManager.clearPendingAction(remoteJid);
    } else {
      await handlePendingAuthAction(sock, remoteJid, text);
      return;
    }
  }

  // ── Puerta de autenticación ─────────────────────────────────────
  if (!authManager.userExists()) {
    if (!(command && ["setup", "cancelar"].includes(command.name))) {
      await sendWithTyping(
        sock,
        remoteJid,
        "🔒 No hay cuentas de administrador. Envía !setup para crear la primera.",
      );
      return;
    }
  } else if (!authManager.isLoggedIn(remoteJid)) {
    if (!(command && ["login", "cancelar"].includes(command.name))) {
      await sendWithTyping(
        sock,
        remoteJid,
        "🔒 Debes iniciar sesión primero. Envía !login",
      );
      return;
    }
  } else {
    // Logueado — verificar si fue baneado durante la sesión
    const sessionUsername = authManager.getUsername(remoteJid);
    if (sessionUsername) {
      const userRecord = authManager.findUser(sessionUsername);
      if (userRecord?.banned) {
        authManager.logout(remoteJid);
        await sendWithTyping(
          sock,
          remoteJid,
          "🚫 Tu cuenta ha sido baneada. Contacta al administrador.",
        );
        return;
      }
    }
  }

  // ── Verificar si espera selección de modelo ────────────────────
  if (contextManager?.isAwaitingModelSelection(remoteJid)) {
    if (isPositiveInteger(text.trim())) {
      const index = parseInt(text.trim(), 10) - 1;
      if (availableModels.length === 0) {
        contextManager.clearAwaitingModelSelection(remoteJid);
        await sendWithTyping(
          sock,
          remoteJid,
          "❌ No hay modelos disponibles. Usa !modelos para recargar.",
        );
        return;
      }
      const model = availableModels[index];
      if (model) {
        contextManager.setModel(remoteJid, model);
        contextManager.clearAwaitingModelSelection(remoteJid);
        await sendWithTyping(sock, remoteJid, `✅ Modelo seleccionado: ${model}`);
      } else {
        await sendWithTyping(
          sock,
          remoteJid,
          `❌ Número inválido. Elige entre 1 y ${availableModels.length}.`,
        );
      }
      return;
    }

    contextManager.clearAwaitingModelSelection(remoteJid);
  }

  // ── Comandos con prefijo ───────────────────────────────────────
  if (command) {
    const result = await dispatchCommand(command, remoteJid, sock);

    if (result) {
      await sendWithTyping(sock, remoteJid, result.text);
    } else {
      const cmds = getCommands();
      const lista = cmds.map((c) => `!${c.name}`).join(", ");
      await sendWithTyping(
        sock,
        remoteJid,
        [
          `❓ Comando desconocido: !${command.name}`,
          "",
          `Comandos: ${lista}`,
          "",
          "Escribe !ayuda para más información.",
        ].join("\n"),
      );
    }
    return;
  }

  // ── Chat AI (mensajes sin prefijo) ─────────────────────────────
  if (!aiConfig || !contextManager) {
    await sendWithTyping(
      sock,
      remoteJid,
      "⚠️ El chat AI no está configurado. Contacta al administrador.",
    );
    return;
  }

  await handleAiChat(sock, remoteJid, text);
}

/**
 * Procesa un mensaje como chat AI: construye contexto, llama a la API
 * con soporte de function calling (tools), responde.
 */
async function handleAiChat(
  sock: WASocket,
  remoteJid: string,
  userText: string,
): Promise<void> {
  if (!aiConfig || !contextManager) {
    return;
  }

  const model = contextManager.getModel(remoteJid);

  if (!model) {
    await sendWithTyping(
      sock,
      remoteJid,
      "⚠️ No hay un modelo seleccionado. Usa !modelos para elegir uno.",
    );
    return;
  }

  // Refrescar system prompt para que tenga hora/fecha actual
  contextManager.refreshSystemPrompt(remoteJid);

  const userMessage = { role: "user" as const, content: userText };
  contextManager.addMessage(remoteJid, userMessage);

  const messages = contextManager.getMessages(remoteJid);

  // Activar typing mientras la API procesa
  await sock.sendPresenceUpdate("composing", remoteJid).catch(() => {});

  try {
    // Ejecutar chat con function calling
    const toolExecutor = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<string> => {
      // Intentar ejecutar como tool de memoria primero
      if (name === "memory_write" || name === "memory_read") {
        return executeMemoryTool(name, args, memoryManager, remoteJid);
      }
      // Intentar como tool de recordatorios
      if (["create_reminder", "delete_reminder", "list_reminders"].includes(name)) {
        return executeReminderTool(name, args, reminderManager, remoteJid);
      }
      return `Error: funcion desconocida "${name}"`;
    };

    // Notificar al usuario en WhatsApp cuando se usen herramientas
    const toolNotifTexts = new Map<string, string>();
    toolNotifTexts.set("create_reminder", "⏰ Creando recordatorio...");
    toolNotifTexts.set("delete_reminder", "🗑️ Eliminando recordatorio...");
    toolNotifTexts.set("list_reminders", "📋 Consultando recordatorios...");
    toolNotifTexts.set("memory_write", "📝 Escribiendo en memoria...");
    toolNotifTexts.set("memory_read", "🔍 Leyendo memoria...");

    const shownNotifs = new Set<string>();

    const result = await chatCompletionWithTools(
      messages,
      model,
      aiConfig,
      ALL_TOOLS,
      toolExecutor,
      3,
      (toolName) => {
        if (toolNotifTexts.has(toolName) && !shownNotifs.has(toolName)) {
          shownNotifs.add(toolName);
          const text = toolNotifTexts.get(toolName) ?? "";
          // Enviar notificación sin esperar (fire-and-forget)
          sock.sendMessage(remoteJid, { text }).catch(() => {});
        }
      },
    );

    const assistantMessage: import("./ai.ts").ChatMessage = {
      role: "assistant",
      content: result.content,
    };
    contextManager.addMessage(remoteJid, assistantMessage);

    // Preparar respuesta final
    let finalText = result.content;

    // Si se modificó la memoria, refrescar system prompt
    if (result.toolsCalled.includes("memory_write")) {
      contextManager.refreshSystemPrompt(remoteJid);
    }

    // Si se llamaron herramientas, quitar notificaciones previas del texto
    // (porque ya se enviaron como mensajes separados)
    if (result.toolsCalled.length > 0 && shownNotifs.size > 0) {
      // El contenido ya está limpio — el AI ya sabe lo que pasó
    }

    // Simular escritura antes de enviar
    const typingDelay = 3000 + Math.floor(Math.random() * 2000);
    await new Promise((r) => setTimeout(r, typingDelay));

    await sock.sendMessage(remoteJid, { text: finalText });
  } catch (err: unknown) {
    console.error("[ai] Error en chat (agotados reintentos):", err);
    const errorMsg =
      err instanceof Error ? err.message : "Error desconocido";
    await sendWithTyping(
      sock,
      remoteJid,
      `❌ Error al procesar tu mensaje: ${errorMsg}`,
    );
  } finally {
    await sock.sendPresenceUpdate("paused", remoteJid).catch(() => {});
  }
}

// ─── Media ───────────────────────────────────────────────────────

async function handleMediaMessage(
  sock: WASocket,
  message: WAMessage,
  remoteJid: string,
): Promise<void> {
  const isImage = Boolean(message.message?.imageMessage);

  if (isImage) {
    const savedPath = await downloadAndSaveImage(message);

    if (savedPath) {
      await sendWithTyping(
        sock,
        remoteJid,
        `📷 Imagen recibida y guardada: ${savedPath}`,
      );
    } else {
      await sendWithTyping(
        sock,
        remoteJid,
        "⚠️ No se pudo guardar la imagen. Verifica el tipo y tamaño.",
      );
    }
  }
}
