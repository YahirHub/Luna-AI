import { describe, expect, it } from "bun:test";
import { readUrl } from "../src/search/read-url.ts";

describe("readUrl", () => {
  it("bloquea localhost y redes privadas", async () => {
    await expect(readUrl("http://127.0.0.1/admin")).rejects.toThrow("red privada");
    await expect(readUrl("http://192.0.2.10/documentacion")).rejects.toThrow("reservada");
    await expect(readUrl("http://[::1]/admin")).rejects.toThrow("red privada");
    await expect(readUrl("http://localhost/admin")).rejects.toThrow("hosts locales");
  });

  it("extrae texto legible con un fetch controlado", async () => {
    const result = await readUrl("https://93.184.216.34/noticia", 2_000, {
      fetchImpl: async () => new Response(
        "<html><head><title>Prueba</title><meta name=\"description\" content=\"Resumen\"></head><body><article><h1>Título</h1><p>Contenido principal.</p></article></body></html>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    });

    expect(result).toContain("Título: Prueba");
    expect(result).toContain("Contenido principal");
  });

  it("valida también el destino de una redirección", async () => {
    await expect(readUrl("https://93.184.216.34/redirect", 2_000, {
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "http://192.168.1.2/secreto" },
      }),
    })).rejects.toThrow("red privada");
  });
});
