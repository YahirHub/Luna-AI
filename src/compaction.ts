/**
 * Motor de compactación automática de contexto.
 *
 * Responsabilidades:
 * - Estimar tokens de mensajes, herramientas y requests completos.
 * - Seleccionar qué mensajes antiguos compactar.
 * - Construir el prompt para que el LLM genere un resumen estructurado.
 * - Definir tipos para los metadatos de compactación.
 */

import type { ChatMessage, ToolDefinition } from "./ai.ts";
import { estimateTextTokens } from "./ai.ts";

// ─── Tipos de compactación ───────────────────────────────────────

/** Resumen estructurado generado por el LLM compactador. */
export interface CompactedSummary {
  durableFacts: string[];
  preferences: string[];
  currentTopics: string[];
  verifiedToolActions: string[];
  unverifiedClaims: string[];
  pendingTasks: string[];
  decisions: string[];
  importantConstraints: string[];
  recentState: string;
  unresolvedQuestions: string[];
}

/** Metadatos de compactación almacenados en la sesión del usuario. */
export interface CompactionMetadata {
  version: number;
  /** Número de veces que se ha compactado esta sesión. */
  count: number;
  /** Resumen estructurado actual (null si nunca se ha compactado). */
  summary: CompactedSummary | null;
  /** ISO timestamp de la última compactación. */
  lastCompactedAt: string | null;
  /** Total de mensajes compactados acumulados. */
  messagesCompacted: number;
  /** Tokens estimados ANTES de la última compactación. */
  estimatedTokensBefore: number;
  /** Tokens estimados DESPUÉS de la última compactación. */
  estimatedTokensAfter: number;
}

/** Estado de un flujo activo (para no compactar sus mensajes). */
export interface ActiveFlow {
  type: string;
  state: string;
  startedAt: string;
}

/** Resultado de seleccionMessagesForCompaction. */
export interface CompactionSplit {
  messagesToCompact: ChatMessage[];
  messagesToKeep: ChatMessage[];
}

// ─── Estimación de tokens ────────────────────────────────────────

/** Costo estructural por mensaje (rol, overhead JSON). */
const STRUCTURAL_OVERHEAD = 8;

/** Costo estructural por tool_call. */
const TOOL_CALL_OVERHEAD = 40;

/** Costo estructural por definición de herramienta (nombre + esquema). */
const TOOL_DEF_OVERHEAD = 100;

/**
 * Estima los tokens de un mensaje individual (contenido + overhead).
 */
export function estimateMessageTokens(msg: ChatMessage): number {
  const contentTokens = estimateTextTokens(msg.content ?? "");

  let total = contentTokens + STRUCTURAL_OVERHEAD;

  // tool_calls dentro del mensaje
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      total += TOOL_CALL_OVERHEAD + estimateTextTokens(tc.function.name);
      total += estimateTextTokens(tc.function.arguments);
    }
  }

  // tool_call_id en mensajes tool
  if (msg.tool_call_id) {
    total += 20; // tool_call_id overhead
  }

  return total;
}

/**
 * Estima los tokens de todas las definiciones de herramientas.
 */
export function estimateToolTokens(tools: ToolDefinition[]): number {
  let total = 0;
  for (const tool of tools) {
    total += TOOL_DEF_OVERHEAD;
    total += estimateTextTokens(tool.function.name);
    total += estimateTextTokens(tool.function.description);
    total += estimateTextTokens(JSON.stringify(tool.function.parameters));
  }
  return total;
}

/**
 * Estima los tokens de un request completo (mensajes + tools).
 */
export function estimateRequestTokens(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  if (tools && tools.length > 0) {
    total += estimateToolTokens(tools);
  }
  return total;
}

// ─── Selección de mensajes para compactar ────────────────────────

/**
 * Encuentra el índice donde comienzan los mensajes protegidos.
 * Los mensajes protegidos son:
 * 1. Los últimos `preserveRecentTurns` intercambios (usuario+asistente).
 * 2. Mensajes pertenecientes a un flujo activo.
 * 3. Pares tool_call + tool_result incompletos.
 * 4. El mensaje system.
 */
