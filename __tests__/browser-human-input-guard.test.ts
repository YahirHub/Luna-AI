import { describe, expect, it } from "bun:test";
import { detectBrowserHumanInputNeed, normalizeBrowserRequestedInputKind } from "../src/browser/browser-human-input.ts";

describe("guard de entrada humana de browser-web", () => {
  it("intercepta un cierre por credenciales faltantes", () => {
    const need = detectBrowserHumanInputNeed(
      "No puedo continuar porque necesito las credenciales de acceso para iniciar sesión.",
      "Entra al panel de example.com y revisa el estado.",
    );
    expect(need?.kind).toBe("password");
    expect(need?.fieldName).toBe("contraseña");
  });

  it("distingue OTP, secretos y datos humanos genéricos", () => {
    expect(detectBrowserHumanInputNeed(
      "Necesito el código de verificación 2FA para continuar.",
      "Entra a mi panel.",
    )?.kind).toBe("otp");

    expect(detectBrowserHumanInputNeed(
      "El sitio requiere una respuesta de seguridad para continuar.",
      "Revisa mi cuenta.",
    )?.kind).toBe("secret");

    expect(detectBrowserHumanInputNeed(
      "Necesito un CAPTCHA para continuar.",
      "Revisa mi cuenta.",
    )?.kind).toBe("text");
  });

  it("eleva campos sensibles aunque el modelo los clasifique como text", () => {
    expect(normalizeBrowserRequestedInputKind("text", "Contraseña")).toBe("password");
    expect(normalizeBrowserRequestedInputKind("text", "Código 2FA")).toBe("otp");
    expect(normalizeBrowserRequestedInputKind("text", "API key")).toBe("secret");
    expect(normalizeBrowserRequestedInputKind("text", "respuesta de seguridad")).toBe("secret");
    expect(normalizeBrowserRequestedInputKind("text", "nombre de empresa")).toBe("text");
  });

  it("no pide credenciales si la misión prohíbe autenticarse", () => {
    const need = detectBrowserHumanInputNeed(
      "La página requiere login y credenciales para ver esa sección.",
      "Revisa únicamente contenido público sin iniciar sesión.",
    );
    expect(need).toBeNull();
  });

  it("no reabre un bloqueo ya resuelto", () => {
    expect(detectBrowserHumanInputNeed(
      "El inicio de sesión fue completado correctamente y ya estoy en el dashboard.",
      "Entra al panel.",
    )).toBeNull();
  });
});
