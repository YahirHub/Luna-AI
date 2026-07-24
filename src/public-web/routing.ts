function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Detecta solicitudes que normalmente pueden resolverse con HTTP/API directa
 * sin pagar un subagente de navegador.
 */
export function isDirectPublicContentIntent(message: string): boolean {
  const text = normalize(message);
  if (!text.trim()) return false;
  const trustedSource = /\b(?:archive\.org|internet archive|wikimedia(?: commons)?|commons\.wikimedia\.org)\b/.test(text);
  const media = /\b(?:video|videos|imagen|imagenes|foto|fotos|audio|mp4|webm|jpg|jpeg|png|gif|archivo|contenido)\b/.test(text);
  const action = /\b(?:busca|buscar|encuentra|encontrar|descarga|descargar|manda|mandame|mandamelo|envia|enviame|comparteme|obten|obtener)\b/.test(text);
  return trustedSource || (media && action);
}

/** Casos donde HTTP directo no sustituye una sesión interactiva real. */
export function requiresInteractiveBrowser(message: string): boolean {
  const text = normalize(message);
  return /\b(?:inicia sesion|login|loguea|autentica|password|contrasena|captcha|otp|2fa|haz clic|click|rellena|formulario|captura|screenshot|pdf de la pagina|javascript|dom|consola|network|red de la pagina)\b/.test(text);
}

export function userExplicitlyRequestsWebAgent(message: string): boolean {
  const text = normalize(message);
  return /\b(?:agente|subagente|browser-agent|browser agent|researcher-web|researcher web|api-search)\b/.test(text);
}

export function shouldPreferDirectPublicWeb(message: string): boolean {
  return isDirectPublicContentIntent(message)
    && !requiresInteractiveBrowser(message)
    && !userExplicitlyRequestsWebAgent(message);
}
