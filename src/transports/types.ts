/**
 * Contrato de transporte independiente de WhatsApp, Telegram u otra librería.
 * El núcleo de Luna solo conoce estas estructuras; cada adaptador convierte
 * desde/hacia las estructuras nativas de su SDK.
 */
export type TransportDeliveryStatus = "sent" | "queued";

export type TransportMediaKind = "image" | "audio" | "video" | "document";

export interface TransportActivitySession {
  refresh: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface TransportIncomingMedia {
  kind: TransportMediaKind;
  mimeType: string;
  fileName?: string;
  caption?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  download: () => Promise<Uint8Array>;
}

export interface TransportIncomingMessage {
  /** Identificador estable de la conversación usado por auth/contexto/workdir. */
  conversationId: string;
  /** Identificador nativo que el adaptador usa para responder. */
  chatId: string;
  /** Identificador del remitente, cuando la plataforma lo expone. */
  senderId: string;
  /** Identificador nativo del mensaje. */
  messageId: string;
  transportId: string;
  fromSelf: boolean;
  isGroup: boolean;
  text: string;
  media?: TransportIncomingMedia;
  /** Referencia opaca para operaciones propias del adaptador, como borrar. */
  native?: unknown;
}

export interface TransportTextMessage {
  kind: "text";
  text: string;
}

export interface TransportFileMessage {
  kind: "file";
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  caption?: string;
  /** "auto" permite al adaptador elegir medio nativo o documento. */
  mode?: "auto" | "document";
}

export type TransportOutboundMessage = TransportTextMessage | TransportFileMessage;

export interface TransportSendOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Si false, permite continuar sin esperar confirmación inmediata de entrega. */
  waitForDelivery?: boolean;
}

export interface MessagingTransport {
  readonly id: string;
  readonly label: string;

  /**
   * Envía un mensaje. La política de escritura/presencia y cola pertenece al
   * adaptador, no al núcleo de Luna.
   */
  send(
    conversationId: string,
    message: TransportOutboundMessage,
    options?: TransportSendOptions,
  ): Promise<TransportDeliveryStatus>;

  /** Actividad larga opcional ("escribiendo", chat action, etc.). */
  startActivity(conversationId: string, refreshIntervalMs?: number): Promise<TransportActivitySession>;

  /** Operaciones best-effort específicas de plataforma. */
  markRead(message: TransportIncomingMessage): Promise<void>;
  deleteMessage(message: TransportIncomingMessage): Promise<void>;
}

export type TransportMessageHandler = (
  transport: MessagingTransport,
  message: TransportIncomingMessage,
) => Promise<void>;

/**
 * Un runner administra autenticación, reconexión y ciclo de vida de una
 * implementación concreta. Añadir Telegram u otro cliente requiere crear un
 * runner/adaptador nuevo, sin modificar bot.ts.
 */
export interface TransportRunner {
  readonly id: string;
  readonly label: string;
  run(handler: TransportMessageHandler): Promise<void>;
}
