import { describe, expect, it } from "bun:test";
import {
  BrowserCredentialStore,
  extractBrowserLoginIntent,
  sanitizeBrowserCredentialText,
} from "../src/browser/browser-credentials.ts";

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
