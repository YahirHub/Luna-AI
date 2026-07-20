import { createTransportRunner } from "./transports/factory.ts";
import type { TransportMessageHandler } from "./transports/types.ts";

/**
 * Orquestador genérico de transporte. El núcleo no importa Baileys ni conoce
 * detalles de autenticación de la implementación concreta.
 */
export async function runMessagingTransport(handler: TransportMessageHandler): Promise<void> {
  const runner = await createTransportRunner();
  console.log(`💬 Transporte activo: ${runner.label}`);
  await runner.run(handler);
}
