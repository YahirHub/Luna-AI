export interface ProcessOutputCollector {
  readonly done: Promise<void>;
  text(): string;
  stop(): void;
  closed(): boolean;
}

/**
 * Consume un stream de un proceso hijo sin depender de que alcance EOF.
 *
 * agent-browser usa un daemon persistente. En Windows, el daemon puede heredar
 * los handles de stdout/stderr del CLI que lo inició. En ese caso el proceso CLI
 * termina, pero el pipe permanece abierto y esperar `Response(stream).text()`
 * bloquea para siempre. Este colector lee los bytes mientras llegan y permite
 * cancelar la lectura explícitamente cuando el proceso CLI ya terminó.
 */
export function createProcessOutputCollector(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes = 2 * 1024 * 1024,
): ProcessOutputCollector {
  if (!stream) {
    return {
      done: Promise.resolve(),
      text: () => "",
      stop: () => undefined,
      closed: () => true,
    };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let isClosed = false;
  let stopping = false;

  const done = (async () => {
    try {
      while (!stopping) {
        const result = await reader.read();
        if (result.done) break;
        if (!result.value?.byteLength) continue;

        const remaining = maxBytes - capturedBytes;
        if (remaining <= 0) continue;
        const chunk = result.value.byteLength <= remaining
          ? result.value
          : result.value.slice(0, remaining);
        chunks.push(chunk);
        capturedBytes += chunk.byteLength;
      }
    } catch {
      // Cancelar el reader durante la limpieza puede rechazar una lectura pendiente.
    } finally {
      isClosed = true;
      try { reader.releaseLock(); } catch { /* best effort */ }
    }
  })();

  return {
    done,
    text: () => {
      if (chunks.length === 0) return "";
      const output = new Uint8Array(capturedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(output);
    },
    stop: () => {
      if (stopping || isClosed) return;
      stopping = true;
      try { void reader.cancel(); } catch { /* best effort */ }
    },
    closed: () => isClosed,
  };
}
