import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";
import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { delay, getAppDir } from "./utils.ts";
import { setSocket } from "./bot.ts";
import { join } from "node:path";
import pino from "pino";
import QRCode from "qrcode";

const AUTH_DIR = join(getAppDir(), "persistent", "auth_info_baileys");

export function getAuthDir(): string {
  return AUTH_DIR;
}

/** Modo de autenticación. */
export type AuthMode = "qr" | "pairing";

export type MessageHandler = (
  sock: WASocket,
  message: WAMessage,
) => Promise<void>;

export interface BotConnection {
  sock: WASocket;
  /** Indica si la sesión fue cerrada definitivamente (loggedOut). */
  loggedOut: boolean;
}

// ─── ANSI color helpers ──────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  bgCyan: "\x1b[46m",
  bgYellow: "\x1b[103m",
  bgGreen: "\x1b[42m",
  black: "\x1b[30m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
};

function colorBlock(text: string): string {
  return `${ANSI.bold}${ANSI.bgCyan}${ANSI.black} ${text} ${ANSI.reset}`;
}

function dim(text: string): string {
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

// ─── Conexión ────────────────────────────────────────────────────

/**
 * Conecta al bot a WhatsApp.
 * - Si authMode = "qr": muestra QR en terminal.
 * - Si authMode = "pairing": solicita código de vinculación y lo muestra coloreado.
 */
export async function connectToWhatsApp(
  handleMessage: MessageHandler,
  authMode: AuthMode = "qr",
  phoneNumber?: string,
): Promise<BotConnection> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Renderizamos el QR manualmente con qrcode
    browser: Browsers.ubuntu("Chrome"),
    // Silenciar logs internos de Baileys (solo errores fatales)
    logger: pino({ level: "fatal" }),
  });

  // ── Guardar credenciales ───────────────────────────────────────

  sock.ev.on("creds.update", () => {
    void saveCreds().catch((err: unknown) => {
      console.error("[auth] Error al guardar credenciales:", err);
    });
  });

  // ── Mensajes entrantes ─────────────────────────────────────────

  sock.ev.on("messages.upsert", (m: { type: string; messages: WAMessage[] }) => {
    if (m.type !== "notify") {
      return;
    }
    for (const message of m.messages) {
      handleMessage(sock, message).catch((err: unknown) => {
        console.error("[msg] Error al procesar mensaje:", err);
      });
    }
  });

  // ── Conexión ───────────────────────────────────────────────────

  let pairingCodeRequested = false;

  const connectionResult = await new Promise<boolean>((resolve) => {
    sock.ev.on("connection.update", async (update: {
      connection?: "open" | "connecting" | "close";
      qr?: string;
      lastDisconnect?: { error?: unknown };
    }) => {
      const { connection, qr, lastDisconnect } = update;

      if (connection === "open") {
        console.log(`\n${ANSI.bold}${ANSI.bgGreen}${ANSI.black} CONECTADO ${ANSI.reset} ✅ WhatsApp sincronizado\n`);
        setSocket(sock);
        return;
      }

      if (connection === "connecting") {
        console.log(`${dim("⟳")} Conectando...`);
      }

      // QR mode — renderizar QR manualmente con qrcode
      if (authMode === "qr" && qr) {
        try {
          const qrAscii = await QRCode.toString(qr, {
            type: "terminal",
            small: true,
          });
          console.log(`\n${ANSI.bold}${ANSI.bgYellow}${ANSI.black} ESCANEA EL QR DE ARRIBA ${ANSI.reset}`);
          console.log(qrAscii);
          console.log(`${dim("Abre WhatsApp → Dispositivos vinculados → Vincular")}\n`);
        } catch {
          // Fallback: mostrar URL cruda si falla la generación del QR
          console.log(`\n${ANSI.bold}${ANSI.bgYellow}${ANSI.black} ESCANEA ESTE QR ${ANSI.reset}`);
          console.log(qr);
          console.log(`${dim("Abre WhatsApp → Dispositivos vinculados → Vincular")}\n`);
        }
      }

      // Pairing mode — solicitar código
      if (
        authMode === "pairing" &&
        qr &&
        !pairingCodeRequested &&
        !sock.authState.creds.registered &&
        phoneNumber
      ) {
        pairingCodeRequested = true;
        try {
          console.log(`\n${dim("⟳")} Solicitando código de vinculación...`);
          const code = await sock.requestPairingCode(phoneNumber);
          console.log(`\n${colorBlock(` CÓDIGO: ${code} `)}\n`);
          console.log(
            `${dim("Abre WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo → Introduce este código")}`,
          );
        } catch (err: unknown) {
          pairingCodeRequested = false;
          console.error(
            "\n❌ Error al solicitar código de vinculación:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (connection === "close") {
        setSocket(null);
        const statusCode = (
          lastDisconnect?.error as {
            output?: { statusCode?: number };
          }
        )?.output?.statusCode;

        const reason = statusCode ?? "desconocida";

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`\n${ANSI.bold}🚫 Sesión cerrada definitivamente.${ANSI.reset}`);
        } else {
          console.log(`${dim("🔌")} Conexión cerrada (${reason})`);
        }

        resolve(statusCode === DisconnectReason.loggedOut);
      }
    });
  });

  return { sock, loggedOut: connectionResult };
}

// ─── Backoff ─────────────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

/**
 * Bucle principal: conecta y reconecta automáticamente con backoff exponencial.
 * Detiene el bucle solo si la sesión fue cerrada definitivamente (loggedOut).
 */
export async function runWithReconnect(
  handleMessage: MessageHandler,
  authMode: AuthMode = "qr",
  phoneNumber?: string,
): Promise<void> {
  let loggedOut = false;
  let backoffMs = INITIAL_BACKOFF_MS;

  while (!loggedOut) {
    try {
      console.log(`\n${dim("═".repeat(40))}`);
      console.log(`${ANSI.bold}🔌 Conectando...${ANSI.reset}`);
      const t0 = Date.now();
      const result = await connectToWhatsApp(handleMessage, authMode, phoneNumber);
      const duration = Date.now() - t0;
      loggedOut = result.loggedOut;

      if (duration > 30_000) {
        backoffMs = INITIAL_BACKOFF_MS;
      }

      if (!loggedOut) {
        console.log(
          `\n${dim("↻")} Reconectando en ${(backoffMs / 1000).toFixed(0)}s...`,
        );
        await delay(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    } catch (err) {
      console.error(`\n❌ Error de conexión:`, err);
      console.log(
        `${dim("↻")} Reintentando en ${(backoffMs / 1000).toFixed(0)}s...`,
      );
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  console.log(`\n${ANSI.bold}🛑 Bot detenido.${ANSI.reset}`);
}
