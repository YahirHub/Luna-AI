import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "src", "bot.ts"), "utf8");

describe("bootstrap de autenticación frente al registro modular", () => {
  it("despacha setup/login directamente antes de consultar ModuleRegistry", () => {
    const bootstrap = source.indexOf('if (command.name === "setup" || command.name === "login")');
    const modular = source.indexOf("const moduleCommand = moduleRegistry.resolveCommand", bootstrap);
    expect(bootstrap).toBeGreaterThan(-1);
    expect(modular).toBeGreaterThan(bootstrap);
    expect(source.slice(bootstrap, modular)).toContain("dispatchCommand(command, remoteJid, sock)");
  });

  it("mantiene cerradas las demás capacidades antes del login", () => {
    expect(source).toContain('if (!authManager.userExists())');
    expect(source).toContain('["setup", "cancelar"].includes(command.name)');
    expect(source).toContain('["login", "cancelar"].includes(command.name)');
    expect(source).toContain("moduleRegistry.resolveCommand(command.name, getModuleSession(remoteJid))");
  });
});
