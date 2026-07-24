import { describe, expect, it } from "bun:test";
import { CompletionQueue } from "../src/orchestration/completion-queue.ts";

describe("CompletionQueue", () => {
  it("integra resultados simultáneos en FIFO por orden de finalización", async () => {
    const queue = new CompletionQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.enqueue("jid-1", async () => {
      order.push("primero-inicio");
      await firstGate;
      order.push("primero-fin");
    });
    const second = queue.enqueue("jid-1", async () => {
      order.push("segundo");
    });

    await Promise.resolve();
    expect(order).toEqual(["primero-inicio"]);
    expect(queue.hasPending("jid-1")).toBe(true);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["primero-inicio", "primero-fin", "segundo"]);
    expect(queue.hasPending("jid-1")).toBe(false);
  });

  it("no bloquea conversaciones distintas entre sí", async () => {
    const queue = new CompletionQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const a = queue.enqueue("A", async () => { await gate; order.push("A"); });
    const b = queue.enqueue("B", async () => { order.push("B"); });
    await b;
    expect(order).toEqual(["B"]);
    release();
    await a;
    expect(order).toEqual(["B", "A"]);
  });
});
