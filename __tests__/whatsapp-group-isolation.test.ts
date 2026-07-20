import { describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthManager } from "../src/auth.ts";
import { isWhatsAppGroupJid } from "../src/whatsapp-message-guard.ts";

describe("aislamiento de grupos de WhatsApp", () => {
  it("identifica JIDs de grupo sin confundir chats privados", () => {
    expect(isWhatsAppGroupJid("120363123456789@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("521234567890@s.whatsapp.net")).toBe(false);
    expect(isWhatsAppGroupJid(undefined)).toBe(false);
  });

  it("rechaza login directo desde un JID de grupo", async () => {
    const path = join(tmpdir(), `luna-group-login-${Date.now()}.json`);
    const auth = new AuthManager(path);

    try {
      await auth.createAdmin("admin", "pass1234");
      const loggedIn = await auth.login(
        "120363123456789@g.us",
        "admin",
        "pass1234",
      );

      expect(loggedIn).toBe(false);
      expect(auth.isLoggedIn("120363123456789@g.us")).toBe(false);
      expect(auth.getJid("admin")).toBeUndefined();
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("descarta sesiones de grupo antiguas al cargar users.json", async () => {
    const path = join(tmpdir(), `luna-group-session-${Date.now()}.json`);
    const auth = new AuthManager(path);

    try {
      await auth.createAdmin("admin", "pass1234");
      await auth.login("521234567890@s.whatsapp.net", "admin", "pass1234");

      const data = JSON.parse(readFileSync(path, "utf8")) as {
        users: unknown[];
        sessions: Record<string, string>;
      };
      data.sessions = { "120363123456789@g.us": "admin" };
      writeFileSync(path, JSON.stringify(data, null, 2));

      const reloaded = new AuthManager(path);
      expect(reloaded.isLoggedIn("120363123456789@g.us")).toBe(false);
      expect(reloaded.getJid("admin")).toBeUndefined();

      const sanitized = JSON.parse(readFileSync(path, "utf8")) as {
        sessions?: Record<string, string>;
      };
      expect(sanitized.sessions?.["120363123456789@g.us"]).toBeUndefined();
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("filtra grupos antes de invocar el procesador principal", async () => {
    const source = await Bun.file(new URL("../src/connection.ts", import.meta.url)).text();
    expect(source).toContain("if (isWhatsAppGroupJid(remoteJid))");
    expect(source).toContain("continue;");
  });

  it("mantiene una segunda barrera antes de marcar mensajes como leídos", async () => {
    const source = await Bun.file(new URL("../src/bot.ts", import.meta.url)).text();
    const guardIndex = source.indexOf(
      "if (!remoteJid || fromMe || isWhatsAppGroupJid(remoteJid))",
    );
    const readIndex = source.indexOf("sock.readMessages([key])", guardIndex);

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(guardIndex);
  });
});
