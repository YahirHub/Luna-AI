import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomically } from "../storage.ts";
import { getAppDir } from "../utils.ts";
import { loadOrCreateBrowserEncryptionKey } from "./browser-encryption.ts";

export interface BrowserCredential {
  ref: string;
  jid: string;
  url: string;
  username: string;
  password: string;
  createdAt: number;
}

export type BrowserSecretKind = "password" | "otp" | "secret";

export interface BrowserSecret {
  ref: string;
  jid: string;
  kind: BrowserSecretKind;
  value: string;
  createdAt: number;
}

export interface BrowserCredentialProfile {
  ref: string;
  jid: string;
  url: string;
  origin: string;
  username: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

interface BrowserCredentialProfileRecord extends BrowserCredentialProfile {
  encryptedPassword: string;
}

export type BrowserInputKind = "username" | "password" | "otp" | "text";

export interface PendingBrowserInputRequest {
  jid: string;
  kind: BrowserInputKind;
  fieldName: string;
  originalText: string;
  url?: string;
  username?: string;
  message?: string;
  /** Identifica una espera viva de browser-web. Si no existe, es un flujo legado del agente principal. */
  requestId?: string;
  createdAt: number;
}

export type BrowserInputResolution =
  | { kind: "username" | "text"; value: string }
  | { kind: "password"; credentialRef: string; url: string; username: string }
  | { kind: "otp"; secretRef: string };

interface PendingBrowserInputWaiter {
  requestId: string;
  jid: string;
  resolve: (value: BrowserInputResolution) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Compatibilidad con el flujo anterior que solo solicitaba contraseña. */
export interface PendingBrowserCredentialRequest {
  jid: string;
  originalText: string;
  url: string;
  username: string;
  createdAt: number;
}

export interface ResolvedBrowserCredential {
  ref: string;
  source: "temporary" | "profile";
  jid: string;
  url: string;
  username: string;
  password: string;
  profileRef?: string;
}

interface BrowserCredentialStoreOptions {
  /** Los stores creados en tests son efímeros por defecto. El singleton global sí persiste. */
  persistent?: boolean;
  baseDir?: string;
}

const CREDENTIAL_TTL_MS = 20 * 60_000;
const SECRET_TTL_MS = 10 * 60_000;
const PENDING_TTL_MS = 30 * 60_000;

function cleanupMap<T extends { createdAt: number }>(map: Map<string, T>, ttlMs: number): void {
  const cutoff = Date.now() - ttlMs;
  for (const [key, value] of map) {
    if (value.createdAt < cutoff) map.delete(key);
  }
}

function ensureMode600(path: string): void {
  try { chmodSync(path, 0o600); } catch { /* Windows aplica sus propias ACL */ }
}

function normalizeOrigin(value: string): string {
  const normalized = normalizeBrowserUrl(value);
  if (!normalized) return "";
  try {
    return new URL(normalized).origin.toLowerCase();
  } catch {
    return normalized.toLowerCase().replace(/\/$/, "");
  }
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export class BrowserCredentialStore {
  private readonly credentials = new Map<string, BrowserCredential>();
  private readonly secrets = new Map<string, BrowserSecret>();
  private readonly pending = new Map<string, PendingBrowserInputRequest>();
  private readonly pendingWaiters = new Map<string, PendingBrowserInputWaiter>();
  private readonly persistent: boolean;
  private readonly baseDir: string;
  private readonly profilesPath: string;
  private readonly keyPath: string;
  private profilesLoaded = false;
  private profiles = new Map<string, BrowserCredentialProfileRecord>();

  constructor(options: BrowserCredentialStoreOptions = {}) {
    this.persistent = options.persistent ?? false;
    this.baseDir = options.baseDir ?? join(getAppDir(), "persistent", "browser");
    this.profilesPath = join(this.baseDir, "credential-profiles.json");
    this.keyPath = join(this.baseDir, "encryption.key");
  }

  create(input: Omit<BrowserCredential, "ref" | "createdAt">): BrowserCredential {
    cleanupMap(this.credentials, CREDENTIAL_TTL_MS);
    const credential: BrowserCredential = {
      ...input,
      url: normalizeBrowserUrl(input.url),
      username: input.username.trim(),
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
    this.secrets.delete(ref);
  }

  createSecret(input: { jid: string; kind?: BrowserSecretKind; value: string }): BrowserSecret {
    cleanupMap(this.secrets, SECRET_TTL_MS);
    const secret: BrowserSecret = {
      ref: `browser-secret-${randomUUID()}`,
      jid: input.jid,
      kind: input.kind ?? "secret",
      value: input.value,
      createdAt: Date.now(),
    };
    this.secrets.set(secret.ref, secret);
    return secret;
  }

  getSecret(ref: string, jid: string, consume = false): BrowserSecret | undefined {
    cleanupMap(this.secrets, SECRET_TTL_MS);
    const secret = this.secrets.get(ref);
    if (!secret || secret.jid !== jid) return undefined;
    if (consume) this.secrets.delete(ref);
    return secret;
  }

  setPendingInput(request: Omit<PendingBrowserInputRequest, "createdAt">): void {
    cleanupMap(this.pending, PENDING_TTL_MS);
    this.pending.set(request.jid, { ...request, createdAt: Date.now() });
  }

  getPendingInput(jid: string): PendingBrowserInputRequest | undefined {
    cleanupMap(this.pending, PENDING_TTL_MS);
    return this.pending.get(jid);
  }

  /**
   * Pausa una ejecución viva de browser-web hasta que el usuario responda.
   * La Promise se resuelve desde el manejador de mensajes sin crear otra tarea ni
   * reiniciar el navegador, por lo que se conserva la misma sesión y runId.
   */
  waitForInput(
    request: Omit<PendingBrowserInputRequest, "createdAt" | "requestId">,
    signal?: AbortSignal,
  ): Promise<BrowserInputResolution> {
    this.cancelPendingInput(request.jid, new Error("browser-input-replaced"));
    const requestId = `browser-input-${randomUUID()}`;
    this.setPendingInput({ ...request, requestId });

    return new Promise<BrowserInputResolution>((resolve, reject) => {
      const cleanup = (): void => {
        const waiter = this.pendingWaiters.get(requestId);
        if (!waiter) return;
        clearTimeout(waiter.timeout);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        this.pendingWaiters.delete(requestId);
        const current = this.pending.get(request.jid);
        if (current?.requestId === requestId) this.pending.delete(request.jid);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("La espera de datos del navegador expiró."));
      }, PENDING_TTL_MS);
      (timeout as unknown as { unref?: () => void }).unref?.();

      const onAbort = (): void => {
        cleanup();
        reject(signal?.reason ?? new Error("browser-input-cancelled"));
      };

      this.pendingWaiters.set(requestId, {
        requestId,
        jid: request.jid,
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (reason) => { cleanup(); reject(reason); },
        timeout,
        signal,
        onAbort,
      });

      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  resolvePendingInput(jid: string, value: BrowserInputResolution): boolean {
    const pending = this.getPendingInput(jid);
    if (!pending?.requestId) return false;
    const waiter = this.pendingWaiters.get(pending.requestId);
    if (!waiter || waiter.jid !== jid) return false;
    waiter.resolve(value);
    return true;
  }

  cancelPendingInput(jid: string, reason: unknown = new Error("browser-input-cancelled")): boolean {
    const pending = this.pending.get(jid);
    if (!pending) return false;
    if (pending.requestId) {
      const waiter = this.pendingWaiters.get(pending.requestId);
      if (waiter) {
        waiter.reject(reason);
        return true;
      }
    }
    this.pending.delete(jid);
    return true;
  }

  clearPendingInput(jid: string): void {
    this.pending.delete(jid);
  }

  /** Compatibilidad con browser_request_credential anterior. */
  setPending(request: Omit<PendingBrowserCredentialRequest, "createdAt">): void {
    this.setPendingInput({
      jid: request.jid,
      kind: "password",
      fieldName: "contraseña",
      originalText: request.originalText,
      url: request.url,
      username: request.username,
    });
  }

  getPending(jid: string): PendingBrowserCredentialRequest | undefined {
    const pending = this.getPendingInput(jid);
    if (!pending || pending.kind !== "password" || !pending.url || !pending.username) return undefined;
    return {
      jid: pending.jid,
      originalText: pending.originalText,
      url: pending.url,
      username: pending.username,
      createdAt: pending.createdAt,
    };
  }

  clearPending(jid: string): void {
    this.clearPendingInput(jid);
  }

  private ensurePersistentState(): void {
    if (!this.persistent || this.profilesLoaded) return;
    this.profilesLoaded = true;
    mkdirSync(this.baseDir, { recursive: true });
    if (!existsSync(this.profilesPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.profilesPath, "utf8")) as BrowserCredentialProfileRecord[];
      if (Array.isArray(parsed)) {
        this.profiles = new Map(parsed
          .filter((item) => item && typeof item.ref === "string" && typeof item.encryptedPassword === "string")
          .map((item) => [item.ref, item]));
      }
    } catch {
      // Si el índice queda corrupto no exponemos secretos ni tiramos el bot.
      this.profiles = new Map();
    }
  }

  private encryptionKey(): Buffer {
    if (!this.persistent) {
      // Solo se usa en stores persistentes; esta rama mantiene tipos sencillos.
      return Buffer.alloc(32);
    }
    return Buffer.from(loadOrCreateBrowserEncryptionKey(this.keyPath), "hex");
  }

  private encryptPassword(password: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
  }

  private decryptPassword(payload: string): string {
    const [ivRaw, tagRaw, dataRaw] = payload.split(".");
    if (!ivRaw || !tagRaw || dataRaw === undefined) throw new Error("Credencial cifrada inválida.");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(ivRaw, "base64"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataRaw, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  private persistProfiles(): void {
    if (!this.persistent) return;
    const ordered = [...this.profiles.values()].sort((a, b) => a.createdAt - b.createdAt);
    writeJsonFileAtomically(this.profilesPath, ordered);
    ensureMode600(this.profilesPath);
  }

  saveProfile(input: {
    jid: string;
    url: string;
    username: string;
    password: string;
    label?: string;
  }): BrowserCredentialProfile {
    this.ensurePersistentState();
    const url = normalizeBrowserUrl(input.url);
    const origin = normalizeOrigin(url);
    const username = input.username.trim();
    if (!origin || !username || !input.password) throw new Error("URL, usuario y contraseña son obligatorios.");

    const existing = [...this.profiles.values()].find((profile) =>
      profile.jid === input.jid
      && profile.origin === origin
      && normalizeUsername(profile.username) === normalizeUsername(username));
    const now = Date.now();
    const record: BrowserCredentialProfileRecord = existing
      ? {
          ...existing,
          url,
          username,
          label: input.label?.trim() || existing.label,
          encryptedPassword: this.encryptPassword(input.password),
          updatedAt: now,
        }
      : {
          ref: `browser-profile-${randomUUID()}`,
          jid: input.jid,
          url,
          origin,
          username,
          label: input.label?.trim() || undefined,
          encryptedPassword: this.encryptPassword(input.password),
          createdAt: now,
          updatedAt: now,
        };
    this.profiles.set(record.ref, record);
    this.persistProfiles();
    return this.safeProfile(record);
  }

  saveProfileFromTemporary(ref: string, jid: string, label?: string): BrowserCredentialProfile | undefined {
    const credential = this.get(ref, jid);
    if (!credential) return undefined;
    const profile = this.saveProfile({
      jid,
      url: credential.url,
      username: credential.username,
      password: credential.password,
      label,
    });
    return profile;
  }

  listProfiles(jid: string, url?: string, username?: string): BrowserCredentialProfile[] {
    this.ensurePersistentState();
    const origin = url ? normalizeOrigin(url) : "";
    const normalizedUser = username ? normalizeUsername(username) : "";
    return [...this.profiles.values()]
      .filter((profile) => profile.jid === jid)
      .filter((profile) => !origin || profile.origin === origin)
      .filter((profile) => !normalizedUser || normalizeUsername(profile.username) === normalizedUser)
      .map((profile) => this.safeProfile(profile));
  }

  getProfile(ref: string, jid: string): BrowserCredentialProfile | undefined {
    this.ensurePersistentState();
    const profile = this.profiles.get(ref);
    return profile?.jid === jid ? this.safeProfile(profile) : undefined;
  }

  resolve(ref: string, jid: string): ResolvedBrowserCredential | undefined {
    const temporary = this.get(ref, jid);
    if (temporary) {
      return {
        ref: temporary.ref,
        source: "temporary",
        jid: temporary.jid,
        url: temporary.url,
        username: temporary.username,
        password: temporary.password,
      };
    }

    this.ensurePersistentState();
    const profile = this.profiles.get(ref);
    if (!profile || profile.jid !== jid) return undefined;
    try {
      return {
        ref: profile.ref,
        source: "profile",
        profileRef: profile.ref,
        jid: profile.jid,
        url: profile.url,
        username: profile.username,
        password: this.decryptPassword(profile.encryptedPassword),
      };
    } catch {
      return undefined;
    }
  }

  findResolved(jid: string, url: string, username?: string): ResolvedBrowserCredential[] {
    return this.listProfiles(jid, url, username)
      .flatMap((profile) => {
        const resolved = this.resolve(profile.ref, jid);
        return resolved ? [resolved] : [];
      });
  }

  markProfileUsed(ref: string, jid: string): void {
    this.ensurePersistentState();
    const profile = this.profiles.get(ref);
    if (!profile || profile.jid !== jid) return;
    profile.lastUsedAt = Date.now();
    profile.updatedAt = Date.now();
    this.persistProfiles();
  }

  deleteProfile(ref: string, jid: string): boolean {
    this.ensurePersistentState();
    const profile = this.profiles.get(ref);
    if (!profile || profile.jid !== jid) return false;
    this.profiles.delete(ref);
    this.persistProfiles();
    return true;
  }

  private safeProfile(profile: BrowserCredentialProfileRecord): BrowserCredentialProfile {
    const { encryptedPassword: _secret, ...safe } = profile;
    return { ...safe };
  }
}

export const browserCredentialStore = new BrowserCredentialStore({ persistent: true });

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
    || /(?:sesion|login).{0,20}(?:usuario|user|contrasena|password)/i.test(normalized)
    || /(?:configura|guardar|guarda|usar|usa).{0,40}(?:credencial|correo|email|usuario).{0,60}(?:contrasena|password)/i.test(normalized);
  const browserTarget = extractBrowserTarget(text);
  const usernamePatterns = [
    /(?:usuario|username|user|correo|email)\s*(?:es|:|=)?\s*["']?([^\s,;"']+)/iu,
    /(?:con\s+el\s+usuario|con\s+usuario|con\s+el\s+correo|con\s+correo)\s+["']?([^\s,;"']+)/iu,
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
  return `${sanitized}\n\n[SISTEMA: Se retiró una contraseña del mensaje antes de enviarlo al LLM. Existe la referencia segura ${credential.ref} asociada a ${credential.url} y al usuario ${credential.username}. Esta credencial NO corresponde a la contraseña de la cuenta de Luna. Su presencia NO obliga a usar el navegador y NO debe disparar ninguna herramienta automáticamente: decide la acción según la intención completa del usuario. Puedes usar ${credential.ref} con browser_auth_login o browser_credentials_save. Si browser_auth_login tiene éxito, el sistema conservará una copia cifrada para reautenticar la misma cuenta cuando la sesión web expire. Nunca pidas, reveles ni repitas la contraseña.]`;
}
