import { describe, expect, it } from "bun:test";
import {
  buildMemoryTransactionInstruction,
  detectMemoryPersistenceIntent,
  hasConfirmedMemoryMutation,
} from "../src/memory-intent.ts";

describe("intención transaccional de memoria", () => {
  it("clasifica cumpleaños y fechas personales en la bóveda", () => {
    expect(detectMemoryPersistenceIntent("No olvides que mi mamá cumple años el 12 de enero")).toEqual({
      target: "vault",
      reason: "explicit-command",
      topic: "birthdays",
    });
    expect(detectMemoryPersistenceIntent("El cumpleaños mío es el 18 de enero")).toEqual({
      target: "vault",
      reason: "durable-personal-fact",
      topic: "birthdays",
    });
  });

  it("clasifica datos compactos del perfil", () => {
    expect(detectMemoryPersistenceIntent("Agrega en memoria mi número que es 4341542802")?.target).toBe("profile");
    expect(detectMemoryPersistenceIntent("Mi teléfono es 4341542802")?.target).toBe("profile");
  });

  it("respeta negaciones y borrados", () => {
    expect(detectMemoryPersistenceIntent("No guardes mi número")).toBeNull();
    expect(detectMemoryPersistenceIntent("Olvida el cumpleaños anterior")).toBeNull();
  });

  it("una búsqueda no satisface la mutación obligatoria", () => {
    expect(hasConfirmedMemoryMutation(new Set(["memory_vault_search"]), "vault")).toBe(false);
    expect(hasConfirmedMemoryMutation(new Set(["memory_vault_upsert"]), "vault")).toBe(true);
    expect(hasConfirmedMemoryMutation(new Set(["memory_write"]), "profile")).toBe(true);
  });

  it("ordena conservar una nota temática de cumpleaños", () => {
    const intent = detectMemoryPersistenceIntent("Recuerda que Ana cumple el 8 de diciembre")!;
    const instruction = buildMemoryTransactionInstruction("Recuerda que Ana cumple el 8 de diciembre", intent);
    expect(instruction).toContain("Fechas de cumpleaños");
    expect(instruction).toContain("mode=append");
    expect(instruction).toContain("NO guardan nada");
  });
});
