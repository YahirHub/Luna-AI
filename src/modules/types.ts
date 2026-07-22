import type { ToolDefinition } from "../ai.ts";

export type ModuleAccess = "authenticated" | "admin";
export type ModuleScope = "global" | "user" | "hybrid";
export type ModuleCondition = (session: ModuleSession) => boolean;
export type ModuleActivationCondition = (message: string, session: ModuleSession) => boolean;

export interface ModuleSession {
  authenticated: boolean;
  isAdmin: boolean;
  /** JID actual cuando existe una sesión autenticada. Permite contexto dinámico por usuario sin globales duplicadas. */
  jid?: string;
}

export interface ModuleCommandDefinition {
  name: string;
  description: string;
  access?: ModuleAccess;
  aliases?: string[];
  usage?: string[];
  /** Condición dinámica adicional. Los comandos de bootstrap no pasan por este registro. */
  availableWhen?: ModuleCondition;
}

export interface ModuleToolDefinition {
  name: string;
  access?: ModuleAccess;
  /** Permite retirar la tool del request cuando su backend/configuración no está disponible. */
  availableWhen?: ModuleCondition;
}

export interface ModulePromptDefinition {
  summary: string;
  instructions?: string[];
  keywords?: string[];
  patterns?: RegExp[];
  always?: boolean;
  /** Si es false, ni el resumen ni las instrucciones de este prompt se inyectan. */
  availableWhen?: ModuleCondition;
  /** Activación dinámica adicional a keywords/patterns. */
  activateWhen?: ModuleActivationCondition;
}

export interface LunaModule {
  id: string;
  name: string;
  description: string;
  category: string;
  access: ModuleAccess;
  scope: ModuleScope;
  commands?: ModuleCommandDefinition[];
  tools?: ModuleToolDefinition[];
  prompt?: ModulePromptDefinition;
  /** Condición opcional para deshabilitar por completo un módulo futuro. */
  availableWhen?: ModuleCondition;
}

export interface ResolvedModuleCommand extends ModuleCommandDefinition {
  moduleId: string;
  moduleName: string;
  category: string;
  access: ModuleAccess;
}

export interface ModuleToolFilterResult {
  tools: ToolDefinition[];
  rejected: string[];
}
