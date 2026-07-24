import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

describe("orquestador web pública directa", () => {
  it("oculta subagentes en la ruta rápida y permite escalarlos mediante capability_load", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("shouldPreferDirectPublicWeb(message)");
    expect(bot).toContain('blocked.add("browser_agent")');
    expect(bot).toContain('blocked.add("researcher_web")');
    expect(bot).toContain('blocked.add("spawn_agents")');
    expect(bot).toContain('loaded.has("browser")');
    expect(bot).toContain('loaded.has("search")');
    expect(bot).toContain('loaded.has("agents")');
    expect(bot).toContain("executePublicWebTool(name, args");
  });

  it("browser-web busca coincidencias dentro del HTML antes de volcarlo completo", () => {
    const browser = source("src/agents/definitions/browser-web.ts");
    const runtime = source("src/browser/browser-runtime.ts");
    expect(browser).toContain('"browser_find_html"');
    expect(browser).toContain("usa primero browser_find_html");
    expect(runtime).toContain('case "browser_find_html"');
    expect(runtime).toContain("extractPublicUrls(html");
  });

  it("declara Commons, Archive y Dogpile como fuentes de fallback especializadas", () => {
    const routing = source("src/search/search-routing.ts");
    expect(routing).toContain("https://www.dogpile.com/");
    expect(routing).toContain("https://commons.wikimedia.org/wiki/Special:MediaSearch");
    expect(routing).toContain("https://archive.org/advancedsearch.php");
  });
});
