import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";


import { MemoryManager, MEMORY_TOOLS, executeMemoryTool } from "../src/memory.ts";

// ─── Helpers ─────────────────────────────────────────────────────

let testCounter = 0;

const TEST_JID = "test-user@test.com";
const OTHER_JID = "other-user@test.com";

function createIsolatedMemory(): MemoryManager {
  testCounter++;
  const dir = join(tmpdir(), `codewolf-memory-test-${Date.now()}-${testCounter}`);
  return new MemoryManager(dir);
}

// ─── Tests ───────────────────────────────────────────────────────

describe("MemoryManager — init", () => {
  it("init crea el archivo con contenido por defecto para un jid", () => {
    const mm = createIsolatedMemory();
    mm.init(TEST_JID);

    const content = mm.getContent(TEST_JID);
    expect(content).toContain("Memoria personal de Luna");
    expect(content).toContain("Nombre: pendiente de preguntar");
    expect(content).toContain("pregúntalo de manera natural únicamente durante un saludo o charla casual");
    expect(content).toContain("Nunca anexes la pregunta del nombre a investigaciones");
  });

  it("init no sobreescribe si ya existe", () => {
    const mm = createIsolatedMemory();
    mm.init(TEST_JID);
    const firstContent = mm.getContent(TEST_JID);

    mm.init(TEST_JID); // segunda llamada
    const secondContent = mm.getContent(TEST_JID);
    expect(secondContent).toBe(firstContent);
  });

  it("getContent retorna default si no se ha hecho init", () => {
    const mm = createIsolatedMemory();
    const content = mm.getContent(TEST_JID);
    expect(content).toContain("Memoria personal de Luna");
  });
});

describe("MemoryManager — escritura por JID", () => {
  it("write append agrega contenido al final del jid correcto", () => {
    const mm = createIsolatedMemory();
    mm.init(TEST_JID);

    mm.write(TEST_JID, "append", "Usuario: Juan");
    const content = mm.getContent(TEST_JID);
    expect(content).toContain("Usuario: Juan");
  });

  it("write overwrite reemplaza todo el contenido del jid", () => {
    const mm = createIsolatedMemory();
    mm.init(TEST_JID);

    mm.write(TEST_JID, "overwrite", "Usuario: Maria\nLe gusta el cafe");
    const content = mm.getContent(TEST_JID);
    expect(content).toBe("Usuario: Maria\nLe gusta el cafe\n");
    expect(content).not.toContain("Memoria personal de Luna");
  });

  it("write append funciona sin init previo", () => {
    const mm = createIsolatedMemory();
    mm.write(TEST_JID, "append", "Nota de prueba");
    const content = mm.getContent(TEST_JID);
    expect(content).toContain("Nota de prueba");
  });

  it("contenido aislado entre diferentes JIDs", () => {
    const mm = createIsolatedMemory();

    mm.write(TEST_JID, "overwrite", "Datos del usuario A");
    mm.write(OTHER_JID, "overwrite", "Datos del usuario B");

    const contentA = mm.getContent(TEST_JID);
    const contentB = mm.getContent(OTHER_JID);

    expect(contentA).toContain("usuario A");
    expect(contentA).not.toContain("usuario B");
    expect(contentB).toContain("usuario B");
    expect(contentB).not.toContain("usuario A");
  });

  it("init de un JID no afecta el contenido de otro JID", () => {
    const mm = createIsolatedMemory();

    mm.write(TEST_JID, "append", "Solo para A");
    mm.init(OTHER_JID); // init de otro, no deberia tocar A

    const contentA = mm.getContent(TEST_JID);
    expect(contentA).toContain("Solo para A");
  });
});

describe("MemoryManager — executeMemoryTool con JID", () => {
  it("memory_write con mode append ejecuta correctamente", async () => {
    const mm = createIsolatedMemory();
    mm.init(TEST_JID);

    const result = await executeMemoryTool(
      "memory_write",
      { content: "Usuario: Test", mode: "append" },
      mm,
      TEST_JID,
    );

    expect(result).toContain("Memoria actualizada");
    expect(mm.getContent(TEST_JID)).toContain("Usuario: Test");
  });

  it("memory_write con mode overwrite reemplaza", async () => {
    const mm = createIsolatedMemory();
    mm.init(TEST_JID);

    await executeMemoryTool(
      "memory_write",
      { content: "Solo esto", mode: "overwrite" },
      mm,
      TEST_JID,
    );

    const content = mm.getContent(TEST_JID);
    expect(content).toBe("Solo esto\n");
    expect(content).not.toContain("Memoria personal de Luna");
  });

  it("memory_read retorna el contenido actual del JID correcto", async () => {
    const mm = createIsolatedMemory();
    mm.init(TEST_JID);

    mm.write(TEST_JID, "append", "Dato importante");
    const result = await executeMemoryTool("memory_read", {}, mm, TEST_JID);

    expect(result).toContain("Dato importante");
  });

  it("tool escribe en el JID correcto aunque haya otros JIDs", async () => {
    const mm = createIsolatedMemory();

    mm.write(OTHER_JID, "overwrite", "Datos del otro");
    await executeMemoryTool(
      "memory_write",
      { content: "Datos de test", mode: "overwrite" },
      mm,
      TEST_JID,
    );

    const contentOther = mm.getContent(OTHER_JID);
    const contentTest = mm.getContent(TEST_JID);

    expect(contentTest).toContain("Datos de test");
    expect(contentOther).toContain("Datos del otro");
    expect(contentOther).not.toContain("Datos de test");
  });

  it("tool desconocido retorna mensaje de error", async () => {
    const mm = createIsolatedMemory();

    const result = await executeMemoryTool("unknown_tool", {}, mm, TEST_JID);
    expect(result).toContain("Error");
    expect(result).toContain("unknown_tool");
  });
});

describe("MEMORY_TOOLS — definiciones", () => {
  it("exporta exactamente 2 tools", () => {
    expect(MEMORY_TOOLS).toHaveLength(2);
  });

  it("la primera tool es memory_write", () => {
    expect(MEMORY_TOOLS[0]?.function.name).toBe("memory_write");
  });

  it("la segunda tool es memory_read", () => {
    expect(MEMORY_TOOLS[1]?.function.name).toBe("memory_read");
  });

  it("cada tool tiene type function", () => {
    for (const tool of MEMORY_TOOLS) {
      expect(tool.type).toBe("function");
    }
  });
});

describe("MemoryManager — límites", () => {
  it("rechaza contenido que excede el límite persistente", async () => {
    const { MAX_MEMORY_CHARS } = await import("../src/memory.ts");
    const mm = createIsolatedMemory();
    const result = await executeMemoryTool(
      "memory_write",
      { content: "x".repeat(MAX_MEMORY_CHARS + 1), mode: "overwrite" },
      mm,
      TEST_JID,
    );
    expect(result).toContain("Error");
  });
});
