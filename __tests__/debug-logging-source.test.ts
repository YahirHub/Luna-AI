import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const debug = readFileSync(join(root, "src/debug.ts"), "utf8").replace(/\r\n/g, "\n");

describe("logging silencioso y errores persistentes", () => {
  it("solo habilita logs detallados explícitamente", () => {
    expect(debug).toContain('process.argv.includes("--debug")');
    expect(debug).toContain('truthy(process.env.LUNA_DEBUG)');
    expect(debug).not.toContain('return value !== "0" && value !== "false" && value !== "off" && value !== "no";\n}\n\nfunction verboseFromEnv');
  });

  it("persiste errores y rota alrededor de 1 MiB", () => {
    expect(debug).toContain('persistent", "logs", "errors.log"');
    expect(debug).toContain("DEFAULT_ERROR_LOG_MAX_BYTES = 1024 * 1024");
    expect(debug).toContain("rotateErrorLog(path, errorLogMaxBytes())");
    expect(debug).toContain("local_ts");
    expect(debug).toContain("timezone");
  });
});