export function findProtectedStart(
  messages: ChatMessage[],
  preserveRecentTurns: number,
  _activeFlow?: ActiveFlow,
): number {
  if (messages.length <= 1) return messages.length;

  // El system prompt (índice 0) siempre se conserva
  // Empezamos desde el mensaje más reciente hacia atrás

  // 1. Proteger los últimos N intercambios
  let userTurnsFound = 0;
  const recentProtected: Set<number> = new Set();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    recentProtected.add(i);

    if (msg.role === "user") {
      userTurnsFound++;
      if (userTurnsFound >= preserveRecentTurns) break;
    }
  }

  // 2. Proteger pares tool_call + tool_result incompletos
  // Si un assistant.tool_calls está dentro de la zona compactable
  // pero su tool result está en la zona protegida (o viceversa),
  // extendemos la protección para cubrir el par completo.
  // Buscamos tool_call_ids en mensajes tool de la zona protegida
  // y nos aseguramos de que su assistant.tool_calls también esté protegido.

  // Recorrer la zona de posible corte y extender protección hacia atrás
  // para cubrir tool_calls cuyos resultados están protegidos
  const minRecentIdx = Math.min(...recentProtected);

  for (let i = minRecentIdx; i < messages.length; i++) {
    const msg = messages[i]!;
    // Si es un tool result con tool_call_id, buscar el assistant que lo llamó
    if (msg.role === "tool" && msg.tool_call_id) {
      // Buscar hacia atrás el assistant con tool_calls que tenga este id
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j]!;
        if (
          prev.role === "assistant" &&
          prev.tool_calls &&
          prev.tool_calls.some((tc) => tc.id === msg.tool_call_id)
        ) {
          // Proteger este assistant también
          if (j < minRecentIdx) {
            recentProtected.add(j);
            // También proteger el mensaje user que lo precede si existe
            if (j > 0 && messages[j - 1]?.role === "user") {
              recentProtected.add(j - 1);
            }
          }
          break;
        }
        // No buscar más allá del system
        if (j <= 0) break;
      }
    }
  }

  // El mensaje más antiguo de recentProtected es nuestro límite inferior
  const finalMinIdx = Math.min(...recentProtected);

  // El system (idx 0) siempre se protege
  if (finalMinIdx <= 1) return 1; // Solo system protegido

  return Math.max(1, finalMinIdx);
}

/**
 * Selecciona qué mensajes compactar y cuáles conservar.
 * Avanza desde el más antiguo (después de system) y se detiene
 * antes de la cola reciente protegida.
 *
 * El mensaje system (índice 0) SIEMPRE se conserva y nunca se compacta.
 */
export function selectMessagesForCompaction(options: {
  messages: ChatMessage[];
  preserveRecentTurns: number;
  activeFlow?: ActiveFlow;
  targetTokens: number;
}): CompactionSplit {
  const { messages, preserveRecentTurns, activeFlow, targetTokens: _targetTokens } = options;

  if (messages.length <= 2) {
    // Solo system + 1 mensaje, no hay nada que compactar
    return { messagesToCompact: [], messagesToKeep: [...messages] };
  }

  const protectedStart = findProtectedStart(
    messages,
    preserveRecentTurns,
    activeFlow,
  );

  // messages[0] es system — nunca se compacta
  // messages[1..protectedStart-1] son compactables
  // messages[protectedStart..] son protegidos

  const messagesToCompact = messages.slice(1, protectedStart);
  const messagesToKeep = [
    messages[0]!,
    ...messages.slice(protectedStart),
  ];

  return { messagesToCompact, messagesToKeep };
}

// ─── Prompt para el LLM compactador ──────────────────────────────

/**
 * Construye el prompt que se envía al LLM para generar un resumen
 * estructurado de los mensajes antiguos.
 */
