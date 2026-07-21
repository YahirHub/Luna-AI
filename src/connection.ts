/** Compatibilidad temporal: la implementación vive en transports/baileys. */
export { connectWhatsApp, runWithReconnect, getAuthDir, createBaileysRunner } from "./transports/baileys/runner.ts";
export type { AuthMode, BotConnection, MessageHandler } from "./transports/baileys/runner.ts";
