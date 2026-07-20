import type { MessagingTransport } from "./types.ts";

let activeTransport: MessagingTransport | null = null;

export function setActiveTransport(transport: MessagingTransport | null): void {
  activeTransport = transport;
}

export function getActiveTransport(): MessagingTransport | null {
  return activeTransport;
}
