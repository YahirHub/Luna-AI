import { describe, it, expect } from "bun:test";
import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateRequestTokens,
  selectMessagesForCompaction,
  findProtectedStart,
  buildCompactionPrompt,
  parseCompactedResponse,
  summaryToTextBlock,
} from "../src/compaction.ts";
import type { ChatMessage, ToolDefinition } from "../src/ai.ts";

// ─── Helpers ─────────────────────────────────────────────────────

function makeMsg(
  role: ChatMessage["role"],
  content: string,
  overrides?: Partial<ChatMessage>,
): ChatMessage {
  return { role, content, ...overrides };
}

function makeToolCall(
  name: string,
  args: string = "{}",
  id: string = "call_1",
): NonNullable<ChatMessage["tool_calls"]>[number] {
  return { id, type: "function", function: { name, arguments: args } };
}

// ─── Tests de estimación ─────────────────────────────────────────

describe("estimateTextTokens", () => {
  it("calcula tokens para texto vacío", () => {
    expect(estimateTextTokens("")).toBe(0);
  });

  it("calcula tokens para texto corto", () => {
    // "hola" = 4 chars / 3 = 1.33 → 2
    expect(estimateTextTokens("hola")).toBe(2);
  });

  it("calcula tokens para texto largo", () => {
    const text = "a".repeat(300);
    expect(estimateTextTokens(text)).toBe(100);
  });
});

describe("estimateMessageTokens", () => {
  it("calcula tokens de mensaje simple", () => {
    const msg = makeMsg("user", "hola");
    const tokens = estimateMessageTokens(msg);
    // content chars/3 = 2 + overhead 8 = 10
    expect(tokens).toBe(10);
  });

  it("incluye overhead de tool_calls", () => {
    const msg = makeMsg("assistant", "", {
      tool_calls: [makeToolCall("test_tool", '{"key":"val"}')],
    });
    const tokens = estimateMessageTokens(msg);
    // content 0 + overhead 8 + tool_call overhead 40 + name "test_tool" length 9/3=3 + args length 11/3=4 = 55
    expect(tokens).toBeGreaterThan(50);
    expect(tokens).toBeLessThan(60);
  });

  it("incluye overhead de tool_call_id", () => {
    const msg = makeMsg("tool", "resultado", { tool_call_id: "call_123" });
    const tokens = estimateMessageTokens(msg);
    // content "resultado" 9/3=3 + overhead 8 + tool_call_id overhead 20 = 31
    expect(tokens).toBe(31);
  });
});

