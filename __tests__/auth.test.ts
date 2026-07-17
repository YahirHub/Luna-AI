import { describe, it, expect } from "bun:test";
import { rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthManager } from "../src/auth.ts";

// ─── Helpers ─────────────────────────────────────────────────────

let testCounter = 0;

/**
 * Crea un AuthManager que escribe en un archivo temporal único.
 * Esto garantiza aislamiento total entre tests y no contamina
 * los datos reales de persistent/users.json.
 */
function createIsolatedAuth(): AuthManager {
  testCounter++;
  const tmpPath = join(tmpdir(), `codewolf-auth-test-${Date.now()}-${testCounter}.json`);
  return new AuthManager(tmpPath);
}

// ─── Tests ───────────────────────────────────────────────────────

describe("AuthManager — estado inicial", () => {
  it("comienza sin usuarios", () => {
    const auth = createIsolatedAuth();
    expect(auth.userExists()).toBe(false);
  });

  it("findUser retorna undefined para usuario inexistente", () => {
    const auth = createIsolatedAuth();
    expect(auth.findUser("nadie")).toBeUndefined();
  });

  it("getUserList retorna array vacío", () => {
    const auth = createIsolatedAuth();
    expect(auth.getUserList()).toEqual([]);
  });
});

describe("AuthManager — creación de admin", () => {
  it("createAdmin agrega el primer usuario como admin", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin1", "pass1234");

    expect(auth.userExists()).toBe(true);
    const user = auth.findUser("admin1");
    expect(user).toBeDefined();
    expect(user!.role).toBe("admin");
    expect(user!.banned).toBe(false);
    expect(user!.username).toBe("admin1");
    expect(user!.createdAt).toBeDefined();
  });

  it("createAdmin es case-insensitive para username", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("AdminTest", "pass1234");

    expect(auth.findUser("admintest")).toBeDefined();
    expect(auth.findUser("ADMINTEST")).toBeDefined();
    expect(auth.findUser("AdminTest")).toBeDefined();
  });

  it("isAdmin retorna true para admin", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("root", "pass1234");

    expect(auth.isAdmin("root")).toBe(true);
  });

  it("isAdmin retorna false para usuario no existente", async () => {
    const auth = createIsolatedAuth();
    expect(auth.isAdmin("ghost")).toBe(false);
  });

  it("createAdmin rechaza usuarios duplicados", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass1234");
    expect(auth.createAdmin("admin", "otra")).rejects.toThrow();
  });
});

describe("AuthManager — consistencia de persistencia", () => {
  it("revierte el usuario en memoria cuando no puede guardar", async () => {
    const blocker = join(tmpdir(), `codewolf-auth-blocker-${Date.now()}`);
    writeFileSync(blocker, "no es un directorio");
    const auth = new AuthManager(join(blocker, "users.json"));

    await expect(auth.createAdmin("admin", "pass1234")).rejects.toThrow();
    expect(auth.userExists()).toBe(false);

    rmSync(blocker, { force: true });
  });
});

describe("AuthManager — addUser", () => {
  it("addUser crea usuario con rol user", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass1234");
    await auth.addUser("pedro", "pedro123", "user");

    const user = auth.findUser("pedro");
    expect(user).toBeDefined();
    expect(user!.role).toBe("user");
    expect(user!.banned).toBe(false);
  });

  it("isAdmin retorna false para usuarios normales", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass1234");
    await auth.addUser("user1", "pass1234", "user");

    expect(auth.isAdmin("user1")).toBe(false);
  });

  it("addUser rechaza usuarios duplicados", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");
    expect(auth.addUser("admin", "pass", "user")).rejects.toThrow();
  });
});

describe("AuthManager — login y sesiones", () => {
  it("login exitoso con credenciales correctas", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "mypassword");

    const result = await auth.login(
      "jid123@s.whatsapp.net",
      "admin",
      "mypassword",
    );
    expect(result).toBe(true);
    expect(auth.isLoggedIn("jid123@s.whatsapp.net")).toBe(true);
    expect(auth.getUsername("jid123@s.whatsapp.net")).toBe("admin");
  });

  it("login falla con contraseña incorrecta", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "correcta");

    const result = await auth.login(
      "jid1@s.whatsapp.net",
      "admin",
      "incorrecta",
    );
    expect(result).toBe(false);
    expect(auth.isLoggedIn("jid1@s.whatsapp.net")).toBe(false);
  });

  it("login falla con usuario inexistente", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");

    const result = await auth.login("jid1@s.whatsapp.net", "ghost", "pass");
    expect(result).toBe(false);
  });

  it("login falla con usuario baneado", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");
    auth.banUser("admin");

    const result = await auth.login("jid1@s.whatsapp.net", "admin", "pass");
    expect(result).toBe(false);
  });

  it("getJid retorna el JID de una sesión activa", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");
    await auth.login("jid999@s.whatsapp.net", "admin", "pass");

    expect(auth.getJid("admin")).toBe("jid999@s.whatsapp.net");
  });

  it("getJid retorna undefined si no hay sesión", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");

    expect(auth.getJid("admin")).toBeUndefined();
  });

  it("logout cierra la sesión", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");
    await auth.login("jid1@s.whatsapp.net", "admin", "pass");
    expect(auth.isLoggedIn("jid1@s.whatsapp.net")).toBe(true);

    auth.logout("jid1@s.whatsapp.net");
    expect(auth.isLoggedIn("jid1@s.whatsapp.net")).toBe(false);
  });

  it("las sesiones persisten al recargar desde disco", async () => {
    const sessionPath = join(tmpdir(), `codewolf-auth-session-test-${Date.now()}.json`);

    // Crear usuario e iniciar sesión
    const auth1 = new AuthManager(sessionPath);
    await auth1.createAdmin("persist", "password");
    await auth1.login("jid999@s.whatsapp.net", "persist", "password");
    expect(auth1.isLoggedIn("jid999@s.whatsapp.net")).toBe(true);
    expect(auth1.getUsername("jid999@s.whatsapp.net")).toBe("persist");

    // Simular reinicio: crear nueva instancia que lee el mismo archivo
    const auth2 = new AuthManager(sessionPath);
    expect(auth2.isLoggedIn("jid999@s.whatsapp.net")).toBe(true);
    expect(auth2.getUsername("jid999@s.whatsapp.net")).toBe("persist");
    expect(auth2.userExists()).toBe(true);

    // Limpiar
    try { unlinkSync(sessionPath); } catch {}
  });
});

