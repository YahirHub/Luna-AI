/**
 * Serializa integraciones asíncronas por conversación en el mismo orden en que
 * el runtime informa que terminaron. No bloquea la ejecución que produjo el
 * resultado: cada productor solo encola su fase de integración/entrega.
 */
export class CompletionQueue {
  private readonly chains = new Map<string, Promise<void>>();

  enqueue(jid: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(jid);
    const run = async (): Promise<void> => {
      await work();
    };

    // La primera integración de un JID empieza inmediatamente. Antes se creaba
    // una cadena Promise.resolve().catch().then(work), que añadía dos saltos de
    // microtask innecesarios y hacía que una finalización recién encolada siguiera
    // apareciendo como pendiente sin haber iniciado todavía. Las siguientes sí
    // esperan estrictamente a la anterior, incluso si esta falló.
    const queued = previous
      ? previous.catch(() => undefined).then(run)
      : run();
    const current = queued.finally(() => {
      if (this.chains.get(jid) === current) this.chains.delete(jid);
    });
    this.chains.set(jid, current);
    return current;
  }

  hasPending(jid: string): boolean {
    return this.chains.has(jid);
  }
}
