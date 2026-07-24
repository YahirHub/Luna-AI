import { describe, expect, it } from "bun:test";
import {
  BrowserCredentialStore,
  browserLoginRequiresIdentityConfirmation,
  extractBrowserLoginIntent,
  sanitizeBrowserCredentialText,
} from "../src/browser/browser-credentials.ts";
import { executeBrowserCredentialControlTool } from "../src/agents/spawn-agents-tool.ts";

describe("credenciales seguras del navegador", () => {
  it("extrae login natural con dominio, usuario y contraseña", () => {
    const intent = extractBrowserLoginIntent(
      "Inicia sesión en domain.tld con el usuario user123 y la contraseña patito123, navega al panel",
    );
    expect(intent.loginRequested).toBe(true);
    expect(intent.url).toBe("https://domain.tld");
    expect(intent.username).toBe("user123");
    expect(intent.password).toBe("patito123");
  });


  it("exige confirmar identidad cuando se ordena login sin usuario", () => {
    expect(browserLoginRequiresIdentityConfirmation(
      "Abre https://example.com e inicia sesión",
    )).toBe(true);
    expect(browserLoginRequiresIdentityConfirmation(
      "Abre https://example.com e inicia sesión con el correo yo@example.com",
    )).toBe(false);
    expect(browserLoginRequiresIdentityConfirmation(
      "Abre https://example.com e inicia sesión",
      "yo@example.com",
    )).toBe(false);
    expect(browserLoginRequiresIdentityConfirmation(
      "Abre https://example.com e inicia sesión",
      "",
      "browser-cred-explicita",
    )).toBe(false);
    expect(browserLoginRequiresIdentityConfirmation(
      "Abre https://example.com e inicia sesión",
      "",
      "browser-profile-guardado",
    )).toBe(true);
    expect(browserLoginRequiresIdentityConfirmation(
      "Entra a https://example.com y revisa la página pública",
    )).toBe(false);
  });

  it("prioriza localhost sobre el dominio incluido en el correo y usa HTTP local", () => {
    const intent = extractBrowserLoginIntent(
      "Accede a localhost e inicia sesión con el correo yahircuentadehost@gmail.com y la contraseña 88888888 y mándame captura del Dashboard",
    );
    expect(intent.loginRequested).toBe(true);
    expect(intent.url).toBe("http://localhost");
    expect(intent.username).toBe("yahircuentadehost@gmail.com");
    expect(intent.password).toBe("88888888");
  });

  it("soporta localhost con puerto y direcciones privadas sin forzar HTTPS", () => {
    expect(extractBrowserLoginIntent(
      "Inicia sesión en localhost:8000 con usuario admin y contraseña test1234",
    ).url).toBe("http://localhost:8000");
    expect(extractBrowserLoginIntent(
      "Entra a 192.168.1.20:3000 con usuario admin y contraseña test1234",
    ).url).toBe("http://192.168.1.20:3000");
  });

  it("sustituye la contraseña por una referencia opaca antes del LLM", () => {
    const store = new BrowserCredentialStore();
    const credential = store.create({ jid: "user@lid", url: "https://domain.tld", username: "user123", password: "patito123" });
    const sanitized = sanitizeBrowserCredentialText(
      "Entra con user123 y contraseña patito123",
      credential,
    );
    expect(sanitized).not.toContain("patito123");
    expect(sanitized).toContain(credential.ref);
    expect(sanitized).toContain("NO corresponde a la contraseña de la cuenta de Luna");
    expect(store.get(credential.ref, "otro@lid")).toBeUndefined();
    expect(store.get(credential.ref, "user@lid")?.password).toBe("patito123");
  });

  it("mantiene solicitudes pendientes aisladas por JID", () => {
    const store = new BrowserCredentialStore();
    store.setPending({ jid: "a@lid", originalText: "entra", url: "https://a.test", username: "a" });
    expect(store.getPending("a@lid")?.username).toBe("a");
    expect(store.getPending("b@lid")).toBeUndefined();
    store.clearPending("a@lid");
    expect(store.getPending("a@lid")).toBeUndefined();
  });
});