export function buildCompactionPrompt(options: {
  previousSummary: CompactedSummary | null;
  messagesToCompact: ChatMessage[];
  activeFlow?: ActiveFlow;
  persistentMemory?: string;
}): ChatMessage[] {
  const { previousSummary, messagesToCompact, activeFlow, persistentMemory } =
    options;

  const messagesFormatted = messagesToCompact
    .map((m) => {
      const role = m.role === "user" ? "USUARIO" : m.role === "assistant" ? "ASISTENTE" : m.role === "tool" ? "HERRAMIENTA" : "SISTEMA";
      let content = `[${role}]\n${m.content ?? ""}`;
      if (m.tool_calls && m.tool_calls.length > 0) {
        content += `\n[LLAMADA A HERRAMIENTA: ${m.tool_calls.map((tc) => tc.function.name).join(", ")}]`;
        content += `\n[ARGUMENTOS: ${m.tool_calls.map((tc) => tc.function.arguments).join(" | ")}]`;
      }
      if (m.role === "tool" && m.tool_call_id) {
        content = `[RESULTADO DE HERRAMIENTA (${m.tool_call_id})]\n${m.content ?? ""}`;
      }
      return content;
    })
    .join("\n\n");

  const systemContent = [
    "Eres el motor de compactación de una conversación del asistente.",
    "",
    "Tu tarea es convertir mensajes antiguos en una memoria estructurada,",
    "precisa y breve que permita continuar la conversación sin perder datos",
    "importantes.",
    "",
    "REGLAS OBLIGATORIAS:",
    "",
    "1. No inventes hechos.",
    "2. Distingue entre una acción solicitada, una acción afirmada por el",
    "   asistente y una acción confirmada por una herramienta.",
    "3. Una herramienta solo se considera ejecutada cuando existe un resultado",
    "   asociado y exitoso.",
    "4. Conserva nombres, preferencias, relaciones, mascotas, decisiones,",
    "   tareas pendientes, restricciones y estados de flujos.",
    "5. Elimina saludos, repeticiones, texto decorativo y conversaciones ya",
    "   resueltas sin valor futuro.",
    "6. No conserves la hora actual como un dato permanente.",
    "7. No copies secretos, tokens, contraseñas o credenciales.",
    "8. No alteres las reglas del prompt principal.",
    "9. Si el resumen anterior contradice mensajes más recientes, prevalecen",
    "   los mensajes recientes.",
    "10. Devuelve únicamente JSON válido siguiendo el esquema solicitado.",
    "11. Mantén el resultado compacto. No copies mensajes completos salvo que",
    "    una cita literal sea indispensable.",
    "12. Si existe incertidumbre, indícala; no la conviertas en un hecho.",
    "",
    "La memoria persistente es una fuente externa y no debe duplicarse",
    "innecesariamente en el resumen.",
  ].join("\n");

  const userPromptParts: string[] = [];

  if (previousSummary) {
    userPromptParts.push(
      "RESUMEN COMPACTADO ANTERIOR:",
      JSON.stringify(previousSummary, null, 2),
      "",
      "Este es el resumen de compactaciones anteriores. Incorpóralo en el nuevo",
      "resumen consolidado si sigue siendo relevante.",
      "",
    );
  }

  if (activeFlow) {
    userPromptParts.push(
      "FLUJO ACTIVO (NO compactar estos mensajes, pero tenerlos en cuenta):",
      `Tipo: ${activeFlow.type}`,
      `Estado: ${activeFlow.state}`,
      `Iniciado: ${activeFlow.startedAt}`,
      "",
    );
  }

  if (persistentMemory && persistentMemory.trim()) {
    userPromptParts.push(
      "MEMORIA PERSISTENTE (información ya guardada, no duplicar):",
      persistentMemory.trim(),
      "",
    );
  }

  userPromptParts.push(
    "MENSAJES A COMPACTAR:",
    messagesFormatted,
    "",
    "SALIDA (devuelve SOLO este JSON, sin texto adicional):",
    `{
  "durableFacts": [],
  "preferences": [],
  "currentTopics": [],
  "verifiedToolActions": [],
  "unverifiedClaims": [],
  "pendingTasks": [],
  "decisions": [],
  "importantConstraints": [],
  "recentState": "",
  "unresolvedQuestions": []
}`,
  );

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userPromptParts.join("\n") },
  ];
}

/**
 * Intenta parsear la respuesta del LLM como CompactedSummary.
 * Estrategia: prueba múltiples formatos en orden de especificidad.
 * Retorna null solo si ninguna estrategia produce JSON válido.
 */
