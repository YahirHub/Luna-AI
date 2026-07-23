import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillManager } from "../src/skills/skill-manager.ts";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";
import { buildBubblewrapArgs } from "../src/workspace/workspace-exec.ts";

const roots: string[] = [];

function fixture(): {
  root: string;
  bundled: string;
  persistent: string;
  workspace: WorkspaceManager;
  skills: SkillManager;
} {
  const root = join(tmpdir(), `luna-skills-${Date.now()}-${crypto.randomUUID()}`);
  roots.push(root);
  const bundled = join(root, "assets", "skills");
  const persistent = join(root, "persistent");
  const skillDir = join(bundled, "web-design");
  mkdirSync(join(skillDir, "references"), { recursive: true });
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), [
    "---",
    "name: Web Design",
    "description: Diseña interfaces web accesibles. Úsala para UI, CSS y componentes.",
    "when_to_use: Cuando se diseñen páginas o componentes web.",
    "argument-hint: '[framework] [page]'",
    "arguments: [framework, page]",
    "allowed-tools: Read Grep Bash(git add *)",
    "disallowed-tools: process_stop",
    "license: MIT",
    "compatibility: Requires Node.js when running optional helpers",
    "metadata:",
    "  author: Luna",
    "  version: '1.0'",
    "paths: ['src/**/*.css', 'src/**/*.tsx']",
    "shell: bash",
    "---",
    "Construye $page usando $framework.",
    "Sesión: ${CLAUDE_SESSION_ID}",
    "Skill: ${CLAUDE_SKILL_DIR}",
    "Proyecto: ${CLAUDE_PROJECT_DIR}",
  ].join("\n"));
  writeFileSync(join(skillDir, "references", "guide.md"), "# Guía\nUsa HTML semántico.\n");
  writeFileSync(join(skillDir, "scripts", "helper.js"), "console.log('helper');\n");

  const manualDir = join(bundled, "deploy-only");
  mkdirSync(manualDir, { recursive: true });
  writeFileSync(join(manualDir, "SKILL.md"), [
    "---",
    "description: Despliega manualmente.",
    "disable-model-invocation: true",
    "---",
    "Despliega $ARGUMENTS.",
  ].join("\n"));

  const workspace = new WorkspaceManager(join(persistent, "contexts"));
  const skills = new SkillManager({ appDir: root, persistentDir: persistent, bundledDirs: [bundled] });
  return { root, bundled, persistent, workspace, skills };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("SkillManager", () => {
  it("copia skills bundled de forma aditiva y conserva personalizaciones persistentes", () => {
    const { bundled, persistent, skills } = fixture();
    const persisted = join(persistent, "skills", "web-design", "SKILL.md");
    expect(existsSync(persisted)).toBe(true);
    expect(skills.get("web-design").description).toContain("interfaces web");

    writeFileSync(persisted, "---\ndescription: Personalizada por el operador\n---\nNo sobrescribir.\n");
    writeFileSync(join(bundled, "web-design", "SKILL.md"), "---\ndescription: Nueva versión bundled\n---\nBundled.\n");
    skills.bootstrapBundledSkills();

    expect(readFileSync(persisted, "utf8")).toContain("Personalizada por el operador");
  });

  it("usa disclosure progresivo y excluye skills manuales del catálogo automático", () => {
    const { skills } = fixture();
    const catalog = skills.buildCatalogForModel();
    expect(catalog).toContain("web-design");
    expect(catalog).toContain("paths:");
    expect(catalog).not.toContain("deploy-only");
    expect(skills.formatListForUser()).toContain("deploy-only");
  });

  it("interpreta frontmatter Claude/Agent Skills, argumentos y variables compatibles", async () => {
    const { skills, workspace } = fixture();
    const definition = skills.get("web-design");
    expect(definition.license).toBe("MIT");
    expect(definition.compatibility).toContain("Node.js");
    expect(definition.metadata.author).toBe("Luna");
    expect(definition.arguments).toEqual(["framework", "page"]);
    expect(definition.allowedTools).toContain("Read");
    expect(definition.allowedTools).toContain("Bash(git add *)");
    expect(definition.disallowedTools).toContain("process_stop");
    expect(definition.paths).toContain("src/**/*.css");

    const rendered = await skills.render("web-design", "React dashboard", workspace, "user", {
      modelInvocation: true,
      executeDynamicCommands: false,
    });
    expect(rendered.content).toContain("Construye dashboard usando React.");
    expect(rendered.content).toContain("/skills/web-design");
    expect(rendered.content).toContain("/workspace");
    expect(rendered.content).not.toContain("${CLAUDE_SESSION_ID}");
  });

  it("lee recursos sin permitir traversal fuera de la skill", () => {
    const { skills } = fixture();
    expect(skills.readResource("web-design", "references/guide.md")).toContain("HTML semántico");
    expect(() => skills.readResource("web-design", "../secret.txt")).toThrow(/dentro de la skill/i);
  });

  it("repara al arrancar los enlaces de workdirs ya existentes", () => {
    const { persistent, workspace } = fixture();
    const legacyWorkdir = join(persistent, "contexts", "legacy-user", "workdir");
    mkdirSync(legacyWorkdir, { recursive: true });
    expect(existsSync(join(legacyWorkdir, ".skills"))).toBe(false);
    expect(workspace.ensureGlobalSkillsLinksForExistingUsers()).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(legacyWorkdir, ".skills"))).toBe(true);
  });

  it("crea un enlace global de skills por usuario pero lo protege de las tools normales", () => {
    const { persistent, workspace } = fixture();
    const workdir = workspace.getWorkdir("user@s.whatsapp.net");
    const link = join(workdir, ".skills");
    expect(existsSync(link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(persistent, "skills")));
    expect(() => workspace.resolvePath("user@s.whatsapp.net", ".skills/web-design/SKILL.md", { mustExist: true })).toThrow(/interna|solo lectura/i);
  });

  it("monta persistent/skills como /skills de solo lectura en Bubblewrap", () => {
    const { persistent, workspace } = fixture();
    const workdir = workspace.getWorkdir("sandbox-user");
    const args = buildBubblewrapArgs(workdir, ".", "/bin/bash", ["-lc", "true"]);
    const skillRoot = join(persistent, "skills");
    const index = args.findIndex((value, position) => value === "--ro-bind" && args[position + 1] === skillRoot);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 2]).toBe("/skills");
  });
});
