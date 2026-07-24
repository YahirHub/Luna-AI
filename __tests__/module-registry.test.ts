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

  it("expone por turno solo las tools de módulos activos y permite lazy loading explícito", () => {
    const pool = [
      tool("capability_load"),
      tool("control_ping"),
      tool("memory_read"),
      tool("workspace_read_text"),
      tool("workspace_write_text"),
      tool("tts_speak"),
    ];
    const simple = moduleRegistry.filterToolsForTurn(pool, "hola, ¿cómo estás?", user);
    expect(simple.tools.map((entry) => entry.function.name)).toEqual(["capability_load", "control_ping"]);

    const memory = moduleRegistry.filterToolsForTurn(pool, "recuerda que prefiero respuestas breves", user);
    expect(memory.tools.map((entry) => entry.function.name)).toContain("memory_read");
    expect(memory.tools.map((entry) => entry.function.name)).not.toContain("workspace_read_text");

    const intentOnly = moduleRegistry.filterToolsForTurn(pool, "edita el proyecto", user);
    expect(intentOnly.tools.map((entry) => entry.function.name)).toContain("workspace_read_text");
    expect(intentOnly.tools.map((entry) => entry.function.name)).not.toContain("workspace_write_text");

    const loaded = moduleRegistry.filterToolsForTurn(pool, "hola", user, ["workspace"]);
    expect(loaded.tools.map((entry) => entry.function.name)).toContain("workspace_read_text");
    expect(loaded.tools.map((entry) => entry.function.name)).toContain("workspace_write_text");
    expect(loaded.tools.map((entry) => entry.function.name)).not.toContain("tts_speak");
  });

  it("difiere también las instrucciones avanzadas hasta capability_load", async () => {
    const prompt = moduleRegistry.buildCapabilityPrompt("edita el proyecto", user);
    expect(prompt).toContain("Inspecciona primero el workdir");
    expect(prompt).not.toContain("workspace_exec está confinado");

    const loaded = await moduleRegistry.buildLoadedCapabilityContext("workspace", "edita el proyecto", user, false);
    expect(loaded).toContain("workspace_exec está confinado");
    expect(loaded).not.toContain("Inspecciona primero el workdir");
  });

  it("capability_load publica un índice compacto sin cargar schemas de todos los módulos", () => {
    const definition = moduleRegistry.buildCapabilityLoadTool(user);
    expect(definition.function.name).toBe("capability_load");
    expect(definition.function.description).toContain("workspace=");
    expect(definition.function.description).toContain("skills=");
    expect(definition.function.description).not.toContain("admin=");
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
    const request = "Busca el precio actual de GPT";
    const prompt = moduleRegistry.buildCapabilityPrompt(request, user);
    const routedTools = moduleRegistry.filterToolsForTurn(
      [tool("researcher_web"), tool("browser_agent")],
      request,
      user,
    ).tools.map((entry) => entry.function.name);
    if (isApiSearchCapabilityAvailable()) {
      expect(prompt).toContain("[search] Búsqueda API");
      expect(routedTools).toContain("researcher_web");
      expect(routedTools).not.toContain("browser_agent");
    } else {
      expect(prompt).not.toContain("[search] Búsqueda API");
      expect(prompt).toContain("[browser] Navegador");
      expect(routedTools).toContain("browser_agent");
      expect(routedTools).not.toContain("researcher_web");
    }
    expect(prompt).not.toContain("[whisper] Whisper");
    expect(prompt).not.toContain("CAPACIDADES MODULARES DISPONIBLES");

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
