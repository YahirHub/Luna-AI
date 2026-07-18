const SCHEDULED_CREATE_TOOLS = new Set(["create_reminder", "create_alarm"]);

const MUTATING_TOOLS = new Set([
  "create_reminder",
  "delete_reminder",
  "create_alarm",
  "delete_alarm",
  "toggle_alarm",
  "memory_write",
  "whisper_update_config",
  "whisper_download_model",
  "whisper_cleanup_models",
  "admin_start_add_user",
  "admin_ban_user",
  "admin_unban_user",
  "workspace_write_text",
  "create_pdf_from_markdown",
  "archive_folder",
  "gitzip",
  "whatsapp_send",
]);

function normalizeForIntent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function isConfirmedToolSuccess(toolName: string, result: string): boolean {
  return MUTATING_TOOLS.has(toolName) && result.trimStart().startsWith("✅");
}

export function isConfirmedScheduledCreation(toolName: string, result: string): boolean {
  return SCHEDULED_CREATE_TOOLS.has(toolName) && isConfirmedToolSuccess(toolName, result);
}

export function buildConfirmedToolEvent(toolName: string, result: string): string {
  return [
    "[Resultado de herramienta confirmado por el sistema]",
    `Herramienta: ${toolName}`,
    "Estado: ejecución confirmada por el sistema",
    result.trim(),
    "Este evento del sistema, y no una afirmación previa del asistente, es la evidencia de que la acción ocurrió.",
  ].join("\n");
}

export function buildVisibleSystemConfirmation(result: string): string {
  return [
    "⚙️ CONFIRMACIÓN DEL SISTEMA",
    "",
    result.trim(),
  ].join("\n");
}

/**
 * Impide que una transcripción o mensaje con una negación explícita termine
 * creando accidentalmente una alarma o recordatorio.
 */
export function userExplicitlyBlocksScheduledCreation(
  userText: string,
  toolName: string,
): boolean {
  if (!SCHEDULED_CREATE_TOOLS.has(toolName)) return false;
  const normalized = normalizeForIntent(userText);
  const target = toolName === "create_alarm" ? "alarma" : "recordatorio";
  const mentionsTarget = normalized.includes(target) || normalized.includes(`${target}s`);
  const disputesToolExecution = /\bno\s+(?:ejecutaste|usaste|llamaste)\s+(?:la\s+)?herramienta\b/.test(normalized);
  if (!mentionsTarget && !disputesToolExecution) return false;

  // Una petición inequívoca de reintento prevalece sobre la queja histórica.
  const explicitlyRequestsRetry = [
    /\b(?:ahora\s+si|entonces|por\s+favor)\b[^.\n]{0,80}\b(?:crea|crealo|creala|recrea|programa|registralo|registrala)\b/,
    /\b(?:crea|crealo|creala|recrea|programa|registralo|registrala)\b[^.\n]{0,80}\b(?:ahora|de\s+nuevo|otra\s+vez)\b/,
    /\bintenta(?:lo)?\s+(?:de\s+nuevo|otra\s+vez)\b/,
  ].some((pattern) => pattern.test(normalized));
  if (explicitlyRequestsRetry) return false;

  return [
    /\bno\s+(?:me\s+)?(?:crea|crear|crees|creas|hagas|programes|configures|registres)\b/,
    /\bno\s+(?:quiero|deseo|necesito)\b[^.\n]{0,100}\b(?:alarma|recordatorio)s?\b/,
    /\bsin\s+(?:crear|programar|registrar|configurar)\b[^.\n]{0,100}\b(?:alarma|recordatorio)s?\b/,
    /\b(?:no|nunca)\s+(?:generes|agregues)\b[^.\n]{0,100}\b(?:alarma|recordatorio)s?\b/,
    /\bno\s+(?:creaste|programaste|configuraste|registraste)\b[^.\n]{0,120}\b(?:alarma|recordatorio)s?\b/,
    /\bno\s+se\s+(?:creo|programo|configuro|registro)\b[^.\n]{0,120}\b(?:alarma|recordatorio)s?\b/,
    /\b(?:no\s+me\s+sale|no\s+aparece|no\s+existe)\b[^.\n]{0,120}\b(?:alarma|recordatorio)s?\b/,
    /\bno\s+(?:ejecutaste|usaste|llamaste)\s+(?:la\s+)?herramienta\b/,
  ].some((pattern) => pattern.test(normalized));
}

