import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import pino from "pino";
import QRCode from "qrcode";
import { delay, getAppDir } from "../../utils.ts";
import type { TransportMessageHandler, TransportRunner } from "../types.ts";
import { setActiveTransport } from "../active.ts";
import {
  BaileysTransport,
  isWhatsAppGroupJid,
  normalizeBaileysMessage,
} from "./adapter.ts";

const AUTH_DIR = join(getAppDir(), "persistent", "auth_info_baileys");
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

export type BaileysAuthMode = "qr" | "pairing";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  bgCyan: "\x1b[46m",
  bgYellow: "\x1b[103m",
  bgGreen: "\x1b[42m",
  black: "\x1b[30m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[93m",
};

function colorBlock(text: string): string {
  return `${ANSI.bold}${ANSI.bgCyan}${ANSI.black} ${text} ${ANSI.reset}`;
}

function dim(text: string): string {
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function sessionExists(): boolean {
  try {
    return existsSync(join(AUTH_DIR, "creds.json"));
  } catch {
    return false;
  }
}

function question(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function showStartupMenu(): Promise<{ mode: BaileysAuthMode; phoneNumber?: string }> {
  console.log(`\n${ANSI.bold}${ANSI.yellow}═══ VINCULACIÓN DE WHATSAPP ═══${ANSI.reset}\n`);
  console.log(`  ${ANSI.bold}1${ANSI.reset}  Vincular con número de teléfono`);
  console.log(`  ${ANSI.bold}2${ANSI.reset}  Vincular con código QR\n`);

  for (;;) {
    const choice = await question(`  ${ANSI.cyan}?${ANSI.reset} Selecciona una opción (1/2): `);
    if (choice === "1") {
      console.log(`\n${ANSI.bold}📱 VINCULACIÓN POR NÚMERO${ANSI.reset}`);
      console.log(`  ${ANSI.gray}Ingresa solo tu número sin prefijo ni espacios.${ANSI.reset}`);
      console.log(`  ${ANSI.gray}Ejemplo: 9993260721${ANSI.reset}\n`);
      for (;;) {
        const raw = await question(`  ${ANSI.cyan}?${ANSI.reset} Tu número: `);
        const digits = raw.replace(/\D/g, "");
        if (digits.length >= 7 && digits.length <= 12) {
          const phoneNumber = `521${digits}`;
          console.log(`  ${ANSI.gray}→ Número completo: ${phoneNumber}${ANSI.reset}\n`);
          return { mode: "pairing", phoneNumber };
        }
        console.log(`  ${ANSI.yellow}⚠️  Número inválido. Debe tener entre 7 y 12 dígitos.${ANSI.reset}`);
      }
    }

    if (choice === "2") {
      console.log(`\n  ${ANSI.gray}Esperando QR... Escanéalo con WhatsApp cuando aparezca.${ANSI.reset}\n`);
      return { mode: "qr" };
    }

    console.log(`  ${ANSI.yellow}⚠️  Opción inválida. Elige 1 o 2.${ANSI.reset}`);
  }
}

interface ConnectionResult {
  loggedOut: boolean;
}

async function connectOnce(
  transport: BaileysTransport,
  handler: TransportMessageHandler,
  authMode: BaileysAuthMode,
  phoneNumber?: string,
): Promise<ConnectionResult> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    logger: pino({ level: "fatal" }),
  });

  // El socket solo se publica al adaptador cuando Baileys confirma connection=open.
  // Así la cola no intenta enviar durante el handshake inicial.
  transport.setSocket(null);

  sock.ev.on("creds.update", () => {
    void saveCreds().catch((err: unknown) => {
      console.error("[auth] Error al guardar credenciales:", err);
    });
  });

  sock.ev.on("messages.upsert", (m: { type: string; messages: WAMessage[] }) => {
    if (m.type !== "notify") return;
    for (const raw of m.messages) {
      const remoteJid = raw.key.remoteJid;
      // Seguridad del adaptador: los grupos ni siquiera alcanzan el núcleo.
      if (isWhatsAppGroupJid(remoteJid)) continue;
      const message = normalizeBaileysMessage(raw);
      if (!message) continue;
      handler(transport, message).catch((err: unknown) => {
        console.error("[msg] Error al procesar mensaje:", err);
      });
    }
  });

  let pairingCodeRequested = false;
  const loggedOut = await new Promise<boolean>((resolve) => {
    sock.ev.on("connection.update", async (update: {
      connection?: "open" | "connecting" | "close";
      qr?: string;
      lastDisconnect?: { error?: unknown };
    }) => {
      const { connection, qr, lastDisconnect } = update;

      if (connection === "open") {
        console.log(`\n${ANSI.bold}${ANSI.bgGreen}${ANSI.black} CONECTADO ${ANSI.reset} ✅ WhatsApp sincronizado\n`);
        transport.setSocket(sock);
        return;
      }

      if (connection === "connecting") console.log(`${dim("⟳")} Conectando...`);

      if (authMode === "qr" && qr) {
        try {
          const qrAscii = await QRCode.toString(qr, { type: "terminal", small: true });
          console.log(`\n${ANSI.bold}${ANSI.bgYellow}${ANSI.black} ESCANEA EL QR DE ARRIBA ${ANSI.reset}`);
          console.log(qrAscii);
          console.log(`${dim("Abre WhatsApp → Dispositivos vinculados → Vincular")}\n`);
        } catch {
          console.log(`\n${ANSI.bold}${ANSI.bgYellow}${ANSI.black} ESCANEA ESTE QR ${ANSI.reset}`);
          console.log(qr);
        }
      }

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
          console.log(`${dim("Abre WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo → Introduce este código")}`);
        } catch (err: unknown) {
          pairingCodeRequested = false;
          console.error("\n❌ Error al solicitar código de vinculación:", err instanceof Error ? err.message : String(err));
        }
      }

      if (connection === "close") {
        transport.setSocket(null);
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const reason = statusCode ?? "desconocida";
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`\n${ANSI.bold}🚫 Sesión de WhatsApp cerrada definitivamente.${ANSI.reset}`);
        } else {
          console.log(`${dim("🔌")} Conexión WhatsApp cerrada (${reason})`);
        }
        resolve(statusCode === DisconnectReason.loggedOut);
      }
    });
  });

  return { loggedOut };
}

