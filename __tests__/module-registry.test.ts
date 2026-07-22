import { describe, expect, it } from "bun:test";
import { moduleRegistry } from "../src/modules/catalog.ts";
import { ModuleRegistry } from "../src/modules/registry.ts";
import type { ToolDefinition } from "../src/ai.ts";
import { isApiSearchCapabilityAvailable } from "../src/search/search-routing.ts";

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

  it("expone goals y tasklists solo después del login", () => {
    const pool = [tool("goal_start"), tool("goal_status"), tool("tasklist_create")];
    expect(moduleRegistry.filterTools(pool, guest).tools).toEqual([]);
    expect(moduleRegistry.filterTools(pool, user).tools.map((entry) => entry.function.name)).toEqual([
      "goal_start", "goal_status", "tasklist_create",
    ]);
    expect(moduleRegistry.resolveCommand("goal", user)?.moduleId).toBe("goals");
    expect(moduleRegistry.resolveCommand("tasklist", user)).toBeNull();
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

  it("permite condiciones dinámicas independientes para prompt y tools", () => {
    let backendReady = false;
    const registry = new ModuleRegistry();
    registry.register({
      id: "dynamic-test",
      name: "Dynamic test",
      description: "capacidad condicional",
      category: "test",
      access: "authenticated",
      scope: "global",
      commands: [{ name: "setup-dynamic", description: "configura el backend", access: "admin" }],
      tools: [{ name: "dynamic_tool", availableWhen: () => backendReady }],
      prompt: {
        summary: "backend dinámico disponible",
        availableWhen: () => backendReady,
        keywords: ["dinámico"],
        instructions: ["usa dynamic_tool"],
      },
    });

    expect(registry.filterTools([tool("dynamic_tool")], user).tools).toEqual([]);
    expect(registry.buildCapabilityPrompt("usa dinámico", user)).not.toContain("backend dinámico disponible");
    expect(registry.resolveCommand("setup-dynamic", admin)?.moduleId).toBe("dynamic-test");

    backendReady = true;
    expect(registry.filterTools([tool("dynamic_tool")], user).tools.map((entry) => entry.function.name)).toEqual(["dynamic_tool"]);
    expect(registry.buildCapabilityPrompt("usa dinámico", user)).toContain("[dynamic-test] Dynamic test");
  });

  it("inyecta api-search solo cuando existe un proveedor y activa browser como fallback", () => {
    const prompt = moduleRegistry.buildCapabilityPrompt("Busca el precio actual de GPT", user);
    const searchTool = moduleRegistry.filterTools([tool("researcher_web")], user).tools;
    if (isApiSearchCapabilityAvailable()) {
      expect(prompt).toContain("search: api-search");
      expect(prompt).toContain("[search] Búsqueda API");
      expect(searchTool.map((entry) => entry.function.name)).toEqual(["researcher_web"]);
    } else {
      expect(prompt).not.toContain("search: api-search");
      expect(prompt).not.toContain("[search] Búsqueda API");
      expect(prompt).toContain("[browser] Navegador");
      expect(prompt).toContain("dogpile.com");
      expect(searchTool).toEqual([]);
    }
    expect(prompt).not.toContain("[whisper] Whisper");

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
