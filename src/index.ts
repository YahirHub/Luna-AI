import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import { runWithReconnect, getAuthDir } from "./connection.ts";
import type { AuthMode } from "./connection.ts";
import { handleMessage, initLlm } from "./bot.ts";
import {
  getLlmConfigPath,
  loadLlmConfigIfPresent,
} from "./llm-config.ts";

// ─── Configuración LLM ───────────────────────────────────────────

function initLlmFromFile(): void {
  const configPath = getLlmConfigPath();

  try {
    const config = loadLlmConfigIfPresent(configPath);
    initLlm(config, configPath);

    if (!config) {
      console.log("🧠 Proveedor integrado activo: OpenCode Free");
      console.log("   /setup-provider es opcional y permite usar un proveedor personalizado.\n");
      return;
    }

    console.log(`🧠 Proveedor personalizado cargado: ${configPath}`);
    console.log(`   Modelo predeterminado: ${config.defaultModel}`);
    console.log("   El catálogo se actualizará en segundo plano.\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ No se pudo cargar la configuración LLM: ${reason}`);
    console.warn(
      "   Se usará OpenCode Free y el administrador podrá reparar el proveedor con /setup-provider.\n",
    );
    initLlm(null, configPath);
  }
}

// ─── Session detection ──────────────────────────────────────────

function sessionExists(): boolean {
  try {
    return existsSync(join(getAuthDir(), "creds.json"));
  } catch {
    return false;
  }
}

// ─── Interactive input ───────────────────────────────────────────

function question(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Interactive menu ────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  yellow: "\x1b[93m",
};

async function showStartupMenu(): Promise<{
  mode: AuthMode;
  phoneNumber?: string;
}> {
  console.log(`\n${ANSI.bold}${ANSI.yellow}═══ VINCULACIÓN DE WHATSAPP ═══${ANSI.reset}\n`);
  console.log(`  ${ANSI.bold}1${ANSI.reset}  Vincular con número de teléfono`);
  console.log(`  ${ANSI.bold}2${ANSI.reset}  Vincular con código QR\n`);

  let mode: AuthMode = "qr";
  let phoneNumber: string | undefined;

  for (;;) {
    const choice = await question(`  ${ANSI.cyan}?${ANSI.reset} Selecciona una opción (1/2): `);

    if (choice === "1") {
      mode = "pairing";
      console.log(`\n${ANSI.bold}📱 VINCULACIÓN POR NÚMERO${ANSI.reset}`);
      console.log(`  ${ANSI.gray}Ingresa solo tu número sin prefijo ni espacios.${ANSI.reset}`);
      console.log(`  ${ANSI.gray}Ejemplo: 9993260721${ANSI.reset}\n`);

      for (;;) {
        const raw = await question(`  ${ANSI.cyan}?${ANSI.reset} Tu número: `);
        const digits = raw.replace(/\D/g, "");

        if (digits.length >= 7 && digits.length <= 12) {
          // Agregar prefijo 521
          phoneNumber = `521${digits}`;
          console.log(`  ${ANSI.gray}→ Número completo: ${phoneNumber}${ANSI.reset}\n`);
          break;
        }
        console.log(`  ${ANSI.yellow}⚠️  Número inválido. Debe tener entre 7 y 12 dígitos.${ANSI.reset}`);
      }
      break;
    }

    if (choice === "2") {
      mode = "qr";
      console.log(`\n  ${ANSI.gray}Esperando QR... Escanéalo con WhatsApp cuando aparezca.${ANSI.reset}\n`);
      break;
    }

    console.log(`  ${ANSI.yellow}⚠️  Opción inválida. Elige 1 o 2.${ANSI.reset}`);
  }

  return { mode, phoneNumber };
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${ANSI.bold}🤖 WhatsApp Bot${ANSI.reset}`);
  console.log(`${ANSI.gray}${"─".repeat(35)}${ANSI.reset}\n`);

  // Cargar el proveedor si ya fue configurado. Su ausencia no impide vincular WhatsApp.
  initLlmFromFile();

  // Parsear flags
  const forceQr = process.argv.includes("--qr");

  // ── Cierre limpio ──────────────────────────────────────────────

  let shuttingDown = false;

  process.on("SIGINT", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${ANSI.gray}🛑 Cerrando bot (Ctrl+C)...${ANSI.reset}`);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${ANSI.gray}🛑 Cerrando bot...${ANSI.reset}`);
    process.exit(0);
  });

  // ── Bucle de conexión y vinculación ─────────────────────────────

  while (true) {
    let mode: AuthMode = "qr";
    let phoneNumber: string | undefined;

    if (sessionExists()) {
      console.log(
        `🔐 ${ANSI.bold}Sesión existente detectada${ANSI.reset} — conectando...\n`,
      );
    } else if (forceQr) {
      console.log(`📷 ${ANSI.bold}Modo QR automático${ANSI.reset}\n`);
      mode = "qr";
    } else {
      console.log(`${ANSI.yellow}⚠️  No hay sesión guardada.${ANSI.reset}\n`);
      const menu = await showStartupMenu();
      mode = menu.mode;
      phoneNumber = menu.phoneNumber;
    }

    await runWithReconnect(handleMessage, mode, phoneNumber);

    // Si llegamos aquí, la sesión se cerró (loggedOut)
    console.log(
      `\n${ANSI.yellow}⚰️  Sesión inválida — limpiando autenticación...${ANSI.reset}`,
    );
    try {
      rmSync(getAuthDir(), { recursive: true, force: true });
    } catch {
      // Ignorar errores al limpiar
    }
    console.log(`${ANSI.gray}   Reiniciando proceso de vinculación.${ANSI.reset}\n`);
  }
}

async function bootstrap(): Promise<void> {
  if (process.argv.includes("--media-worker")) {
    const { runMediaProcessorChild } = await import("./media-processing/worker.ts");
    await runMediaProcessorChild();
    process.exit(0);
  }

  await main();
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`❌ Error fatal: ${message}`);
  process.exit(1);
});
