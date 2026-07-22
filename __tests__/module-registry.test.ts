import { describe, expect, it } from "bun:test";
import { moduleRegistry } from "../src/modules/catalog.ts";
import type { ToolDefinition } from "../src/ai.ts";

const user = { authenticated: true, isAdmin: false };
const admin = { authenticated: true, isAdmin: true };
const guest = { authenticated: false, isAdmin: false };

function tool(name: string): ToolDefinition {
  return { type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } };
}

describe("registro modular", () => {
  it("no expone módulos, comandos ni tools antes del login", () => {
    expect(moduleRegistry.listModules(guest)).toEqual([]);
    expect(moduleRegistry.getCommands(guest)).toEqual([]);
    expect(moduleRegistry.filterTools([tool("memory_read"), tool("admin_list_users")], guest).tools).toEqual([]);
  });

  it("separa usuario autenticado de administrador", () => {
    expect(moduleRegistry.resolveCommand("uso", user)?.moduleId).toBe("context");
    expect(moduleRegistry.resolveCommand("setup-search", user)).toBeNull();
    expect(moduleRegistry.resolveCommand("setup-search", admin)?.moduleId).toBe("search");
    expect(moduleRegistry.resolveCommand("userlist", user)).toBeNull();
    expect(moduleRegistry.resolveCommand("userlist", admin)?.moduleId).toBe("admin");
  });

  it("rechaza tools no declaradas por defecto", () => {
    const result = moduleRegistry.filterTools([tool("memory_read"), tool("tool_nueva_sin_modulo")], user);
    expect(result.tools.map((entry) => entry.function.name)).toEqual(["memory_read"]);
    expect(result.rejected).toContain("tool_nueva_sin_modulo");
  });

  it("filtra tools administrativas sin ocultar las normales", () => {
    const pool = [tool("memory_read"), tool("search_admin_status"), tool("admin_list_users")];
    expect(moduleRegistry.filterTools(pool, user).tools.map((entry) => entry.function.name)).toEqual(["memory_read"]);
    expect(moduleRegistry.filterTools(pool, admin).tools.map((entry) => entry.function.name)).toEqual([
      "memory_read", "search_admin_status", "admin_list_users",
    ]);
  });

  it("inyecta resumen de capacidades y solo instrucciones detalladas relevantes", () => {
    const search = moduleRegistry.buildCapabilityPrompt("Busca el precio actual de GPT", user);
    expect(search).toContain("search: api-search");
    expect(search).toContain("[search] Búsqueda API");
    expect(search).not.toContain("[whisper] Whisper");

    const browser = moduleRegistry.buildCapabilityPrompt("Analiza https://example.com y descarga su favicon", user);
    expect(browser).toContain("[browser] Navegador");
  });

  it("genera ayuda agrupada y oculta administración al usuario normal", () => {
    const helpUser = moduleRegistry.renderHelp(user, undefined, (name) => `!${name}`);
    expect(helpUser).toContain("CONTEXTO");
    expect(helpUser).toContain("!uso");
    expect(helpUser).not.toContain("!setup-search");
    expect(helpUser).not.toContain("ADMINISTRACIÓN");

    const helpAdmin = moduleRegistry.renderHelp(admin, "search", (name) => `!${name}`);
    expect(helpAdmin).toContain("!setup-search");
  });
});
