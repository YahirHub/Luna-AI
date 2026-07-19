import { describe, expect, test } from "bun:test";
import { createProcessOutputCollector } from "../src/browser/process-output.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("browser process output collector", () => {
  test("permite recuperar salida aunque el pipe nunca llegue a EOF", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"success":true,"data":{"url":"https://www.bing.com"}}'));
        // Intencionalmente NO cerramos el stream: simula un daemon de Windows que
        // heredó el handle del pipe después de que el CLI ya terminó.
      },
    });

    const collector = createProcessOutputCollector(stream);
    await sleep(10);
    expect(collector.text()).toContain('"success":true');
    expect(collector.closed()).toBe(false);

    collector.stop();
    await Promise.race([collector.done, sleep(100)]);
    expect(collector.text()).toContain("https://www.bing.com");
  });

  test("limita la cantidad de salida capturada", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("1234567890"));
        controller.close();
      },
    });

    const collector = createProcessOutputCollector(stream, 5);
    await collector.done;
    expect(collector.text()).toBe("12345");
  });
});
