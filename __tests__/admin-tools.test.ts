import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthManager } from "../src/auth.ts";
import {
  ADMIN_TOOLS,
  executeUserAdminTool,
  executeWhisperAdminTool,
} from "../src/admin-tools.ts";

let counter = 0;

async function createLoggedAdmin(): Promise<{
  auth: AuthManager;
  jid: string;
}> {
  counter += 1;
  const path = join(tmpdir(), `luna-admin-tools-${Date.now()}-${counter}.json`);
  const auth = new AuthManager(path);
  await auth.createAdmin("rootadmin", "password123");
  const jid = "admin@s.whatsapp.net";
  expect(await auth.login(jid, "rootadmin", "password123")).toBe(true);
  return { auth, jid };
}

describe("herramientas administrativas en lenguaje natural", () => {
  it("expone gestión de usuarios y configuración de Whisper", () => {
    const names = ADMIN_TOOLS.map((tool) => tool.function.name);
    expect(names).toContain("admin_list_users");
    expect(names).toContain("admin_start_add_user");
    expect(names).toContain("admin_ban_user");
    expect(names).toContain("admin_unban_user");
    expect(names).toContain("whisper_status");
    expect(names).toContain("whisper_list_models");
    expect(names).toContain("whisper_update_config");
    expect(names).toContain("whisper_download_model");
  });

  it("inicia la creación segura sin recibir la contraseña como argumento", async () => {
    const { auth, jid } = await createLoggedAdmin();
    const result = await executeUserAdminTool(
      "admin_start_add_user",
      { username: "nuevo_usuario" },
      auth,
      jid,
    );
    expect(result).toContain("Flujo seguro iniciado");
    expect(result).toContain("todavía no existe");
    expect(auth.getPendingAction(jid)).toEqual({
      type: "adduser",
      step: "awaiting-password",
      username: "nuevo_usuario",
    });
    expect(auth.findUser("nuevo_usuario")).toBeUndefined();
  });

  it("rechaza herramientas de usuario sin sesión administradora", async () => {
    const { auth } = await createLoggedAdmin();
    const result = await executeUserAdminTool(
      "admin_list_users",
      {},
      auth,
      "otro@s.whatsapp.net",
    );
    expect(result).toStartWith("Error:");
  });

  it("lista modelos con su tamaño y estado", async () => {
    const result = await executeWhisperAdminTool("whisper_list_models", {});
    expect(result).toContain("base-q5_1");
    expect(result).toContain("57 MiB");
    expect(result).toContain("multilingüe");
  });

  it("no actualiza Whisper sin parámetros", async () => {
    const result = await executeWhisperAdminTool("whisper_update_config", {});
    expect(result).toStartWith("Error:");
  });

  it("exige confirmación explícita para descargar", async () => {
    const result = await executeWhisperAdminTool(
      "whisper_download_model",
      { model_id: "small-q5_1", confirmed: false },
    );
    expect(result).toContain("falta confirmación explícita");
    expect(result).toContain("181 MiB");
  });
});