describe("AuthManager — baneo", () => {
  it("banUser marca como baneado", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");
    await auth.addUser("user1", "pass", "user");

    auth.banUser("user1");
    expect(auth.findUser("user1")!.banned).toBe(true);
  });

  it("banUser elimina la sesión activa", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");
    await auth.login("jid1@s.whatsapp.net", "admin", "pass");
    expect(auth.isLoggedIn("jid1@s.whatsapp.net")).toBe(true);

    auth.banUser("admin");
    expect(auth.isLoggedIn("jid1@s.whatsapp.net")).toBe(false);
  });

  it("unbanUser restaura el acceso", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");
    auth.banUser("admin");
    expect(auth.findUser("admin")!.banned).toBe(true);

    auth.unbanUser("admin");
    expect(auth.findUser("admin")!.banned).toBe(false);
  });

  it("banUser y unbanUser son no-op para usuarios inexistentes", () => {
    const auth = createIsolatedAuth();
    expect(() => auth.banUser("ghost")).not.toThrow();
    expect(() => auth.unbanUser("ghost")).not.toThrow();
  });
});

describe("AuthManager — getUserList", () => {
  it("retorna copia de todos los usuarios", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");
    await auth.addUser("user1", "pass", "user");
    await auth.addUser("user2", "pass", "user");

    const list = auth.getUserList();
    expect(list).toHaveLength(3);
    expect(list.map((u) => u.username)).toEqual(
      expect.arrayContaining(["admin", "user1", "user2"]),
    );
  });

  it("modificar la copia no afecta el original", async () => {
    const auth = createIsolatedAuth();
    await auth.createAdmin("admin", "pass");

    const list = auth.getUserList();
    list[0]!.username = "hacked";
    list[0]!.role = "user";

    // El original no debe haber cambiado
    const original = auth.findUser("admin");
    expect(original).toBeDefined();
    expect(original!.username).toBe("admin");
    expect(original!.role).toBe("admin");

    // El usuario "hacked" no debe existir en el manager
    expect(auth.findUser("hacked")).toBeUndefined();
  });
});

describe("AuthManager — pending actions", () => {
  it("setPendingAction y getPendingAction funcionan", () => {
    const auth = createIsolatedAuth();
    const jid = "test@s.whatsapp.net";

    expect(auth.getPendingAction(jid)).toBeUndefined();

    auth.setPendingAction(jid, { type: "login", step: "awaiting-username" });
    const action = auth.getPendingAction(jid);
    expect(action).toBeDefined();
    expect(action!.type).toBe("login");
    expect(action!.step).toBe("awaiting-username");
  });

  it("clearPendingAction elimina la acción", () => {
    const auth = createIsolatedAuth();
    const jid = "test@s.whatsapp.net";

    auth.setPendingAction(jid, { type: "setup", step: "awaiting-username" });
    expect(auth.getPendingAction(jid)).toBeDefined();

    auth.clearPendingAction(jid);
    expect(auth.getPendingAction(jid)).toBeUndefined();
  });

  it("las acciones pendientes son independientes por JID", () => {
    const auth = createIsolatedAuth();
    auth.setPendingAction("jid1@s.whatsapp.net", {
      type: "login",
      step: "awaiting-username",
    });
    auth.setPendingAction("jid2@s.whatsapp.net", {
      type: "login",
      step: "awaiting-password",
      username: "admin",
    });

    expect(auth.getPendingAction("jid1@s.whatsapp.net")!.type).toBe("login");
    expect(auth.getPendingAction("jid2@s.whatsapp.net")!.step).toBe(
      "awaiting-password",
    );
    expect(auth.getPendingAction("jid2@s.whatsapp.net")!.username).toBe("admin");

    auth.clearPendingAction("jid1@s.whatsapp.net");
    expect(auth.getPendingAction("jid1@s.whatsapp.net")).toBeUndefined();
    expect(auth.getPendingAction("jid2@s.whatsapp.net")).toBeDefined();
  });
});

describe("AuthManager — persistencia de baneo", () => {
  it("no restaura una sesión eliminada por banUser", async () => {
    const path = join(tmpdir(), `luna-auth-ban-persist-${Date.now()}.json`);
    const auth = new AuthManager(path);
    await auth.createAdmin("admin", "pass1234");
    await auth.login("jid-ban@s.whatsapp.net", "admin", "pass1234");

    auth.banUser("admin");

    const reloaded = new AuthManager(path);
    expect(reloaded.isLoggedIn("jid-ban@s.whatsapp.net")).toBe(false);
    expect(reloaded.findUser("admin")?.banned).toBe(true);

    try { unlinkSync(path); } catch {}
  });
});
