import { join } from "node:path";
import { getAppDir } from "./utils.ts";
import { readJsonFile, writeJsonFileAtomically } from "./storage.ts";
import { isWhatsAppGroupJid } from "./whatsapp-message-guard.ts";

// ─── Types ───────────────────────────────────────────────────────

/** Registro persistente de un usuario. */
export interface UserRecord {
  username: string;
  passwordHash: string;
  role: "admin" | "user";
  banned: boolean;
  createdAt: string;
}

/** Estado de una acción interactiva pendiente (login, setup, adduser). */
export interface PendingAction {
  type: "login" | "setup" | "adduser" | "change-password";
  step: "awaiting-username" | "awaiting-password";
  /** Nombre de usuario capturado en el paso anterior. */
  username?: string;
}

/** Formato del archivo users.json. */
interface UsersFile {
  users: UserRecord[];
  /** Sesiones activas: JID -> nombre de usuario. */
  sessions?: Record<string, string>;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function isUserRecord(value: unknown): value is UserRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<UserRecord>;
  return (
    typeof record.username === "string" &&
    typeof record.passwordHash === "string" &&
    (record.role === "admin" || record.role === "user") &&
    typeof record.banned === "boolean" &&
    typeof record.createdAt === "string"
  );
}

// ─── AuthManager ─────────────────────────────────────────────────

export class AuthManager {
  private users: UserRecord[] = [];
  /** Mapa: JID del remitente → nombre de usuario. Persistido en disco. */
  private sessions = new Map<string, string>();
  /** Mapa: JID del remitente → acción pendiente. */
  private pendingActions = new Map<string, PendingAction>();
  private readonly usersPath: string;

  constructor(testPath?: string) {
    this.usersPath = testPath ?? join(getAppDir(), "persistent", "users.json");
    this.load();
  }

  // ── Persistencia ─────────────────────────────────────────────

  private load(): void {
    try {
      const data = readJsonFile<UsersFile>(this.usersPath);
      if (!data) return;

      this.users = Array.isArray(data.users)
        ? data.users.filter(isUserRecord).map((user) => ({
            ...user,
            username: normalizeUsername(user.username),
          }))
        : [];

      const validUsers = new Map(this.users.map((user) => [user.username, user]));
      const rawSessions = Object.entries(data.sessions ?? {});
      const restoredSessions = rawSessions.filter(([jid, username]) => {
        if (typeof username !== "string" || isWhatsAppGroupJid(jid)) return false;
        const user = validUsers.get(normalizeUsername(username));
        return Boolean(jid && user && !user.banned);
      });
      this.sessions = new Map(restoredSessions.map(([jid, username]) => [jid, normalizeUsername(username)]));
      if (rawSessions.some(([jid]) => isWhatsAppGroupJid(jid))) this.save();
    } catch (err) {
      console.warn("[auth] Error al cargar usuarios, comenzando de cero:", err);
      this.users = [];
      this.sessions = new Map();
    }
  }

  private save(): void {
    const sessions = Object.fromEntries(this.sessions);
    writeJsonFileAtomically(this.usersPath, { users: this.users, sessions });
  }

  /** Revierte usuarios y sesiones si el cambio no puede persistirse. */
  private persistMutation<T>(mutate: () => T): T {
    const usersSnapshot = this.users.map((user) => ({ ...user }));
    const sessionsSnapshot = new Map(this.sessions);
    try {
      const result = mutate();
      this.save();
      return result;
    } catch (err) {
      this.users = usersSnapshot;
      this.sessions = sessionsSnapshot;
      throw err;
    }
  }

  // ── Consultas ────────────────────────────────────────────────

  userExists(): boolean {
    return this.users.length > 0;
  }

  findUser(username: string): UserRecord | undefined {
    const normalized = normalizeUsername(username);
    return this.users.find((user) => user.username === normalized);
  }

