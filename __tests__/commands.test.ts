import { describe, it, expect } from "bun:test";
import {
  parseCommand,
  registerCommand,
  getCommands,
  dispatchCommand,
  isPositiveInteger,
} from "../src/commands.ts";

// ─── Mock de WASocket para pruebas ───────────────────────────────

function mockSock(): Parameters<typeof dispatchCommand>[2] {
  return {
    sendPresenceUpdate: async () => {},
    sendMessage: async () => ({} as never),
  } as unknown as Parameters<typeof dispatchCommand>[2];
}

describe("parseCommand", () => {
  it("parses a simple command with ! prefix", () => {
    const result = parseCommand("!ayuda");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("ayuda");
    expect(result!.args).toEqual([]);
    expect(result!.body).toBe("");
  });

  it("parses a simple command with / prefix", () => {
    const result = parseCommand("/models");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("models");
  });

  it("parses command with arguments", () => {
    const result = parseCommand("!ping extra arg");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("ping");
    expect(result!.args).toEqual(["extra", "arg"]);
    expect(result!.body).toBe("extra arg");
  });

  it("is case-insensitive for command name", () => {
    const result = parseCommand("!AYUDA");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("ayuda");
  });

  it("returns null for text without prefix", () => {
    expect(parseCommand("hola mundo")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseCommand("")).toBeNull();
  });

  it("returns null for just prefix with no name", () => {
    expect(parseCommand("!")).toBeNull();
    expect(parseCommand("/")).toBeNull();
  });

  it("returns null for prefix with only whitespace", () => {
    expect(parseCommand("!   ")).toBeNull();
  });

  it("handles leading/trailing whitespace", () => {
    const result = parseCommand("  /models  ");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("models");
  });

  it("handles mixed case command with args", () => {
    const result = parseCommand("/Ping Test 123");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("ping");
    expect(result!.args).toEqual(["Test", "123"]);
  });
});

describe("registerCommand and dispatchCommand", () => {
  const sock = mockSock();

  it("dispatches to a registered handler", async () => {
    registerCommand("test", "comando de prueba", () => ({ text: "ok" }));

    const result = await dispatchCommand(
      { name: "test", args: [], body: "" },
      "sender@s.whatsapp.net",
      sock,
    );

    expect(result).not.toBeNull();
    expect(result!.text).toBe("ok");
  });

  it("returns null for unregistered command", async () => {
    const result = await dispatchCommand(
      { name: "nonexistent", args: [], body: "" },
      "sender@s.whatsapp.net",
      sock,
    );

    expect(result).toBeNull();
  });

  it("passes senderJid to the handler", async () => {
    const jid = "123456789@s.whatsapp.net";

    registerCommand("whoami", "muestra tu JID", (_cmd, senderJid) => ({
      text: `You are ${senderJid}`,
    }));

    const result = await dispatchCommand(
      { name: "whoami", args: [], body: "" },
      jid,
      sock,
    );

    expect(result?.text).toBe(`You are ${jid}`);
  });

  it("passes parsed arguments to the handler", async () => {
    registerCommand("echo", "repite lo que escribas", (cmd) => ({
      text: cmd.body,
    }));

    const result = await dispatchCommand(
      { name: "echo", args: ["hello", "world"], body: "hello world" },
      "sender@s.whatsapp.net",
      sock,
    );

    expect(result?.text).toBe("hello world");
  });

  it("is case-insensitive for command dispatch", async () => {
    registerCommand("testcase", "prueba de case", () => ({ text: "found" }));

    const result = await dispatchCommand(
      { name: "TESTCASE", args: [], body: "" },
      "sender@s.whatsapp.net",
      sock,
    );

    expect(result?.text).toBe("found");
  });
});

describe("isPositiveInteger", () => {
  it("accepts positive integers", () => {
    expect(isPositiveInteger("1")).toBe(true);
    expect(isPositiveInteger("42")).toBe(true);
    expect(isPositiveInteger("999")).toBe(true);
  });

  it("accepts zero", () => {
    expect(isPositiveInteger("0")).toBe(true);
  });

  it("rejects negative numbers", () => {
    expect(isPositiveInteger("-1")).toBe(false);
    expect(isPositiveInteger("-5")).toBe(false);
  });

  it("rejects non-numeric strings", () => {
    expect(isPositiveInteger("abc")).toBe(false);
    expect(isPositiveInteger("1a")).toBe(false);
    expect(isPositiveInteger("")).toBe(false);
    expect(isPositiveInteger("1.5")).toBe(false);
  });

  it("handles whitespace", () => {
    expect(isPositiveInteger(" 42 ")).toBe(true);
    expect(isPositiveInteger("  7  ")).toBe(true);
  });
});

describe("getCommands", () => {
  it("returns registered commands sorted alphabetically", () => {
    const cmds = getCommands();
    expect(cmds.length).toBeGreaterThan(0);
    // Verificar que están ordenados alfabéticamente
    for (let i = 1; i < cmds.length; i++) {
      expect(
        (cmds[i - 1]?.name ?? "").localeCompare(cmds[i]?.name ?? ""),
      ).toBeLessThanOrEqual(0);
    }
  });

  it("each command has a name and description", () => {
    const cmds = getCommands();
    for (const cmd of cmds) {
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });
});