async function runWithReconnect(
  transport: BaileysTransport,
  handler: TransportMessageHandler,
  authMode: BaileysAuthMode,
  phoneNumber?: string,
): Promise<void> {
  let loggedOut = false;
  let backoffMs = INITIAL_BACKOFF_MS;

  while (!loggedOut) {
    try {
      console.log(`\n${dim("═".repeat(40))}`);
      console.log(`${ANSI.bold}🔌 Conectando WhatsApp (Baileys)...${ANSI.reset}`);
      const startedAt = Date.now();
      const result = await connectOnce(transport, handler, authMode, phoneNumber);
      loggedOut = result.loggedOut;
      if (Date.now() - startedAt > 30_000) backoffMs = INITIAL_BACKOFF_MS;
      if (!loggedOut) {
        console.log(`\n${dim("↻")} Reconectando en ${(backoffMs / 1000).toFixed(0)}s...`);
        await delay(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    } catch (err) {
      transport.setSocket(null);
      console.error("\n❌ Error de conexión WhatsApp:", err);
      console.log(`${dim("↻")} Reintentando en ${(backoffMs / 1000).toFixed(0)}s...`);
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
}

export class BaileysTransportRunner implements TransportRunner {
  readonly id = "baileys";
  readonly label = "WhatsApp (Baileys)";
  private readonly transport = new BaileysTransport();

  async run(handler: TransportMessageHandler): Promise<void> {
    setActiveTransport(this.transport);
    const forceQr = process.argv.includes("--qr");

    while (true) {
      let mode: BaileysAuthMode = "qr";
      let phoneNumber: string | undefined;

      if (sessionExists()) {
        console.log(`🔐 ${ANSI.bold}Sesión WhatsApp existente detectada${ANSI.reset} — conectando...\n`);
      } else if (forceQr) {
        console.log(`📷 ${ANSI.bold}Modo QR automático de WhatsApp${ANSI.reset}\n`);
      } else {
        console.log(`${ANSI.yellow}⚠️  No hay sesión de WhatsApp guardada.${ANSI.reset}\n`);
        const menu = await showStartupMenu();
        mode = menu.mode;
        phoneNumber = menu.phoneNumber;
      }

      await runWithReconnect(this.transport, handler, mode, phoneNumber);

      console.log(`\n${ANSI.yellow}⚰️  Sesión WhatsApp inválida — limpiando autenticación...${ANSI.reset}`);
      try {
        rmSync(AUTH_DIR, { recursive: true, force: true });
      } catch {
        // Ignorar errores al limpiar; el siguiente intento reportará el fallo.
      }
      console.log(`${ANSI.gray}   Reiniciando proceso de vinculación.${ANSI.reset}\n`);
    }
  }
}