  isAdmin(username: string): boolean {
    return this.findUser(username)?.role === "admin";
  }

  // ── Gestión de usuarios ──────────────────────────────────────

  async createAdmin(username: string, password: string): Promise<void> {
    await this.createUser(username, password, "admin");
  }

  async addUser(
    username: string,
    password: string,
    role: "admin" | "user",
  ): Promise<void> {
    await this.createUser(username, password, role);
  }

  private async createUser(
    username: string,
    password: string,
    role: "admin" | "user",
  ): Promise<void> {
    const normalized = normalizeUsername(username);
    if (!normalized) {
      throw new Error("El nombre de usuario no puede estar vacío.");
    }
    if (this.findUser(normalized)) {
      throw new Error(`El usuario '${normalized}' ya existe.`);
    }

    const passwordHash = await Bun.password.hash(password);
    const user: UserRecord = {
      username: normalized,
      passwordHash,
      role,
      banned: false,
      createdAt: new Date().toISOString(),
    };
    this.persistMutation(() => this.users.push(user));
  }

  getUserList(): UserRecord[] {
    return this.users.map((user) => ({ ...user }));
  }

  /** Cambia la contraseña de un usuario existente conservando sus sesiones activas. */
  async changePassword(username: string, password: string): Promise<void> {
    const user = this.findUser(username);
    if (!user) throw new Error(`El usuario '${normalizeUsername(username)}' no existe.`);
    if (!password || password.length < 4) {
      throw new Error("La contraseña debe tener al menos 4 caracteres.");
    }
    const passwordHash = await Bun.password.hash(password);
    this.persistMutation(() => {
      user.passwordHash = passwordHash;
    });
  }

  // ── Sesiones ─────────────────────────────────────────────────

  async login(jid: string, username: string, password: string): Promise<boolean> {
    if (isWhatsAppGroupJid(jid)) return false;
    const user = this.findUser(username);
    if (!user || user.banned) return false;

    const match = await Bun.password.verify(password, user.passwordHash);
    if (!match) return false;

    this.persistMutation(() => {
      for (const [existingJid, existingUsername] of this.sessions) {
        if (existingUsername === user.username) {
          this.sessions.delete(existingJid);
        }
      }
      this.sessions.set(jid, user.username);
    });
    return true;
  }

  isLoggedIn(jid: string): boolean {
    return !isWhatsAppGroupJid(jid) && this.sessions.has(jid);
  }

  getUsername(jid: string): string | undefined {
    return isWhatsAppGroupJid(jid) ? undefined : this.sessions.get(jid);
  }

  getJid(username: string): string | undefined {
    const normalized = normalizeUsername(username);
    for (const [jid, activeUsername] of this.sessions) {
      if (activeUsername === normalized) return jid;
    }
    return undefined;
  }

  logout(jid: string): void {
    if (!this.sessions.has(jid)) return;
    this.persistMutation(() => this.sessions.delete(jid));
  }

  // ── Baneo ────────────────────────────────────────────────────

  /** Marca un usuario como baneado y elimina TODAS sus sesiones activas. */
  banUser(username: string): void {
    const user = this.findUser(username);
    if (!user) return;

    this.persistMutation(() => {
      user.banned = true;
      for (const [jid, activeUsername] of this.sessions) {
        if (activeUsername === user.username) {
          this.sessions.delete(jid);
        }
      }
    });
  }

  unbanUser(username: string): void {
    const user = this.findUser(username);
    if (!user) return;
    this.persistMutation(() => {
      user.banned = false;
    });
  }

  // ── Acciones pendientes (flujo interactivo) ──────────────────

  getPendingAction(jid: string): PendingAction | undefined {
    return this.pendingActions.get(jid);
  }

  setPendingAction(jid: string, action: PendingAction): void {
    this.pendingActions.set(jid, action);
  }

  clearPendingAction(jid: string): void {
    this.pendingActions.delete(jid);
  }
}
