import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";
import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import type { TransportMessageHandler, TransportRunner } from "../types.ts";
import { setActiveTransport } from "../active.ts";
import { BaileysTransport } from "./adapter.ts";
import { delay, getAppDir } from "../../utils.ts";
import { setTransport } from "../../bot.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";
import pino from "pino";
import QRCode from "qrcode";
import { isWhatsAppGroupJid } from "../../whatsapp-message-guard.ts";

const AUTH_DIR = join(getAppDir(), "persistent", "auth_info_baileys");

export function getAuthDir(): string {
  return AUTH_DIR;
}

/** Modo de autenticación. */
export type AuthMode = "qr" | "pairing";

export type MessageHandler = TransportMessageHandler;

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
export async function connectWhatsApp(
  handleMessage: MessageHandler,
  authMode: AuthMode = "qr",
  phoneNumber?: string,
  transport: BaileysTransport = new BaileysTransport(),
): Promise<BotConnection> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Renderizamos el QR manualmente con qrcode
    browser: Browsers.ubuntu("Chrome"),
    // Silenciar logs internos de Baileys (solo errores fatales)
    logger: pino({ level: "fatal" }),
  });
  transport.attachSocket(sock);
  setActiveTransport(transport);
  setTransport(transport);

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
      if (isWhatsAppGroupJid(message.key.remoteJid)) continue;
      handleMessage(transport, transport.toIncoming(message)).catch((err: unknown) => {
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
        setTransport(transport);
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
        // Conservamos el mismo adaptador y su cola durante reconexiones. Los
        // mensajes nuevos quedan pendientes y se envían al adjuntar el socket
        // siguiente, en vez de perderse al crear otra instancia.
        transport.attachSocket(null);
        setActiveTransport(transport);
        setTransport(transport);
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
  const transport = new BaileysTransport();
  setActiveTransport(transport);
  setTransport(transport);

  while (!loggedOut) {
    try {
      console.log(`\n${dim("═".repeat(40))}`);
      console.log(`${ANSI.bold}🔌 Conectando...${ANSI.reset}`);
      const t0 = Date.now();
      const result = await connectWhatsApp(handleMessage, authMode, phoneNumber, transport);
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

  transport.attachSocket(null);
  setActiveTransport(null);
  setTransport(null);
  console.log(`\n${ANSI.bold}🛑 Bot detenido.${ANSI.reset}`);
}

export function createBaileysRunner(): TransportRunner {
  return {
    id: "baileys",
    getAuthDir,
    sessionExists: () => { try { return existsSync(join(getAuthDir(), "creds.json")); } catch { return false; } },
    run: async (handler: MessageHandler, options: { authMode?: AuthMode; phoneNumber?: string }) => {
      await runWithReconnect(handler, options.authMode ?? "qr", options.phoneNumber);
      return { loggedOut: true };
    },
  };
}