function containsCreationClaimFor(
  content: string,
  target: "alarma" | "recordatorio",
): boolean {
  const normalized = normalizeForIntent(content);
  const patterns = [
    new RegExp(`\\b(?:acabo de|ya|ahora si|he)\\s+(?:creado|creada|cree|configure|configurado|configurada|programe|programado|programada|registre|registrado|registrada)\\b[^.\\n]{0,160}\\b${target}s?\\b`, "is"),
    new RegExp(`\\b(?:cree|configure|programe|registre)\\s+(?:el|la|un|una|tu)?\\s*${target}\\b`, "is"),
    new RegExp(`\\b(?:tu|el|la|un|una)\\s+${target}\\b[^.\\n]{0,160}\\b(?:quedo|fue)\\s+(?:creado|creada|configurado|configurada|programado|programada|registrado|registrada|listo|lista)\\b`, "is"),
    new RegExp(`\\blisto\\b[^.\\n]{0,160}\\b${target}\\b`, "is"),
    new RegExp(`\\b(?:te|le)\\s+(?:va a llegar|llegara|avisare|recordare)\\b[^.\\n]{0,160}\\b${target}s?\\b`, "is"),
    new RegExp(`\\b${target}s?\\b[^.\\n]{0,160}\\b(?:te|le)\\s+(?:va a llegar|llegara|avisare|recordare)\\b`, "is"),
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function containsScheduledStatusClaimFor(
  content: string,
  target: "alarma" | "recordatorio",
): boolean {
  const normalized = normalizeForIntent(content);
  return new RegExp(
    `\\b(?:tu|el|la|un|una)\\s+${target}\\b[^.\\n]{0,160}\\b(?:esta|sigue)\\s+(?:activo|activa|configurado|configurada|programado|programada|pendiente)\\b`,
    "is",
  ).test(normalized);
}

export function containsAffirmativeScheduledCreationClaim(content: string): boolean {
  return containsCreationClaimFor(content, "alarma") ||
    containsCreationClaimFor(content, "recordatorio");
}

/**
 * Sustituye por completo una afirmación no respaldada. No mostramos primero
 * la alucinación y luego una nota: el usuario recibe únicamente el estado
 * autoritativo del sistema. Una consulta list_* permite describir el estado
 * existente, pero nunca fingir que se creó algo en la ronda actual.
 */
export function guardUnconfirmedScheduledCreationClaim(
  content: string,
  confirmedTools: ReadonlySet<string>,
): string {
  const clean = content.trim();
  if (!clean) return clean;

  const unconfirmedCreations: string[] = [];
  if (
    containsCreationClaimFor(clean, "recordatorio") &&
    !confirmedTools.has("create_reminder")
  ) {
    unconfirmedCreations.push("recordatorio");
  }
  if (
    containsCreationClaimFor(clean, "alarma") &&
    !confirmedTools.has("create_alarm")
  ) {
    unconfirmedCreations.push("alarma");
  }

  const unconfirmedStatuses: string[] = [];
  if (
    containsScheduledStatusClaimFor(clean, "recordatorio") &&
    !confirmedTools.has("create_reminder") &&
    !confirmedTools.has("list_reminders")
  ) {
    unconfirmedStatuses.push("recordatorio");
  }
  if (
    containsScheduledStatusClaimFor(clean, "alarma") &&
    !confirmedTools.has("create_alarm") &&
    !confirmedTools.has("list_alarms")
  ) {
    unconfirmedStatuses.push("alarma");
  }

  const unconfirmedKinds = [...new Set([
    ...unconfirmedCreations,
    ...unconfirmedStatuses,
  ])];
  if (unconfirmedKinds.length === 0) return clean;

  return [
    "⚠️ ACCIÓN NO CONFIRMADA",
    "",
    `El sistema no confirmó la creación ni el estado de ${unconfirmedKinds.join(" ni ")} en esta respuesta.`,
    "No se considerará realizada ninguna acción sin un resultado exitoso de la herramienta correspondiente.",
    "Puedo consultar la lista existente antes de intentar cualquier cambio.",
  ].join("\n");
}


const NAME_QUESTION_PATTERN = /(?:\b(?:como|cómo)\s+te\s+llamas\b|\b(?:cual|cuál)\s+es\s+tu\s+nombre\b|\b(?:me\s+)?(?:dices|dirias|dirías|compartes)\s+tu\s+nombre\b)/i;
const OPERATIONAL_REQUEST_PATTERN = /\b(?:investig\w*|busc\w*|precios?|pdf|markdown|archivos?|tablas?|informes?|gener\w*|cre\w*|corr\w*|errores?|tareas?|resultados?|contenido|comprim\w*|zip|envi\w*|muestr\w*|dame|lee\w*|analiz\w*|configur\w*|recordatorios?|alarmas?|proyectos?)\b/i;

/**
 * Evita que la invitación inicial para conocer el nombre se pegue al final de
 * una investigación, un archivo, una ejecución de herramienta o una respuesta
 * operativa. La pregunta sigue permitida durante una charla casual y cuando el
 * usuario la solicita explícitamente.
 */
export function stripUnrelatedPendingNameQuestion(
  content: string,
  userText: string,
  toolsCalled: readonly string[] = [],
): string {
  const clean = content.trim();
  if (!clean || NAME_QUESTION_PATTERN.test(userText)) return clean;
  if (toolsCalled.length === 0 && !OPERATIONAL_REQUEST_PATTERN.test(userText)) return clean;

  const paragraphs = clean.split(/\n{2,}/);
  while (paragraphs.length > 1 && NAME_QUESTION_PATTERN.test(paragraphs.at(-1) ?? "")) {
    paragraphs.pop();
  }
  return paragraphs.join("\n\n").trim();
}
