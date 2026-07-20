import { runMessagingTransport } from "./connection.ts";
import { handleMessage, initLlm } from "./bot.ts";
import { getLlmConfigPath, loadLlmConfigIfPresent } from "./llm-config.ts";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
};

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
    console.log(`   Modelo global: ${config.defaultModel}`);
    console.log("   El catálogo se actualizará en segundo plano.\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ No se pudo cargar la configuración LLM: ${reason}`);
    console.warn("   Se usará OpenCode Free y el administrador podrá reparar el proveedor con /setup-provider.\n");
    initLlm(null, configPath);
  }
}

async function main(): Promise<void> {
  console.log(`\n${ANSI.bold}🤖 Luna AI${ANSI.reset}`);
  console.log(`${ANSI.gray}${"─".repeat(35)}${ANSI.reset}\n`);
  initLlmFromFile();

  let shuttingDown = false;
  const shutdown = (label: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${ANSI.gray}🛑 Cerrando Luna (${label})...${ANSI.reset}`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("Ctrl+C"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await runMessagingTransport(handleMessage);
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
