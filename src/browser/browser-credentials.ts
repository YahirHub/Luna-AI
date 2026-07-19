import { randomUUID } from "node:crypto";

export interface BrowserCredential {
  ref: string;
  jid: string;
  url: string;
  username: string;
  password: string;
  createdAt: number;
}

export interface PendingBrowserCredentialRequest {
  jid: string;
  originalText: string;
  url: string;
  username: string;
  createdAt: number;
}

const CREDENTIAL_TTL_MS = 20 * 60_000;
const PENDING_TTL_MS = 20 * 60_000;

function cleanupMap<T extends { createdAt: number }>(map: Map<string, T>, ttlMs: number): void {
  const cutoff = Date.now() - ttlMs;
  for (const [key, value] of map) {
    if (value.createdAt < cutoff) map.delete(key);
  }
}

export class BrowserCredentialStore {
  private readonly credentials = new Map<string, BrowserCredential>();
  private readonly pending = new Map<string, PendingBrowserCredentialRequest>();

  create(input: Omit<BrowserCredential, "ref" | "createdAt">): BrowserCredential {
    cleanupMap(this.credentials, CREDENTIAL_TTL_MS);
    const credential: BrowserCredential = {
      ...input,
      ref: `browser-cred-${randomUUID()}`,
      createdAt: Date.now(),
    };
    this.credentials.set(credential.ref, credential);
    return credential;
  }

  get(ref: string, jid: string): BrowserCredential | undefined {
    cleanupMap(this.credentials, CREDENTIAL_TTL_MS);
    const credential = this.credentials.get(ref);
    return credential?.jid === jid ? credential : undefined;
  }

  delete(ref: string): void {
    this.credentials.delete(ref);
  }

  setPending(request: Omit<PendingBrowserCredentialRequest, "createdAt">): void {
    cleanupMap(this.pending, PENDING_TTL_MS);
    this.pending.set(request.jid, { ...request, createdAt: Date.now() });
  }

  getPending(jid: string): PendingBrowserCredentialRequest | undefined {
    cleanupMap(this.pending, PENDING_TTL_MS);
    return this.pending.get(jid);
  }

  clearPending(jid: string): void {
    this.pending.delete(jid);
  }
}

export const browserCredentialStore = new BrowserCredentialStore();

function isLocalBrowserTarget(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "");
  return /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1)(?::\d{1,5})?(?:\/|$)/i.test(host)
    || /^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d{1,5})?(?:\/|$)/i.test(host);
}

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim().replace(/[),.;]+$/g, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${isLocalBrowserTarget(trimmed) ? "http" : "https"}://${trimmed}`;
}

function extractBrowserTarget(text: string): string {
  // Prioridad explícita: una URL completa o un host local mencionado por el
  // usuario deben ganar sobre dominios que formen parte de un correo.
  const explicitUrl = text.match(/https?:\/\/[^\s,;]+/iu)?.[0];
  if (explicitUrl) return explicitUrl;

  const localhost = text.match(/\blocalhost(?::\d{1,5})?(?:\/[^\s,;]*)?/iu)?.[0];
  if (localhost) return localhost;

  const ipv4 = text.match(/\b(?:127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d{1,5})?(?:\/[^\s,;]*)?/u)?.[0];
  if (ipv4) return ipv4;

  // No aceptar gmail.com (u otro dominio) cuando aparece dentro de
  // usuario@dominio.tld. Esta era la causa de que una petición a localhost
  // pudiera terminar apuntando al dominio del correo de inicio de sesión.
  const domainRegex = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:\/[^\s,;]*)?/giu;
  for (const match of text.matchAll(domainRegex)) {
    const index = match.index ?? 0;
    if (index > 0 && text[index - 1] === "@") continue;
    return match[0] ?? "";
  }
  return "";
}

export interface BrowserLoginIntent {
  loginRequested: boolean;
  url: string;
  username: string;
  password: string;
}

export function extractBrowserLoginIntent(text: string): BrowserLoginIntent {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const loginRequested = /(?:inicia|iniciar|haz|hacer|entra|entrar|accede|acceder|autentica|autenticar|login|log in).{0,24}(?:sesion|cuenta|panel|sitio|web)?/i.test(normalized)
    || /(?:sesion|login).{0,20}(?:usuario|user|contrasena|password)/i.test(normalized);
  const browserTarget = extractBrowserTarget(text);
  const usernamePatterns = [
    /(?:usuario|username|user|correo|email)\s*(?:es|:|=)?\s*["']?([^\s,;"']+)/iu,
    /(?:con\s+el\s+usuario|con\s+usuario)\s+["']?([^\s,;"']+)/iu,
  ];
  const passwordPatterns = [
    /(?:contrase(?:ñ|n)a|password)\s*(?:es|:|=)?\s*["']?([^\s,;"']+)/iu,
    /(?:con\s+la\s+contrase(?:ñ|n)a|con\s+contrase(?:ñ|n)a)\s+["']?([^\s,;"']+)/iu,
  ];
  const username = usernamePatterns.map((pattern) => pattern.exec(text)?.[1]?.trim() ?? "").find(Boolean) ?? "";
  const password = passwordPatterns.map((pattern) => pattern.exec(text)?.[1]?.trim() ?? "").find(Boolean) ?? "";
  return {
    loginRequested,
    url: normalizeBrowserUrl(browserTarget),
    username,
    password,
  };
}

export function sanitizeBrowserCredentialText(text: string, credential: BrowserCredential): string {
  const escaped = credential.password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sanitized = escaped
    ? text.replace(new RegExp(escaped, "g"), "[CREDENCIAL PROTEGIDA POR EL SISTEMA]")
    : text;
  return `${sanitized}\n\n[SISTEMA: Se retiró una contraseña del mensaje antes de enviarlo al LLM. Existe la referencia segura ${credential.ref} asociada a ${credential.url} y al usuario ${credential.username}. Esta credencial NO corresponde a la contraseña de la cuenta de Luna. Su presencia NO obliga a usar el navegador y NO debe disparar ninguna herramienta automáticamente: decide la acción según la intención completa del usuario. Si decides usar browser_agent para una tarea que requiera autenticación, pasa únicamente credential_ref=${credential.ref}. Nunca pidas, reveles ni repitas la contraseña.]`;
}