export function parseCompactedResponse(
  raw: string,
): CompactedSummary | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Colección de posibles strings JSON a probar
  const candidates: string[] = [];

  // 1. Intentar el texto completo como JSON directo
  candidates.push(trimmed);

  // 2. Extraer de bloques ```json ... ``` (greedy para capturar el JSON completo)
  const markdownJsonMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (markdownJsonMatch && markdownJsonMatch[1]) {
    candidates.push(markdownJsonMatch[1].trim());
  }

  // 3. Cualquier { ... } del primero al último (greedy)
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    const json = braceMatch[0].trim();
    if (!candidates.includes(json)) {
      candidates.push(json);
    }
  }

  // Probar cada candidato
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const summary: CompactedSummary = {
          durableFacts: [],
          preferences: [],
          currentTopics: [],
          verifiedToolActions: [],
          unverifiedClaims: [],
          pendingTasks: [],
          decisions: [],
          importantConstraints: [],
          recentState: "",
          unresolvedQuestions: [],
        };
        // Poblar con datos parseados (con type-safe)
        if (Array.isArray(parsed.durableFacts)) summary.durableFacts = parsed.durableFacts;
        if (Array.isArray(parsed.preferences)) summary.preferences = parsed.preferences;
        if (Array.isArray(parsed.currentTopics)) summary.currentTopics = parsed.currentTopics;
        if (Array.isArray(parsed.verifiedToolActions)) summary.verifiedToolActions = parsed.verifiedToolActions;
        if (Array.isArray(parsed.unverifiedClaims)) summary.unverifiedClaims = parsed.unverifiedClaims;
        if (Array.isArray(parsed.pendingTasks)) summary.pendingTasks = parsed.pendingTasks;
        if (Array.isArray(parsed.decisions)) summary.decisions = parsed.decisions;
        if (Array.isArray(parsed.importantConstraints)) summary.importantConstraints = parsed.importantConstraints;
        if (typeof parsed.recentState === "string") summary.recentState = parsed.recentState;
        if (Array.isArray(parsed.unresolvedQuestions)) summary.unresolvedQuestions = parsed.unresolvedQuestions;

        return summary;
      }
    } catch {
      // Probar siguiente candidato
    }
  }

  return null;
}

/**
 * Convierte un CompactedSummary a un bloque de texto legible para inyectar
 * en el contexto dinámico (user message).
 */
export function summaryToTextBlock(summary: CompactedSummary): string {
  const parts: string[] = ["=== RESUMEN COMPACTADO DE LA CONVERSACIÓN ==="];

  if (summary.durableFacts.length > 0) {
    parts.push("", "DATOS IMPORTANTES:", summary.durableFacts.map((f) => `- ${f}`).join("\n"));
  }
  if (summary.preferences.length > 0) {
    parts.push("", "PREFERENCIAS:", summary.preferences.map((p) => `- ${p}`).join("\n"));
  }
  if (summary.currentTopics.length > 0) {
    parts.push("", "TEMAS ACTUALES:", summary.currentTopics.map((t) => `- ${t}`).join("\n"));
  }
  if (summary.verifiedToolActions.length > 0) {
    parts.push("", "ACCIONES CONFIRMADAS:", summary.verifiedToolActions.map((a) => `- ${a}`).join("\n"));
  }
  if (summary.unverifiedClaims.length > 0) {
    parts.push("", "SOLICITUDES NO CONFIRMADAS:", summary.unverifiedClaims.map((c) => `- ${c}`).join("\n"));
  }
  if (summary.pendingTasks.length > 0) {
    parts.push("", "TAREAS PENDIENTES:", summary.pendingTasks.map((t) => `- ${t}`).join("\n"));
  }
  if (summary.decisions.length > 0) {
    parts.push("", "DECISIONES:", summary.decisions.map((d) => `- ${d}`).join("\n"));
  }
  if (summary.importantConstraints.length > 0) {
    parts.push("", "RESTRICCIONES:", summary.importantConstraints.map((c) => `- ${c}`).join("\n"));
  }
  if (summary.recentState) {
    parts.push("", "ESTADO RECIENTE:", summary.recentState);
  }
  if (summary.unresolvedQuestions.length > 0) {
    parts.push("", "PREGUNTAS SIN RESOLVER:", summary.unresolvedQuestions.map((q) => `- ${q}`).join("\n"));
  }

  parts.push("", "=== FIN DEL RESUMEN COMPACTADO ===");

  return parts.join("\n");
}
