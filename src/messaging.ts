import type {
  MessagingTransport,
  TransportActivitySession,
  TransportDeliveryStatus,
  TransportFileMessage,
  TransportSendOptions,
} from "./transports/types.ts";

/** Fachada genérica. La presencia/escritura pertenece exclusivamente al adaptador. */
export async function sendText(
  transport: MessagingTransport,
  conversationId: string,
  text: string,
  options: TransportSendOptions = {},
): Promise<TransportDeliveryStatus> {
  return transport.send(conversationId, { kind: "text", text }, options);
}

export async function sendFile(
  transport: MessagingTransport,
  conversationId: string,
  file: Omit<TransportFileMessage, "kind">,
  options: TransportSendOptions = {},
): Promise<TransportDeliveryStatus> {
  return transport.send(conversationId, { kind: "file", ...file }, options);
}

/**
 * Envía texto con una latencia humana sugerida. El núcleo no activa presencia:
 * el adaptador decide si simula "escribiendo", usa chat actions o no hace nada.
 */
export async function sendTextHumanized(
  transport: MessagingTransport,
  conversationId: string,
  text: string,
  minDelayMs = 3_000,
  maxDelayMs = 5_000,
): Promise<void> {
  await sendText(transport, conversationId, text, {
    minDelayMs,
    maxDelayMs,
    waitForDelivery: true,
  });
}

/** Actividad larga genérica; cada cliente decide cómo representarla. */
export async function startActivity(
  transport: MessagingTransport,
  conversationId: string,
  refreshIntervalMs = 8_000,
): Promise<TransportActivitySession> {
  return transport.startActivity(conversationId, refreshIntervalMs);
}
