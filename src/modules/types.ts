import type { ToolDefinition } from "../ai.ts";

export type ModuleAccess = "authenticated" | "admin";
export type ModuleScope = "global" | "user" | "hybrid";

export interface ModuleSession {
  authenticated: boolean;
  isAdmin: boolean;
}

export interface ModuleCommandDefinition {
  name: string;
  description: string;
  access?: ModuleAccess;
  aliases?: string[];
  usage?: string[];
}

export interface ModuleToolDefinition {
  name: string;
  access?: ModuleAccess;
}

export interface ModulePromptDefinition {
  summary: string;
  instructions?: string[];
  keywords?: string[];
  patterns?: RegExp[];
  always?: boolean;
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
