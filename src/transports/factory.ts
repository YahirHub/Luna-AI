import type { TransportRunner } from "./types.ts";
import { createBaileysRunner } from "./baileys/runner.ts";

export function resolveTransportId(argv: string[] = process.argv): string {
  const inline = argv.find((arg) => arg.startsWith("--transport="));
  const fromArg = inline?.slice("--transport=".length).trim();
  const index = argv.indexOf("--transport");
  const separated = index >= 0 ? argv[index + 1]?.trim() : undefined;
  return (fromArg || separated || process.env.LUNA_TRANSPORT || "baileys").toLowerCase();
}

export function createTransportRunner(id = resolveTransportId()): TransportRunner {
  if (id === "baileys" || id === "whatsapp") return createBaileysRunner();
  throw new Error(`Transporte no registrado: ${id}. Disponibles: baileys.`);
}
