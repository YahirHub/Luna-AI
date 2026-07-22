export type MemoryPersistenceTarget = "profile" | "vault";

export interface MemoryPersistenceIntent {
  target: MemoryPersistenceTarget;
  reason: "explicit-command" | "durable-personal-fact";
  topic?: "birthdays" | "general";
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const NEGATED_SAVE = /\b(?:no|nunca)\s+(?:lo\s+)?(?:guardes|recuerdes|anotes|apuntes|memorices|agregues)\b|\b(?:olvida|borra|elimina)\b/;
const EXPLICIT_SAVE = /\b(?:recuerda|recuerdalo|recuerdame|no olvides|guarda|guardalo|agrega|agregalo|anota|anotalo|apunta|apuntalo|memoriza|memorizalo|registralo|registralo)\b/;
const MEMORY_DESTINATION = /\b(?:en|a)\s+(?:tu|la|mi)?\s*(?:memoria|boveda)\b/;
const VAULT_TOPIC = /\b(?:cumple(?:\s+anos|anos?)?|fecha(?:s)?|aniversario(?:s)?|nacimiento|persona(?:s)?|familia|mama|madre|papa|padre|proyecto(?:s)?|decision(?:es)?|inventario(?:s)?|referencia(?:s)?|servidor(?:es)?|dominio(?:s)?|renovacion(?:es)?|vencimiento(?:s)?|evento(?:s)?|lista(?:s)?)\b/;
const PROFILE_TOPIC = /\b(?:mi\s+nombre|me\s+llamo|mi\s+numero|mi\s+telefono|mi\s+celular|mi\s+correo|mi\s+email|prefiero|me\s+gusta\s+que|hablame|tratame|forma\s+de\s+trato)\b/;
const DURABLE_BIRTHDAY_FACT = /\b(?:mi|su|el|la|de\s+mi\s+\w+)\s+cumple(?:\s+anos|anos?)?\b|\bcumple(?:\s+anos|anos?)?\s+(?:el|los|en)?\s*\d{1,2}\b/;
const DURABLE_CONTACT_FACT = /\bmi\s+(?:numero|telefono|celular|correo|email)\s+(?:es|:)/;

/**
 * Detecta únicamente solicitudes suficientemente claras para exigir una
 * escritura persistente. Las negaciones y operaciones de borrado prevalecen.
 */
export function detectMemoryPersistenceIntent(text: string): MemoryPersistenceIntent | null {
  const normalized = normalize(text);
  if (!normalized || NEGATED_SAVE.test(normalized)) return null;

  const explicit = EXPLICIT_SAVE.test(normalized) || MEMORY_DESTINATION.test(normalized);
  const durableBirthday = DURABLE_BIRTHDAY_FACT.test(normalized);
  const durableContact = DURABLE_CONTACT_FACT.test(normalized);
  if (!explicit && !durableBirthday && !durableContact) return null;

  if (VAULT_TOPIC.test(normalized) || durableBirthday) {
    return {
      target: "vault",
      reason: explicit ? "explicit-command" : "durable-personal-fact",
      topic: /\bcumple(?:\s+anos|anos?)?\b/.test(normalized) ? "birthdays" : "general",
    };
  }
  if (PROFILE_TOPIC.test(normalized) || durableContact) {
    return { target: "profile", reason: explicit ? "explicit-command" : "durable-personal-fact" };
  }

  // Un dato explícitamente enviado a "memoria" pero sin tema de colección se
  // considera perfil compacto. El modelo puede seguir usando la bóveda cuando
  // el contenido claramente sea una colección temática.
  return { target: "profile", reason: "explicit-command" };
}

export function memoryMutationToolsFor(target: MemoryPersistenceTarget): readonly string[] {
  return target === "profile"
    ? ["memory_write"]
    : ["memory_vault_upsert", "memory_vault_edit"];
}

export function hasConfirmedMemoryMutation(
  confirmedTools: ReadonlySet<string>,
  target: MemoryPersistenceTarget,
): boolean {
  return memoryMutationToolsFor(target).some((tool) => confirmedTools.has(tool));
}

export function buildMemoryTransactionInstruction(
  userText: string,
  intent: MemoryPersistenceIntent,
  retry = false,
): string {
  const required = intent.target === "profile"
    ? "memory_write"
    : "memory_vault_upsert o memory_vault_edit";
  return [
    retry
      ? "[REINTENTO AUTORITATIVO DE MEMORIA]"
      : "[TRANSACCIÓN DE MEMORIA OBLIGATORIA]",
    `La solicitud actual exige persistencia en ${intent.target === "profile" ? "memory.md" : "la bóveda temática"}.`,
    `Debes ejecutar y obtener éxito de ${required} antes de responder al usuario.`,
    intent.target === "vault"
      ? intent.topic === "birthdays"
        ? "Puedes buscar o leer primero, pero memory_vault_search/read NO guardan nada. Después debes mutar en esta misma ronda. Usa el título temático exacto \"Fechas de cumpleaños\" (o su ruta existente), mode=append para una entrada nueva y conserva todas las fechas anteriores. Si falta el año, escribe explícitamente año desconocido; no lo inventes."
        : "Puedes buscar o leer primero, pero memory_vault_search/read NO guardan nada. Después de consultar debes mutar una nota temática en esta misma ronda y conservar los datos existentes."
      : "Conserva el perfil existente: usa append para agregar un dato nuevo y overwrite solo si has reconstruido deliberadamente todo memory.md.",
    "No afirmes que algo quedó guardado basándote en una búsqueda, en el contexto recuperado o en una respuesta anterior.",
    `Solicitud original: ${userText}`,
  ].join("\n");
}

export function buildUnconfirmedMemoryResponse(target: MemoryPersistenceTarget, detail?: string): string {
  return [
    "⚠️ MEMORIA NO CONFIRMADA",
    "",
    `No pude confirmar una escritura exitosa en ${target === "profile" ? "el perfil persistente" : "la bóveda personal"}.`,
    "Por seguridad no voy a decir que el dato quedó guardado cuando ninguna herramienta confirmó la operación.",
    detail ? `Detalle: ${detail}` : "Puedes volver a intentarlo; el sistema exigirá una escritura real antes de confirmar.",
  ].join("\n");
}

export function buildConfirmedMemoryResponse(
  target: MemoryPersistenceTarget,
  toolResult: string,
): string {
  if (target === "profile") {
    return [
      "✅ Dato guardado en el perfil persistente.",
      "La escritura fue confirmada por el sistema y sobrevivirá a !clear.",
    ].join("\n");
  }
  return [
    "✅ Dato guardado en la bóveda personal.",
    toolResult.trim(),
  ].join("\n\n");
}