describe("estimateRequestTokens", () => {
  it("calcula tokens de request sin tools", () => {
    const messages = [
      makeMsg("system", "Eres un asistente"),
      makeMsg("user", "Hola"),
    ];
    const tokens = estimateRequestTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it("incluye tokens de tools cuando se proporcionan", () => {
    const messages = [makeMsg("user", "test")];
    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "test_tool",
          description: "Una herramienta de prueba",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const tokensWithTools = estimateRequestTokens(messages, tools);
    const tokensWithoutTools = estimateRequestTokens(messages);
    expect(tokensWithTools).toBeGreaterThan(tokensWithoutTools);
  });
});

// ─── Tests de selección ─────────────────────────────────────────

describe("findProtectedStart", () => {
  it("protege los últimos N intercambios de usuario", () => {
    const messages: ChatMessage[] = [
      makeMsg("system", "System prompt"),
      makeMsg("user", "Msg 1"),
      makeMsg("assistant", "Resp 1"),
      makeMsg("user", "Msg 2"),
      makeMsg("assistant", "Resp 2"),
      makeMsg("user", "Msg 3"),
    ];

    const start = findProtectedStart(messages, 2);
    // Debería proteger al menos los últimos 2 user turns
    // system[0], user1[1], asst1[2], user2[3], asst2[4], user3[5]
    // Últimos 2 user turns = user2 (idx 3) y user3 (idx 5) → protected desde idx 3
    expect(start).toBe(3);
  });

  it("retorna 1 si hay menos mensajes que proteger", () => {
    const messages: ChatMessage[] = [
      makeMsg("system", "System prompt"),
      makeMsg("user", "Solo un mensaje"),
    ];

    const start = findProtectedStart(messages, 10);
    expect(start).toBe(1);
  });

  it("retorna messages.length si solo hay system", () => {
    const messages: ChatMessage[] = [makeMsg("system", "Solo system")];
    const start = findProtectedStart(messages, 5);
    expect(start).toBe(1); // Solo hay system, nada que compactar realmente
  });
});

describe("selectMessagesForCompaction", () => {
  it("selecciona mensajes antiguos y conserva recientes", () => {
    const messages: ChatMessage[] = [
      makeMsg("system", "System"),
      makeMsg("user", "Antiguo 1"),
      makeMsg("assistant", "Resp 1"),
      makeMsg("user", "Antiguo 2"),
      makeMsg("assistant", "Resp 2"),
      makeMsg("user", "Reciente 1"),
      makeMsg("assistant", "Resp reciente 1"),
      makeMsg("user", "Reciente 2"),
    ];

    const result = selectMessagesForCompaction({
      messages,
      preserveRecentTurns: 2,
      targetTokens: 5000,
    });

    // Debe compactar los antiguos (3-4) y conservar recientes (4-5) + system
    expect(result.messagesToCompact.length).toBeGreaterThan(0);
    expect(result.messagesToKeep.length).toBeGreaterThan(0);
    // System siempre se conserva
    expect(result.messagesToKeep[0]?.role).toBe("system");
  });

  it("retorna split vacío si hay <= 2 mensajes", () => {
    const messages: ChatMessage[] = [
      makeMsg("system", "System"),
      makeMsg("user", "Un msg"),
    ];

    const result = selectMessagesForCompaction({
      messages,
      preserveRecentTurns: 5,
      targetTokens: 5000,
    });

    expect(result.messagesToCompact.length).toBe(0);
    expect(result.messagesToKeep.length).toBe(2);
  });

  it("no compacta mensajes si preserveRecentTurns es grande", () => {
    const messages: ChatMessage[] = [
      makeMsg("system", "System"),
      makeMsg("user", "Solo esto"),
      makeMsg("assistant", "Resp"),
    ];

    const result = selectMessagesForCompaction({
      messages,
      preserveRecentTurns: 5,
      targetTokens: 5000,
    });

    // Con preserveRecentTurns=5 y solo 3 mensajes no-system,
    // todos deberían estar protegidos
    expect(result.messagesToCompact.length).toBe(0);
    expect(result.messagesToKeep.length).toBe(3);
  });
});

// ─── Tests de parseo y formato ───────────────────────────────────

describe("parseCompactedResponse", () => {
  it("parsea JSON plano correctamente", () => {
    const raw = JSON.stringify({
      durableFacts: ["El usuario se llama Juan"],
      preferences: ["Prefiere trato casual"],
      currentTopics: [],
      verifiedToolActions: [],
      unverifiedClaims: [],
      pendingTasks: [],
      decisions: [],
      importantConstraints: [],
      recentState: "",
      unresolvedQuestions: [],
    });

    const result = parseCompactedResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.durableFacts).toEqual(["El usuario se llama Juan"]);
    expect(result!.preferences).toEqual(["Prefiere trato casual"]);
  });

  it("extrae JSON de bloque markdown ```json ... ```", () => {
    const raw = "```json\n{\"durableFacts\":[\"test\"],\"preferences\":[],\"currentTopics\":[],\"verifiedToolActions\":[],\"unverifiedClaims\":[],\"pendingTasks\":[],\"decisions\":[],\"importantConstraints\":[],\"recentState\":\"\",\"unresolvedQuestions\":[]}\n```";
    const result = parseCompactedResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.durableFacts).toEqual(["test"]);
  });

  it("extrae JSON de bloque markdown solo ```", () => {
    const raw = "```\n{\"durableFacts\":[\"test2\"],\"preferences\":[],\"currentTopics\":[],\"verifiedToolActions\":[],\"unverifiedClaims\":[],\"pendingTasks\":[],\"decisions\":[],\"importantConstraints\":[],\"recentState\":\"\",\"unresolvedQuestions\":[]}\n```";
    const result = parseCompactedResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.durableFacts).toEqual(["test2"]);
  });

  it("retorna null para JSON inválido", () => {
    const result = parseCompactedResponse("Esto no es JSON");
    expect(result).toBeNull();
  });

  it("retorna null para string vacío", () => {
    const result = parseCompactedResponse("");
    expect(result).toBeNull();
  });

  it("extrae JSON con contenido real de conversación (arrays poblados)", () => {
    const raw = `{
  "durableFacts": ["El usuario se llama Yahir", "Tiene un gato llamado Towi"],
  "preferences": ["Prefiere trato casual"],
  "currentTopics": ["La visita veterinaria de Towi"],
  "verifiedToolActions": [],
  "unverifiedClaims": [],
  "pendingTasks": ["Confirmar si el recordatorio se creó"],
  "decisions": [],
  "importantConstraints": [],
  "recentState": "La conversación trataba sobre la salud de Towi",
  "unresolvedQuestions": ["¿Cuándo es la cita?"]
}`;
    const result = parseCompactedResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.durableFacts).toContain("Tiene un gato llamado Towi");
    expect(result!.pendingTasks).toContain("Confirmar si el recordatorio se creó");
    expect(result!.recentState).toBe("La conversación trataba sobre la salud de Towi");
    expect(result!.unresolvedQuestions).toContain("¿Cuándo es la cita?");
  });

  it("extrae JSON de markdown con texto adicional alrededor", () => {
    const raw = [
      "Aquí está el resumen solicitado:",
      "",
      '```json',
      '{',
      '  "durableFacts": ["Usuario: María"],',
      '  "preferences": [],',
      '  "currentTopics": [],',
      '  "verifiedToolActions": [],',
      '  "unverifiedClaims": [],',
      '  "pendingTasks": [],',
      '  "decisions": [],',
      '  "importantConstraints": [],',
      '  "recentState": "",',
      '  "unresolvedQuestions": []',
      '}',
      '```',
      '',
      'Espero que sea útil.',
    ].join("\n");

    const result = parseCompactedResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.durableFacts).toEqual(["Usuario: María"]);
  });

  it("extrae JSON cuando hay texto antes sin markdown", () => {
    const raw =
      "Te presento el resumen:\n\n" +
      '{"durableFacts":["Dato importante"],"preferences":[],"currentTopics":[],"verifiedToolActions":[],"unverifiedClaims":[],"pendingTasks":[],"decisions":[],"importantConstraints":[],"recentState":"","unresolvedQuestions":[]}' +
      "\n\nFin del resumen.";

    const result = parseCompactedResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.durableFacts).toEqual(["Dato importante"]);
  });

  it("tolera campos faltantes usando valores por defecto", () => {
    // Solo algunos campos, el resto deberían ser arrays vacíos
    const raw = JSON.stringify({
      durableFacts: ["Solo esto"],
    });

    const result = parseCompactedResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.durableFacts).toEqual(["Solo esto"]);
    expect(result!.preferences).toEqual([]);
    expect(result!.currentTopics).toEqual([]);
    expect(result!.recentState).toBe("");
  });
});