it("guarda perfiles cifrados persistentes y soporta varias cuentas por sitio", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const baseDir = mkdtempSync(join(tmpdir(), "luna-browser-credentials-"));
  try {
    const store = new BrowserCredentialStore({ persistent: true, baseDir });
    const first = store.saveProfile({
      jid: "owner@lid",
      url: "https://novalink.us.kg/login",
      username: "meme@gmail.com",
      password: "secreto-uno",
    });
    const second = store.saveProfile({
      jid: "owner@lid",
      url: "https://novalink.us.kg/login",
      username: "otro@gmail.com",
      password: "secreto-dos",
    });
    expect(store.listProfiles("owner@lid", "https://novalink.us.kg").length).toBe(2);
    expect(store.resolve(first.ref, "owner@lid")?.password).toBe("secreto-uno");
    expect(store.resolve(second.ref, "owner@lid")?.password).toBe("secreto-dos");
    expect(store.resolve(first.ref, "intruso@lid")).toBeUndefined();

    const persisted = readFileSync(join(baseDir, "credential-profiles.json"), "utf8");
    expect(persisted).not.toContain("secreto-uno");
    expect(persisted).not.toContain("secreto-dos");
    expect(persisted).toContain("encryptedPassword");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

it("reemplaza la contraseña cifrada de la misma cuenta sin duplicar el perfil", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const baseDir = mkdtempSync(join(tmpdir(), "luna-browser-update-"));
  try {
    const store = new BrowserCredentialStore({ persistent: true, baseDir });
    const original = store.saveProfile({ jid: "a@lid", url: "https://site.test", username: "a@test.com", password: "old" });
    const updated = store.saveProfile({ jid: "a@lid", url: "https://site.test/login", username: "a@test.com", password: "new" });
    expect(updated.ref).toBe(original.ref);
    expect(store.listProfiles("a@lid", "https://site.test").length).toBe(1);
    expect(store.resolve(original.ref, "a@lid")?.password).toBe("new");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

it("maneja solicitudes genéricas de datos y secretos temporales fuera del LLM", () => {
  const store = new BrowserCredentialStore();
  store.setPendingInput({
    jid: "a@lid",
    kind: "otp",
    fieldName: "código de verificación",
    originalText: "entra al panel",
    url: "https://site.test",
  });
  expect(store.getPendingInput("a@lid")?.kind).toBe("otp");
  const secret = store.createSecret({ jid: "a@lid", kind: "otp", value: "123456" });
  expect(store.getSecret(secret.ref, "a@lid")?.value).toBe("123456");
  expect(store.getSecret(secret.ref, "otro@lid")).toBeUndefined();
  expect(store.getSecret(secret.ref, "a@lid", true)?.value).toBe("123456");
  expect(store.getSecret(secret.ref, "a@lid")).toBeUndefined();

  store.setPendingInput({
    jid: "a@lid",
    kind: "secret",
    fieldName: "API key",
    originalText: "configura la integración",
  });
  expect(store.getPendingInput("a@lid")?.kind).toBe("secret");
  const apiKey = store.createSecret({ jid: "a@lid", kind: "secret", value: "sk-example" });
  expect(store.getSecret(apiKey.ref, "a@lid", true)?.kind).toBe("secret");
  expect(store.getSecret(apiKey.ref, "a@lid")).toBeUndefined();
});


it("permite guardar, listar y eliminar credenciales desde las tools del agente principal", () => {
  const store = new BrowserCredentialStore();
  const temp = store.create({
    jid: "owner@lid",
    url: "https://novalink.us.kg",
    username: "meme@gmail.com",
    password: "patito123",
  });
  const savedRaw = executeBrowserCredentialControlTool("browser_credentials_save", { credential_ref: temp.ref }, {
    jid: "owner@lid",
    browserCredentials: store,
  });
  const saved = JSON.parse(savedRaw) as { credential_ref: string };
  expect(saved.credential_ref).toStartWith("browser-profile-");
  expect(store.get(temp.ref, "owner@lid")).toBeUndefined();

  const listed = executeBrowserCredentialControlTool("browser_credentials_list", { url: "https://novalink.us.kg" }, {
    jid: "owner@lid",
    browserCredentials: store,
  });
  expect(listed).toContain("meme@gmail.com");
  expect(listed).not.toContain("patito123");

  const removed = executeBrowserCredentialControlTool("browser_credentials_delete", { credential_ref: saved.credential_ref }, {
    jid: "owner@lid",
    browserCredentials: store,
  });
  expect(removed).toContain("eliminada");
});

it("pausa y reanuda una espera viva del navegador sin crear otra tarea", async () => {
  const store = new BrowserCredentialStore();
  const controller = new AbortController();
  const waiting = store.waitForInput({
    jid: "owner@lid",
    kind: "password",
    fieldName: "contraseña",
    originalText: "entra al dashboard",
    url: "https://novalink.us.kg",
    username: "meme@gmail.com",
  }, controller.signal);

  const pending = store.getPendingInput("owner@lid");
  expect(pending?.requestId).toStartWith("browser-input-");

  const credential = store.create({
    jid: "owner@lid",
    url: "https://novalink.us.kg",
    username: "meme@gmail.com",
    password: "Pepe_123!",
  });
  expect(store.resolvePendingInput("owner@lid", {
    kind: "password",
    credentialRef: credential.ref,
    url: credential.url,
    username: credential.username,
  })).toBe(true);

  const resolution = await waiting;
  expect(resolution.kind).toBe("password");
  if (resolution.kind === "password") {
    expect(resolution.credentialRef).toBe(credential.ref);
  }
  expect(store.getPendingInput("owner@lid")).toBeUndefined();
});

it("permite cancelar una espera viva del navegador", async () => {
  const store = new BrowserCredentialStore();
  const waiting = store.waitForInput({
    jid: "owner@lid",
    kind: "username",
    fieldName: "correo",
    originalText: "entra al dashboard",
  });
  expect(store.cancelPendingInput("owner@lid", new Error("cancelado"))).toBe(true);
  await expect(waiting).rejects.toThrow("cancelado");
  expect(store.getPendingInput("owner@lid")).toBeUndefined();
});

it("mantiene varias solicitudes simultáneas y resuelve cada respuesta por agente", async () => {
  const store = new BrowserCredentialStore();
  const firstController = new AbortController();
  const secondController = new AbortController();

  const first = store.waitForInput({
    jid: "multi@lid",
    kind: "username",
    fieldName: "usuario del primer panel",
    originalText: "primer login",
    requestId: "request-first",
    agentId: "A-AAAAAA",
    agentName: "Primer panel",
  }, firstController.signal);
  const second = store.waitForInput({
    jid: "multi@lid",
    kind: "otp",
    fieldName: "código del segundo panel",
    originalText: "segundo login",
    requestId: "request-second",
    agentId: "A-BBBBBB",
    agentName: "Segundo panel",
  }, secondController.signal);

  expect(store.getPendingInputs("multi@lid").map((item) => item.agentId)).toEqual(["A-AAAAAA", "A-BBBBBB"]);
  expect(store.resolvePendingInput("multi@lid", { kind: "otp", secretRef: "secret-2" }, "A-BBBBBB")).toBe(true);
  expect(await second).toEqual({ kind: "otp", secretRef: "secret-2" });
  expect(store.getPendingInputs("multi@lid").map((item) => item.agentId)).toEqual(["A-AAAAAA"]);

  expect(store.resolvePendingInput("multi@lid", {
    kind: "correction",
    action: "retry_identity",
    message: "esa no es la cuenta",
  }, "A-AAAAAA")).toBe(true);
  expect(await first).toEqual({
    kind: "correction",
    action: "retry_identity",
    message: "esa no es la cuenta",
  });
  expect(store.getPendingInputs("multi@lid")).toEqual([]);
});
