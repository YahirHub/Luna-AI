import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAppDir } from "./utils.ts";

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
  type: "login" | "setup" | "adduser";
  step: "awaiting-username" | "awaiting-password";
  /** Nombre de usuario capturado en el paso anterior. */
  username?: string;
}

/** Formato del archivo users.json. */
interface UsersFile {
  users: UserRecord[];
  /** Sesiones activas: JID -> nombre de usuario. Se persiste para que sobreviva a reinicios. */
  sessions?: Record<string, string>;
}

// ─── AuthManager ─────────────────────────────────────────────────

export class AuthManager {
  private users: UserRecord[] = [];
  /** Mapa: JID del remitente → nombre de usuario. Persistido en disco. */
  private sessions = new Map<string, string>();
  /** Mapa: JID del remitente → acción pendiente. */
  private pendingActions = new Map<string, PendingAction>();
  private readonly usersPath: string;

  /**
   * @param testPath Opcional. Ruta personalizada para el archivo de usuarios
   *                (usado en tests para evitar contaminar datos reales).
   */
  constructor(testPath?: string) {
    this.usersPath = testPath ?? join(getAppDir(), "persistent", "users.json");
    this.load();
  }

  // ── Persistencia ─────────────────────────────────────────────

  private ensureDir(): void {
    const dir = dirname(this.usersPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private load(): void {
    try {
      if (existsSync(this.usersPath)) {
        const raw = readFileSync(this.usersPath, "utf-8");
        const data = JSON.parse(raw) as UsersFile;
        this.users = data.users ?? [];
        // Restaurar sesiones activas
        if (data.sessions) {
          this.sessions = new Map(Object.entries(data.sessions));
        }
      }
    } catch (err) {
      console.warn("[auth] Error al cargar usuarios, comenzando de cero:", err);
      this.users = [];
      this.sessions = new Map();
    }
  }

  private save(): void {
    this.ensureDir();
    try {
      const sessionsObj: Record<string, string> = {};
      for (const [jid, username] of this.sessions) {
        sessionsObj[jid] = username;
      }
      const data: UsersFile = { users: this.users, sessions: sessionsObj };
      writeFileSync(this.usersPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[auth] Error al guardar usuarios:", err);
    }
  }

  // ── Consultas ────────────────────────────────────────────────

  /** Retorna true si existe al menos un usuario registrado. */
  userExists(): boolean {
    return this.users.length > 0;
  }

  /** Busca un usuario por nombre (case-insensitive). */
  findUser(username: string): UserRecord | undefined {
    return this.users.find((u) => u.username === username.toLowerCase());
  }

  /** Retorna true si el usuario tiene rol admin. */
  isAdmin(username: string): boolean {
    const user = this.findUser(username);
    return user?.role === "admin";
  }

  // ── Gestión de usuarios ──────────────────────────────────────

  /** Crea el primer usuario administrador. */
  async createAdmin(username: string, password: string): Promise<void> {
    const normalized = username.toLowerCase();
    // Prevenir duplicados
    if (this.findUser(normalized)) {
      throw new Error(`El usuario '${normalized}' ya existe.`);
    }
    const hash = await Bun.password.hash(password);
    this.users.push({
      username: normalized,
      passwordHash: hash,
      role: "admin",
      banned: false,
      createdAt: new Date().toISOString(),
    });
    this.save();
  }

  /** Agrega un nuevo usuario (no admin). */
  async addUser(username: string, password: string, role: "admin" | "user"): Promise<void> {
    const normalized = username.toLowerCase();
    // Prevenir duplicados
    if (this.findUser(normalized)) {
      throw new Error(`El usuario '${normalized}' ya existe.`);
    }
    const hash = await Bun.password.hash(password);
    this.users.push({
      username: normalized,
      passwordHash: hash,
      role,
      banned: false,
      createdAt: new Date().toISOString(),
    });
    this.save();
  }

  /** Obtiene una copia profunda de la lista de usuarios. */
  getUserList(): UserRecord[] {
    return this.users.map((u) => ({ ...u }));
  }

  // ── Sesiones ─────────────────────────────────────────────────

  /** Verifica credenciales e inicia sesión. Retorna true si es exitoso. */
  async login(jid: string, username: string, password: string): Promise<boolean> {
    const user = this.findUser(username);
    if (!user || user.banned) {
      return false;
    }
    const match = await Bun.password.verify(password, user.passwordHash);
    if (match) {
      // Sesión única por usuario: remover sesiones existentes
      const canonical = user.username; // siempre minúsculas
      for (const [existingJid, u] of this.sessions) {
        if (u === canonical) {
          this.sessions.delete(existingJid);
        }
      }
      this.sessions.set(jid, user.username);
      this.save();
      return true;
    }
    return false;
  }

  /** Retorna true si el JID tiene una sesión activa. */
  isLoggedIn(jid: string): boolean {
    return this.sessions.has(jid);
  }

  /** Obtiene el nombre de usuario de la sesión activa para un JID. */
  getUsername(jid: string): string | undefined {
    return this.sessions.get(jid);
  }

  /** Obtiene el JID de la sesión activa para un nombre de usuario. */
  getJid(username: string): string | undefined {
    for (const [jid, u] of this.sessions) {
      if (u === username) return jid;
    }
    return undefined;
  }

  /** Cierra la sesión de un JID. */
  logout(jid: string): void {
    this.sessions.delete(jid);
    this.save();
  }

  // ── Baneo ────────────────────────────────────────────────────

  /** Marca un usuario como baneado y elimina TODAS sus sesiones activas. */
  banUser(username: string): void {
    const user = this.findUser(username);
    if (!user) return;
    user.banned = true;
    this.save();
    // Eliminar todas las sesiones de este username
    const canonical = user.username; // siempre minúsculas
    for (const [jid, u] of this.sessions) {
      if (u === canonical) {
        this.sessions.delete(jid);
      }
    }
  }

  /** Desbanea a un usuario. */
  unbanUser(username: string): void {
    const user = this.findUser(username);
    if (!user) return;
    user.banned = false;
    this.save();
  }

  // ── Acciones pendientes (flujo interactivo) ──────────────────

  /** Obtiene la acción pendiente para un JID. */
  getPendingAction(jid: string): PendingAction | undefined {
    return this.pendingActions.get(jid);
  }

  /** Establece una acción pendiente para un JID. */
  setPendingAction(jid: string, action: PendingAction): void {
    this.pendingActions.set(jid, action);
  }

  /** Elimina la acción pendiente para un JID. */
  clearPendingAction(jid: string): void {
    this.pendingActions.delete(jid);
  }
}