describe("summaryToTextBlock", () => {
  it("genera bloque de texto con datos importantes", () => {
    const summary = {
      durableFacts: ["Nombre: Juan"],
      preferences: ["Trato casual"],
      currentTopics: [],
      verifiedToolActions: ["Recordatorio creado con ID: rem_123"],
      unverifiedClaims: [],
      pendingTasks: [],
      decisions: [],
      importantConstraints: [],
      recentState: "Juan estaba preguntando por la hora",
      unresolvedQuestions: [],
    };

    const block = summaryToTextBlock(summary);
    expect(block).toContain("RESUMEN COMPACTADO");
    expect(block).toContain("Nombre: Juan");
    expect(block).toContain("Trato casual");
    expect(block).toContain("Recordatorio creado");
    expect(block).toContain("Juan estaba preguntando");
    expect(block).toContain("FIN DEL RESUMEN");
  });
});

// ─── Tests de integración del prompt builder ─────────────────────

describe("buildCompactionPrompt", () => {
  it("construye mensajes para el LLM compactador", () => {
    const result = buildCompactionPrompt({
      previousSummary: null,
      messagesToCompact: [
        makeMsg("user", "Hola, me llamo Juan"),
        makeMsg("assistant", "¡Hola Juan! ¿cómo estás?"),
      ],
    });

    expect(result.length).toBe(2);
    expect(result[0]?.role).toBe("system");
    expect(result[1]?.role).toBe("user");
    expect(result[1]?.content).toContain("Hola, me llamo Juan");
  });

  it("incluye resumen anterior cuando existe", () => {
    const prevSummary = {
      durableFacts: ["Juan tiene un gato"],
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

    const result = buildCompactionPrompt({
      previousSummary: prevSummary,
      messagesToCompact: [makeMsg("user", "nuevo mensaje")],
    });

    expect(result[1]?.content).toContain("RESUMEN COMPACTADO ANTERIOR");
    expect(result[1]?.content).toContain("Juan tiene un gato");
  });

  it("incluye memoria persistente cuando se proporciona", () => {
    const result = buildCompactionPrompt({
      previousSummary: null,
      messagesToCompact: [makeMsg("user", "hola")],
      persistentMemory: "Nombre: María\nEdad: 25",
    });

    expect(result[1]?.content).toContain("MEMORIA PERSISTENTE");
    expect(result[1]?.content).toContain("Nombre: María");
  });

  it("incluye flujo activo cuando se proporciona", () => {
    const result = buildCompactionPrompt({
      previousSummary: null,
      messagesToCompact: [makeMsg("user", "hola")],
      activeFlow: { type: "create_reminder", state: "waiting_for_date", startedAt: "2026-01-01T00:00:00Z" },
    });

    expect(result[1]?.content).toContain("FLUJO ACTIVO");
    expect(result[1]?.content).toContain("create_reminder");
  });
});
