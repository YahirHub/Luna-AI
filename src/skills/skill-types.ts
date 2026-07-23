export type SkillShell = "bash" | "powershell";
export type SkillEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeSkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string> | Record<string, unknown>;
  when_to_use?: string;
  "when-to-use"?: string;
  "argument-hint"?: string;
  arguments?: string | string[];
  "disable-model-invocation"?: boolean;
  "user-invocable"?: boolean;
  "allowed-tools"?: string | string[];
  "disallowed-tools"?: string | string[];
  model?: string;
  effort?: SkillEffort | string;
  context?: "fork" | string;
  agent?: string;
  hooks?: unknown;
  paths?: string | string[];
  shell?: SkillShell | string;
  [key: string]: unknown;
}

export interface SkillDefinition {
  id: string;
  displayName: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, unknown>;
  whenToUse: string;
  argumentHint?: string;
  arguments: string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  model?: string;
  effort?: string;
  context?: string;
  agent?: string;
  hooks?: unknown;
  paths: string[];
  shell: SkillShell;
  directory: string;
  skillFile: string;
  body: string;
  frontmatter: ClaudeSkillFrontmatter;
}

export interface RenderedSkill {
  skill: SkillDefinition;
  content: string;
  argumentsText: string;
  argumentValues: string[];
  namedArguments: Record<string, string>;
  dynamicCommandsExecuted: number;
}
