export type BrowserHumanInputGuardKind = "username" | "password" | "otp" | "secret" | "text";

export interface BrowserHumanInputGuardNeed {
  kind: BrowserHumanInputGuardKind;
  fieldName: string;
  message: string;
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function authenticationForbidden(mission: string): boolean {
  const text = normalize(mission);
  return /\b(?:sin|no)\s+(?:iniciar|hacer|usar|realizar)\s+(?:sesion|login|autenticacion)\b/.test(text)
    || /\bno\s+(?:uses?|utilices?|pidas?|solicites?)\s+(?:credenciales|usuario|correo|contrasena|password|otp|api[ -]?key|token|secreto|secret)\b/.test(text)
    || /\b(?:solo|unicamente)\s+(?:contenido|informacion|paginas?)\s+public[oa]s?\b/.test(text);
}

function explicitlyResolved(output: string): boolean {
  const text = normalize(output);
  return /\b(?:no\s+(?:fue|es)\s+necesari[oa]|sin\s+necesidad\s+de)\s+(?:credenciales|iniciar sesion|login|contrasena|password|otp)\b/.test(text)
    || /\b(?:login|inicio de sesion|autenticacion)\s+(?:completad[oa]|exitos[oa]|confirmad[oa])\b/.test(text);
}

function userDeclined(output: string): boolean {
  const text = normalize(output);
  return /\b(?:el usuario|usuario)\s+(?:cancelo|rechazo|indico|dijo).{0,60}\b(?:no desea|no quiere|no tiene|no puede|cancelar|rechazar)\b/.test(text)
    || /\b(?:user)\s+(?:cancelled|declined|said).{0,60}\b(?:does not want|doesn't want|cannot|can't|does not have|doesn't have)\b/.test(text);
}

/**
 * Corrige defensivamente una clasificación insegura hecha por el modelo.
 * El nombre/mensaje del campo son metadata no secreta y permiten impedir que
 * contraseñas, OTP, tokens o respuestas de seguridad vuelvan al LLM como text.
 */
export function normalizeBrowserRequestedInputKind(
  kind: BrowserHumanInputGuardKind,
  fieldName: string,
  message = "",
): BrowserHumanInputGuardKind {
  if (kind === "password" || kind === "otp" || kind === "secret") return kind;
  const descriptor = normalize(`${fieldName} ${message}`);
  if (/\b(?:otp|2fa|codigo(?: de)? (?:verificacion|seguridad|acceso)|verification code|security code|one[- ]time(?: password| code)?)\b/.test(descriptor)) {
    return "otp";
  }
  if (/\b(?:contrasena|password|clave de acceso)\b/.test(descriptor)) return "password";
  if (/\b(?:api[ -]?key|token|secret[oa]?|pin|recovery code|codigo de recuperacion|pregunta de seguridad|respuesta de seguridad|security question|security answer)\b/.test(descriptor)) {
    return "secret";
  }
  return kind;
}

/**
 * Detecta únicamente cierres prematuros donde browser-web afirma que no puede
 * continuar porque necesita un dato humano. No intenta inferir secretos ni
 * inspecciona contenido sensible: solo clasifica el texto final del subagente.
 */
export function detectBrowserHumanInputNeed(output: string, mission: string): BrowserHumanInputGuardNeed | null {
  if (!output.trim() || explicitlyResolved(output) || userDeclined(output)) return null;
  const text = normalize(output);

  const inputTerms = /\b(?:credencial(?:es)?|usuario|username|correo|email|contrasena|password|clave|otp|2fa|codigo(?: de)? (?:verificacion|seguridad|acceso)|verification code|security code|api[ -]?key|token|secret[oa]?|pin|recovery code|codigo de recuperacion|captcha|pregunta de seguridad|respuesta de seguridad|security question|security answer|dato(?: adicional| necesario)?|informacion adicional|additional information|human input)\b/;
  const blockerTerms = /\b(?:necesit[oa]|requier[eo]|falta|faltan|debes proporcionar|debe proporcionar|proporciona|solicito|solicitar|no puedo continuar|no es posible continuar|no puedo acceder|no puedo iniciar sesion|bloquead[oa]|requiere autenticacion|requiere iniciar sesion|need|needs|require|requires|required|missing|provide|cannot continue|can't continue|cannot proceed|can't proceed|cannot access|login required|authentication required|blocked)\b/;
  const blocked = inputTerms.test(text) && blockerTerms.test(text);
  if (!blocked) return null;

  const otp = /\b(?:otp|2fa|codigo(?: de)? (?:verificacion|seguridad|acceso)|verification code|security code|one[- ]time(?: password| code)?)\b/.test(text);
  const password = /\b(?:contrasena|password|clave de acceso|credencial(?:es)?)\b/.test(text);
  const secret = /\b(?:api[ -]?key|token|secret[oa]?|pin|recovery code|codigo de recuperacion|pregunta de seguridad|respuesta de seguridad|security question|security answer)\b/.test(text);
  const username = /\b(?:usuario|username|correo|email|cuenta|account)\b/.test(text);
  const generic = /\b(?:captcha|dato(?: adicional| necesario)?|informacion adicional|additional information|human input)\b/.test(text);

  if ((otp || password || secret || username) && authenticationForbidden(mission)) return null;
  if (otp) {
    return {
      kind: "otp",
      fieldName: "código de verificación",
      message: "El sitio exige un código de verificación para continuar la tarea actual.",
    };
  }
  if (secret) {
    return {
      kind: "secret",
      fieldName: "dato secreto requerido por el sitio",
      message: "El sitio exige un dato sensible adicional. Se solicitará fuera del LLM y se inyectará mediante una referencia segura.",
    };
  }
  if (password) {
    return {
      kind: "password",
      fieldName: "contraseña",
      message: "El navegador quedó bloqueado por autenticación y necesita la credencial para continuar la misma tarea.",
    };
  }
  if (username) {
    return {
      kind: "username",
      fieldName: "usuario o correo",
      message: "El sitio necesita identificar la cuenta antes de poder continuar.",
    };
  }
  if (generic) {
    return {
      kind: "text",
      fieldName: "dato requerido por el sitio",
      message: "El navegador necesita un dato humano adicional para continuar la misma tarea.",
    };
  }
  return null;
}
