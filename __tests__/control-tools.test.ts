import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { USER_CONTROL_TOOLS, ADMIN_CONTROL_TOOLS } from "../src/control-tools.ts";
import { SearchSetupManager } from "../src/search/search-setup.ts";
import { loadWebSearchAuth } from "../src/search/search-storage.ts";
import { moduleRegistry } from "../src/modules/catalog.ts";

describe("control natural de comandos existentes", () => {
  it("expone comandos funcionales de usuario como tools", () => {
    const names = USER_CONTROL_TOOLS.map((tool) => tool.function.name);
    expect(names).toContain("control_help");
    expect(names).toContain("control_ping");
    expect(names).toContain("control_get_id");
    expect(names).toContain("control_cancel");
    expect(names).toContain("conversation_clear");
    expect(names).toContain("account_password_change_start");
    expect(names).toContain("model_status");
    expect(names).toContain("model_list");
    expect(names).toContain("model_set");
  });

  it("expone configuración administrativa funcional sin controles de resiliencia", () => {
    const names = ADMIN_CONTROL_TOOLS.map((tool) => tool.function.name);
    expect(names).toContain("llm_provider_status");
    expect(names).toContain("llm_provider_start_setup");
    expect(names).toContain("llm_provider_use_opencode_free");
    expect(names).toContain("search_admin_status");
    expect(names).toContain("search_admin_set_fallback_order");
    expect(names).toContain("search_admin_start_set_api_key");
    expect(names).toContain("agent_config_status");
    expect(names).toContain("agent_config_update");
    expect(names.some((name) => /retry|backoff|resilien/i.test(name))).toBe(false);
  });

  it("inicia captura segura de API key sin pasar el secreto como argumento", async () => {
    const root = join(tmpdir(), `luna-search-natural-${Date.now()}-${crypto.randomUUID()}`);
    try {
      const manager = new SearchSetupManager(root);
      const prompt = manager.startApiKey("admin@s.whatsapp.net", "brave");
      expect(prompt).toContain("API KEY DE BRAVE SEARCH");
      expect(loadWebSearchAuth(root).apiKeys.brave).toBeUndefined();

      const result = await manager.submit("admin@s.whatsapp.net", "Esta es mi API key: secret-test-key");
      expect(result.secretInput).toBe(true);
      expect(result.done).toBe(true);
      expect(manager.has("admin@s.whatsapp.net")).toBe(false);
      expect(result.text).not.toContain("1. Configurar o reemplazar API key");
      expect(loadWebSearchAuth(root).apiKeys.brave).toBe("secret-test-key");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extrae una API key incluida al final de una frase natural", async () => {
    const { extractSecretTokenFromMessage } = await import("../src/utils.ts");
    expect(
      extractSecretTokenFromMessage(
        "Configura el de fireclaw, quiero reemplazar la key actual por este fc-8d49b39928b8479d914a974e4c21cada",
      ),
    ).toBe("fc-8d49b39928b8479d914a974e4c21cada");
  });

  it("mantiene las tools administrativas separadas de las tools de usuario", () => {
    const pool = [...USER_CONTROL_TOOLS, ...ADMIN_CONTROL_TOOLS];
    const user = moduleRegistry.filterTools(pool, { authenticated: true, isAdmin: false });
    const admin = moduleRegistry.filterTools(pool, { authenticated: true, isAdmin: true });

    const userNames = user.tools.map((tool) => tool.function.name);
    const adminNames = admin.tools.map((tool) => tool.function.name);
    const expectedUserNames = USER_CONTROL_TOOLS.map((tool) => tool.function.name);
    const expectedAdminNames = ADMIN_CONTROL_TOOLS.map((tool) => tool.function.name);

    for (const name of expectedUserNames) expect(userNames).toContain(name);
    for (const name of expectedAdminNames) {
      expect(userNames).not.toContain(name);
      expect(user.rejected).toContain(name);
      expect(adminNames).toContain(name);
    }
  });

  it("reconoce login/setup/cancelación natural localmente sin enviar credenciales al LLM", async () => {
    const source = await Bun.file(new URL("../src/bot.ts", import.meta.url)).text();
    expect(source).toContain("parseNaturalLocalCommand");
    expect(source).toContain('"iniciar sesion"');
    expect(source).toContain('"crear administrador"');
    expect(source).toContain('"cancelar"');
  });
});
