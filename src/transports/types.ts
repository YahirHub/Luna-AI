export type TransportDeliveryStatus = "sent" | "queued";

export interface TransportOutboundContent {
  text?: string;
  image?: Buffer;
  audio?: Buffer;
  video?: Buffer;
  document?: Buffer;
  caption?: string;
  mimetype?: string;
  fileName?: string;
  ptt?: boolean;
}

export interface TransportIncomingMessage {
  id: string;
  conversationId: string;
  fromSelf: boolean;
  text: string;
  mediaKind: "image" | "audio" | null;
  caption: string;
  /** Objeto nativo reservado exclusivamente para el adaptador/decodificador. */
  raw: unknown;
  downloadMedia?: () => Promise<Uint8Array>;
  mediaMimeType?: string;
  mediaSizeBytes?: number;
  mediaDurationSeconds?: number;
}

export interface TransportSendOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  waitForDelivery?: boolean;
}

export interface MessagingTransport {
  readonly id: string;
  readonly connected: boolean;
  send(conversationId: string, content: TransportOutboundContent, options?: TransportSendOptions): Promise<TransportDeliveryStatus>;
  sendPresence(conversationId: string, state: "composing" | "paused"): Promise<void>;
  markRead(message: TransportIncomingMessage): Promise<void>;
  deleteMessage(message: TransportIncomingMessage): Promise<void>;
}

export type TransportMessageHandler = (
  transport: MessagingTransport,
  message: TransportIncomingMessage,
) => Promise<void>;

export interface TransportRunner {
  readonly id: string;
  getAuthDir(): string;
  sessionExists(): boolean;
  run(handler: TransportMessageHandler, options: { authMode?: "qr" | "pairing"; phoneNumber?: string }): Promise<{ loggedOut: boolean }>;
}
