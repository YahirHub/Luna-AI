import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = join(import.meta.dir, "..");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("frontera de transportes", () => {
  it("mantiene el SDK de Baileys aislado dentro de su adaptador", () => {
    const offenders = walk(join(root, "src"))
      .filter((path) => path.endsWith(".ts"))
      .filter((path) => !relative(join(root, "src"), path).startsWith(`transports${sep}baileys`))
      .filter((path) => readFileSync(path, "utf8").includes("@whiskeysockets/baileys"));
    expect(offenders).toEqual([]);
  });

  it("usa message_send y mensajes entrantes neutrales en el núcleo", () => {
    expect(readFileSync(join(root, "src", "tools", "messaging-tools.ts"), "utf8")).toContain('name: "message_send"');
    expect(readFileSync(join(root, "src", "media.ts"), "utf8")).toContain('import type { TransportIncomingMessage }');
  });
});
