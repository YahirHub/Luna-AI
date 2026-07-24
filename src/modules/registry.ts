import type { ToolDefinition } from "../ai.ts";
import type { LunaModule, ModuleAccess, ModuleSession, ResolvedModuleCommand, ModuleToolFilterResult } from "./types.ts";

function allowed(access: ModuleAccess, session: ModuleSession): boolean {
  if (!session.authenticated) return false;
  return access === "admin" ? session.isAdmin : true;
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function conditionPasses(condition: ((session: ModuleSession) => boolean) | undefined, session: ModuleSession): boolean {
  if (!condition) return true;
  try { return condition(session); } catch { return false; }
}

function moduleAvailable(module: LunaModule, session: ModuleSession): boolean {
  return allowed(module.access, session) && conditionPasses(module.availableWhen, session);
}

function promptAvailable(module: LunaModule, session: ModuleSession): boolean {
  return Boolean(module.prompt) && moduleAvailable(module, session) && conditionPasses(module.prompt?.availableWhen, session);
}

function moduleHasAvailableTools(module: LunaModule, session: ModuleSession): boolean {
  return (module.tools ?? []).some((tool) =>
    allowed(tool.access ?? module.access, session) && conditionPasses(tool.availableWhen, session)
  );
}

function capabilityAvailable(module: LunaModule, session: ModuleSession): boolean {
  return moduleAvailable(module, session) && (moduleHasAvailableTools(module, session) || promptAvailable(module, session));
}

export class ModuleRegistry {
  private readonly modules = new Map<string, LunaModule>();
  private readonly commands = new Map<string, ResolvedModuleCommand>();
  private readonly tools = new Map<string, { moduleId: string; access: ModuleAccess; defer: boolean; availableWhen?: (session: ModuleSession) => boolean }>();
  private readonly contextProviders = new Map<string, (message: string, session: ModuleSession) => string | Promise<string>>();

  register(module: LunaModule): void {
    if (this.modules.has(module.id)) throw new Error(`Módulo duplicado: ${module.id}`);
    this.modules.set(module.id, module);
    for (const command of module.commands ?? []) {
      const access = command.access ?? module.access;
      const resolved: ResolvedModuleCommand = {
        ...command,
        moduleId: module.id,
        moduleName: module.name,
        category: module.category,
        access,
      };
      for (const name of [command.name, ...(command.aliases ?? [])]) {
        const key = name.toLowerCase();
        if (this.commands.has(key)) throw new Error(`Comando duplicado: ${key}`);
        this.commands.set(key, resolved);
      }
    }
    for (const tool of module.tools ?? []) {
      if (this.tools.has(tool.name)) throw new Error(`Tool duplicada: ${tool.name}`);
      this.tools.set(tool.name, {
        moduleId: module.id,
        access: tool.access ?? module.access,
        defer: tool.defer === true,
        availableWhen: tool.availableWhen,
      });
    }
  }

  listModules(session: ModuleSession): LunaModule[] {
    if (!session.authenticated) return [];
    return [...this.modules.values()].filter((module) => moduleAvailable(module, session));
  }

  resolveCommand(name: string, session: ModuleSession): ResolvedModuleCommand | null {
    const command = this.commands.get(name.toLowerCase());
    if (!command || !allowed(command.access, session) || !conditionPasses(command.availableWhen, session)) return null;
    return command;
  }

  getCommands(session: ModuleSession): ResolvedModuleCommand[] {
    if (!session.authenticated) return [];
    const unique = new Map<string, ResolvedModuleCommand>();
    for (const command of this.commands.values()) {
      if (allowed(command.access, session) && conditionPasses(command.availableWhen, session)) unique.set(command.name, command);
    }
    return [...unique.values()].sort((a, b) => a.moduleName.localeCompare(b.moduleName) || a.name.localeCompare(b.name));
  }

  filterTools(definitions: readonly ToolDefinition[], session: ModuleSession): ModuleToolFilterResult {
    if (!session.authenticated) return { tools: [], rejected: definitions.map((tool) => tool.function.name) };
    const tools: ToolDefinition[] = [];
    const rejected: string[] = [];
    for (const definition of definitions) {
      const binding = this.tools.get(definition.function.name);
      // Una tool no declarada en un módulo se rechaza por defecto. Esto hace que
      // añadir una tool nueva requiera declarar explícitamente su superficie de acceso.
      const owner = binding ? this.modules.get(binding.moduleId) : undefined;
      if (!binding || !owner || !moduleAvailable(owner, session) || !allowed(binding.access, session) || !conditionPasses(binding.availableWhen, session)) {
        rejected.push(definition.function.name);
        continue;
      }
      tools.push(definition);
    }
    return { tools, rejected };
  }

  /**
   * Filtra tools por permisos Y por las capacidades realmente necesarias para
   * este turno. Los módulos detectados por intención se cargan automáticamente;
   * loadedModuleIds permite añadir capacidades de forma explícita mediante
   * capability_load sin reconstruir la conversación.
   */
  filterToolsForTurn(
    definitions: readonly ToolDefinition[],
    message: string,
    session: ModuleSession,
    loadedModuleIds: Iterable<string> = [],
    activatedModuleIds: Iterable<string> = [],
  ): ModuleToolFilterResult {
    if (!session.authenticated) return { tools: [], rejected: definitions.map((tool) => tool.function.name) };
    const activeIds = new Set(this.getActiveModuleIds(message, session));
    const fullyLoadedIds = new Set<string>();

    // activatedModuleIds mantiene vivas capacidades con estado (goal/agente) sin
    // convertir automáticamente toda su superficie avanzada en eager.
    for (const rawModuleId of activatedModuleIds) {
      const moduleId = rawModuleId.trim().toLowerCase();
      const module = this.modules.get(moduleId);
      if (module && moduleAvailable(module, session)) activeIds.add(module.id);
    }

    // loadedModuleIds proviene de capability_load: aquí sí se expone la
    // capacidad completa, incluidas las tools marcadas como defer.
    for (const rawModuleId of loadedModuleIds) {
      const moduleId = rawModuleId.trim().toLowerCase();
      const module = this.modules.get(moduleId);
      if (module && moduleAvailable(module, session)) {
        activeIds.add(module.id);
        fullyLoadedIds.add(module.id);
      }
    }

    const tools: ToolDefinition[] = [];
    const rejected: string[] = [];
    for (const definition of definitions) {
      const binding = this.tools.get(definition.function.name);
      const owner = binding ? this.modules.get(binding.moduleId) : undefined;
      const deferredButNotLoaded = Boolean(binding?.defer && owner && !fullyLoadedIds.has(owner.id));
      if (
        !binding || !owner || !activeIds.has(owner.id) || deferredButNotLoaded || !moduleAvailable(owner, session)
        || !allowed(binding.access, session) || !conditionPasses(binding.availableWhen, session)
      ) {
        rejected.push(definition.function.name);
        continue;
      }
      tools.push(definition);
    }
    return { tools, rejected };
  }

  getModuleForTool(toolName: string): LunaModule | null {
    const binding = this.tools.get(toolName);
    return binding ? this.modules.get(binding.moduleId) ?? null : null;
  }

  getActiveModuleIds(message: string, session: ModuleSession): string[] {
    return this.selectActiveModules(message, session).map((module) => module.id);
  }

  canLoadCapability(moduleId: string, session: ModuleSession): boolean {
    const module = this.modules.get(moduleId.trim().toLowerCase());
    return Boolean(module && capabilityAvailable(module, session));
  }

  buildCapabilityLoadTool(session: ModuleSession): ToolDefinition {
    const capabilities = this.listModules(session)
      .filter((module) => module.id !== "core")
      .filter((module) => capabilityAvailable(module, session))
      .sort((left, right) => left.id.localeCompare(right.id));
    const ids = capabilities.map((module) => module.id);
    const compactCatalog = capabilities
      .map((module) => `${module.id}=${module.description}`)
      .join("; ");
    return {
      type: "function",
      function: {
        name: "capability_load",
        description: [
          "Carga para ESTE TURNO una capacidad adicional y expone sus tools en la siguiente ronda. Úsala solo cuando la herramienta necesaria no esté disponible todavía.",
          compactCatalog ? `Capacidades: ${compactCatalog}.` : "No hay capacidades adicionales disponibles.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            capability: ids.length > 0
              ? { type: "string", enum: ids, description: "ID de la capacidad que falta." }
              : { type: "string", description: "ID de la capacidad que falta." },
          },
          required: ["capability"],
          additionalProperties: false,
        },
      },
    };
  }

  async buildLoadedCapabilityContext(
    moduleId: string,
    message: string,
    session: ModuleSession,
    includeInstructions = true,
  ): Promise<string> {
    const module = this.modules.get(moduleId.trim().toLowerCase());
    if (!module || !moduleAvailable(module, session)) return `Error: capacidad no disponible: ${moduleId}`;
    const lines = [`Capacidad cargada: ${module.id} (${module.name}).`];
    if (promptAvailable(module, session)) {
      if (includeInstructions) {
        for (const instruction of module.prompt?.instructions ?? []) lines.push(`- ${instruction}`);
      }
      for (const instruction of module.prompt?.loadInstructions ?? []) lines.push(`- ${instruction}`);
    }
    const provider = this.contextProviders.get(module.id);
    if (provider) {
      try {
        const context = (await provider(message, session)).trim();
        if (context) lines.push("", "Contexto actual:", context);
      } catch {
        // El contexto auxiliar no debe impedir cargar las tools.
      }
    }
    return lines.join("\n");
  }


  bindContextProvider(moduleId: string, provider: (message: string, session: ModuleSession) => string | Promise<string>): void {
    if (!this.modules.has(moduleId)) throw new Error(`No se puede enlazar contexto a un módulo inexistente: ${moduleId}`);
    this.contextProviders.set(moduleId, provider);
  }

  async buildRuntimeContext(message: string, session: ModuleSession, loadedModuleIds: Iterable<string> = []): Promise<string> {
    if (!session.authenticated) return "";
    const selectedIds = new Set(this.selectActiveModules(message, session).map((module) => module.id));
    for (const rawModuleId of loadedModuleIds) {
      const module = this.modules.get(rawModuleId.trim().toLowerCase());
      if (module && moduleAvailable(module, session)) selectedIds.add(module.id);
    }
    const blocks: string[] = [];
    for (const moduleId of selectedIds) {
      const provider = this.contextProviders.get(moduleId);
      if (!provider) continue;
      const value = (await provider(message, session)).trim();
      if (value) blocks.push(`[${moduleId}]\n${value}`);
    }
    return blocks.length ? `=== CONTEXTO DE MÓDULOS ACTIVOS ===\n${blocks.join("\n\n")}\n=== FIN DEL CONTEXTO DE MÓDULOS ===` : "";
  }

  private selectActiveModules(message: string, session: ModuleSession): LunaModule[] {
    const modules = this.listModules(session);
    const normalized = normalize(message);
    return modules.filter((module) => {
      const prompt = module.prompt;
      if (!prompt || !promptAvailable(module, session)) return false;
      if (prompt.always) return true;
      if (prompt.activateWhen) {
        try { if (prompt.activateWhen(message, session)) return true; } catch { /* capability unavailable */ }
      }
      if (prompt.keywords?.some((keyword) => normalized.includes(normalize(keyword)))) return true;
      return prompt.patterns?.some((pattern) => { pattern.lastIndex = 0; return pattern.test(message); }) ?? false;
    });
  }
  buildCapabilityPrompt(message: string, session: ModuleSession, loadedModuleIds: Iterable<string> = []): string {
    const activeById = new Map(this.selectActiveModules(message, session).map((module) => [module.id, module]));
    for (const rawModuleId of loadedModuleIds) {
      const module = this.modules.get(rawModuleId.trim().toLowerCase());
      if (module && moduleAvailable(module, session) && promptAvailable(module, session)) activeById.set(module.id, module);
    }
    const active = [...activeById.values()];
    if (active.length === 0) return "";
    const lines = ["=== INSTRUCCIONES DE CAPACIDADES ACTIVAS ==="];
    for (const module of active) {
      lines.push(`[${module.id}] ${module.name}`);
      for (const instruction of module.prompt?.instructions ?? []) lines.push(`- ${instruction}`);
    }
    lines.push(
      "",
      "Si durante este turno necesitas una capacidad cuya tool no esté disponible, usa capability_load; no inventes una herramienta ausente.",
      "=== FIN DE CAPACIDADES ACTIVAS ===",
    );
    return lines.join("\n");
  }

  renderHelp(session: ModuleSession, moduleId?: string, formatName: (name: string) => string = (name) => `!${name}`): string {
    if (!session.authenticated) return "🔒 Debes iniciar sesión primero. Envía !login";
    const requested = moduleId?.trim().toLowerCase();
    const availableModules = this.listModules(session);
    const commands = this.getCommands(session);
    const visibleModules = availableModules.filter((module) =>
      promptAvailable(module, session) || commands.some((command) => command.moduleId === module.id)
    );
    const selectedModules = requested
      ? visibleModules.filter((module) => module.id === requested)
      : visibleModules;
    if (requested && selectedModules.length === 0) return `❓ El módulo '${requested}' no está disponible para esta sesión.`;

    const lines = ["🤖 COMANDOS Y MÓDULOS DISPONIBLES"];
    for (const module of selectedModules) {
      const moduleCommands = commands.filter((command) => command.moduleId === module.id);
      lines.push("", `${module.name.toUpperCase()} · ${module.description}`);
      if (moduleCommands.length === 0) {
        lines.push("- Sin comando directo; úsalo mediante lenguaje natural.");
      } else {
        for (const command of moduleCommands) lines.push(`${formatName(command.name)} — ${command.description}`);
      }
    }
    lines.push("", "💬 También puedes pedirme estas capacidades en lenguaje natural.");
    if (!requested) lines.push("Usa !ayuda <módulo> para ver una capacidad concreta.");
    return lines.join("\n");
  }
}
