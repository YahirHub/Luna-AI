import { describe, it, expect } from "bun:test";
import {
  normalizePhoneNumber,
  isValidPhoneNumber,
  isValidYmdDate,
  extractSecretTokenFromMessage,
} from "../src/utils.ts";

describe("normalizePhoneNumber", () => {
  it("removes spaces, dashes, and parentheses", () => {
    expect(normalizePhoneNumber("+1 (234) 567-8901")).toBe("12345678901");
  });

  it("removes leading plus sign", () => {
    expect(normalizePhoneNumber("+521234567890")).toBe("521234567890");
  });

  it("returns digits-only numbers unchanged", () => {
    expect(normalizePhoneNumber("521234567890")).toBe("521234567890");
  });

  it("handles number with only spaces", () => {
    expect(normalizePhoneNumber("52 1 234 567 890")).toBe("521234567890");
  });

  it("handles empty string", () => {
    expect(normalizePhoneNumber("")).toBe("");
  });

  it("handles number with mixed formatting", () => {
    expect(normalizePhoneNumber("+52 (1) 234-567-8901")).toBe("5212345678901");
  });
});

describe("isValidPhoneNumber", () => {
  it("accepts 10-digit number", () => {
    expect(isValidPhoneNumber("1234567890")).toBe(true);
  });

  it("accepts 15-digit number (max)", () => {
    expect(isValidPhoneNumber("123456789012345")).toBe(true);
  });

  it("accepts 7-digit number (min)", () => {
    expect(isValidPhoneNumber("1234567")).toBe(true);
  });

  it("rejects 6-digit number (too short)", () => {
    expect(isValidPhoneNumber("123456")).toBe(false);
  });

  it("rejects 16-digit number (too long)", () => {
    expect(isValidPhoneNumber("1234567890123456")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidPhoneNumber("")).toBe(false);
  });

  it("rejects number with letters", () => {
    expect(isValidPhoneNumber("12345abcde")).toBe(false);
  });

  it("rejects number with special characters", () => {
    expect(isValidPhoneNumber("12345-67890")).toBe(false);
  });

  it("rejects number with plus sign (not normalized)", () => {
    expect(isValidPhoneNumber("+1234567890")).toBe(false);
  });
});

describe("normalizePhoneNumber + isValidPhoneNumber integration", () => {
  it("normalized output passes validation", () => {
    const inputs = [
      "+1 (234) 567-8901",
      "52 1 234 567 890",
      "  521234567890  ",
      "+44-7700-900123",
    ];

    for (const input of inputs) {
      const normalized = normalizePhoneNumber(input);
      expect(isValidPhoneNumber(normalized)).toBe(true);
    }
  });
});

describe("isValidYmdDate", () => {
  it("acepta fechas calendario reales", () => {
    expect(isValidYmdDate("2026-02-28")).toBe(true);
    expect(isValidYmdDate("2028-02-29")).toBe(true);
  });

  it("rechaza formato o fechas imposibles", () => {
    expect(isValidYmdDate("2026-02-29")).toBe(false);
    expect(isValidYmdDate("2026-13-01")).toBe(false);
    expect(isValidYmdDate("16/07/2026")).toBe(false);
  });
});


describe("extractSecretTokenFromMessage", () => {
  it("conserva una API key pegada directamente", () => {
    expect(extractSecretTokenFromMessage("sk-direct-secret")).toBe("sk-direct-secret");
  });

  it("extrae la API key desde frases naturales con dos puntos", () => {
    expect(extractSecretTokenFromMessage("Este es el de exa.ai:exa-secret-123")).toBe("exa-secret-123");
  });

  it("extrae la API key desde frases con 'es'", () => {
    expect(extractSecretTokenFromMessage("Mi API key es sk-natural-123")).toBe("sk-natural-123");
  });
});
