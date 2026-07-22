import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

describe("integración de la bóveda persistente", () => {
  it("expone las tools al orquestador y ejecuta el gestor por JID", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("...MEMORY_VAULT_TOOLS");
    expect(bot).toContain("executeMemoryVaultTool(name, args, memoryVault, remoteJid)");
  });

  it("inyecta únicamente recuerdos relacionados con el mensaje actual", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("memoryVault.buildRelevantContext(remoteJid, userText)");
    expect(bot).toContain("relatedVaultContext");
  });

  it("distingue el perfil compacto de las notas temáticas", () => {
    const module = source("src/modules/memory/module.ts");
    expect(module).toContain("memory.md es para nombre");
    expect(module).toContain("memory_vault_search/list/read solo consultan");
    expect(module).toContain("No guardes contraseñas, tokens, API keys ni OTP");
  });

  it("registra mutaciones de la bóveda como resultados confirmados", () => {
    const confirmations = source("src/tool-confirmation.ts");
    for (const tool of [
      "memory_vault_upsert",
      "memory_vault_edit",
      "memory_vault_rename",
      "memory_vault_delete",
      "memory_vault_restore",
    ]) expect(confirmations).toContain(`"${tool}"`);
  });

  it("fuerza una mutación cuando el modelo solo buscó o afirmó guardar", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("detectMemoryPersistenceIntent(userText)");
    expect(bot).toContain("requestForcedToolArguments(");
    expect(bot).toContain("mutation_missing_after_primary_round");
    expect(bot).toContain("buildUnconfirmedMemoryResponse");
  });
});
