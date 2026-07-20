import type { TransportRunner } from "./types.ts";

export type BuiltInTransportId = "baileys";

type TransportLoader = () => Promise<TransportRunner>;

const LOADERS: Record<BuiltInTransportId, TransportLoader> = {
  baileys: async () => {
    // Carga diferida: un transporte futuro no necesita inicializar ni importar
    // el SDK de Baileys cuando otro cliente sea el seleccionado.
    const { BaileysTransportRunner } = await import("./baileys/runner.ts");
    return new BaileysTransportRunner();
  },
};

const ALIASES: Record<string, BuiltInTransportId> = {
  baileys: "baileys",
  whatsapp: "baileys",
};

function selectedTransportId(): string {
  const eqArg = process.argv.find((arg) => arg.startsWith("--transport="));
  if (eqArg) return eqArg.slice("--transport=".length).trim().toLowerCase();
  const index = process.argv.indexOf("--transport");
  if (index >= 0) return (process.argv[index + 1] ?? "").trim().toLowerCase();
  return (process.env.LUNA_TRANSPORT ?? "baileys").trim().toLowerCase();
}

/**
 * Punto único de selección de cliente. Para integrar Telegram u otra librería,
 * se registra un loader aquí; bot.ts, auth, tools, media y mensajería no cambian.
 * Los loaders son diferidos para no cargar SDKs de transportes inactivos.
 */
export async function createTransportRunner(): Promise<TransportRunner> {
  const requested = selectedTransportId();
  const id = ALIASES[requested];
  if (!id) {
    throw new Error(
      `Transporte desconocido "${requested}". Disponibles actualmente: ${Object.keys(LOADERS).join(", ")}.`,
    );
  }
  return LOADERS[id]();
}
