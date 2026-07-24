import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bot = readFileSync(join(root, "src/bot.ts"), "utf8").replace(/\r\n/g, "\n");
const catalog = readFileSync(join(root, "src/modules/catalog.ts"), "utf8");
const goal = readFileSync(join(root, "src/goals/goal-runtime.ts"), "utf8");
const agentRuntime = readFileSync(join(root, "src/agents/agent-runtime.ts"), "utf8");
const researcher = readFileSync(join(root, "src/agents/definitions/researcher-web.ts"), "utf8");
const browser = readFileSync(join(root, "src/agents/definitions/browser-web.ts"), "utf8");
const packaging = readFileSync(join(root, "scripts/package-runtime.ts"), "utf8");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/build-release.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };

describe("integración global de Claude/Agent Skills", () => {
  it("registra el módulo y expone skills al orquestador y GoalRuntime", () => {
    expect(catalog).toContain("SKILLS_MODULE");
    expect(bot).toContain("...SKILL_TOOLS");
    expect(bot).toContain('moduleRegistry.bindContextProvider("skills"');
    expect(bot).not.toContain("skillManager.buildCatalogForModel()");
    expect(bot).toContain("Usa skill_search para descubrir únicamente las skills relevantes");
    expect(bot).toContain("workspaceManager.ensureGlobalSkillsLinksForExistingUsers()");
    expect(bot).toContain("executeSkillTool(name, args, skillManager");
    expect(bot).not.toContain("[SKILL GLOBAL CARGADA:");
    expect(goal).toContain("skill_search");
    expect(goal).toContain("skill_list");
    expect(goal).toContain("skill_load");
    expect(goal).toContain("skill_run_script");
  });

  it("da a los agentes de investigación acceso de lectura a skills sin ejecución arbitraria", () => {
    expect(agentRuntime).toContain('["skill_search", "skill_load", "skill_read_resource"]');
    expect(agentRuntime).toContain("allowScripts: false");
    expect(agentRuntime).toContain("executeDynamicCommands: false");
    expect(researcher).toContain("skill_load");
    expect(browser).toContain("skill_load");
  });

  it("empaqueta assets/skills en releases y Docker", () => {
    expect(packageJson.dependencies.yaml).toBe("2.9.0");
    expect(packaging).toContain('"assets", "skills"');
    expect(packaging).toContain('"dist", "skills"');
    expect(dockerfile).toContain("COPY --from=build /app/dist/skills /data/skills");
    expect(workflow).toContain("cp -R dist/skills release/luna-ai-linux-amd64/skills");
    expect(workflow).toContain("cp -R dist/skills release/luna-ai-linux-arm64/skills");
    expect(workflow).toContain("Copy-Item dist/skills release/luna-ai-windows-amd64/skills -Recurse");
  });
});
