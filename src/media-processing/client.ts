import { basename } from "node:path";
import type { MediaWorkerRequest, MediaWorkerResponse } from "./protocol.ts";
import { loadWhisperConfig } from "../whisper-config.ts";

export type MediaProcessingResult = { text: string; durationSeconds?: number };

type PendingJob = {
  resolve: (result: MediaProcessingResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type MediaSubprocess = ReturnType<typeof Bun.spawn>;

const MAX_PENDING_JOBS = 3;

function mediaChildCommand(): string[] {
  const executableName = basename(process.execPath).toLowerCase();
  const runningFromBunCli = executableName === "bun" || executableName === "bun.exe";

  // En desarrollo process.execPath es Bun y debemos volver a pasar el entrypoint.
  // En un standalone process.execPath ya es luna-ai(.exe), por lo que el mismo
  // binario se invoca con el modo interno de multimedia.
  return runningFromBunCli
    ? [process.execPath, Bun.main, "--media-worker"]
    : [process.execPath, "--media-worker"];
}

function normalizeWorkerError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replace(/^error:\s*/i, "").trim() || "El procesador multimedia terminó inesperadamente.");
}

export class MediaProcessorClient {
  private child: MediaSubprocess | null = null;
  private pending = new Map<string, PendingJob>();

  private rejectAll(error: Error): void {
    for (const [id, job] of this.pending) {
      clearTimeout(job.timeout);
      job.reject(error);
      this.pending.delete(id);
    }
  }

  private handleResponse(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const response = message as MediaWorkerResponse;
    if (typeof response.id !== "string" || typeof response.type !== "string") return;

    const job = this.pending.get(response.id);
    if (!job) return;

    clearTimeout(job.timeout);
    this.pending.delete(response.id);

    if (response.type === "error") {
      job.reject(new Error(response.error));
      return;
    }

    job.resolve({ text: response.text, durationSeconds: response.durationSeconds });
  }

  private getChild(): MediaSubprocess {
    if (this.child) return this.child;

    const child = Bun.spawn(mediaChildCommand(), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      ipc: (message) => this.handleResponse(message),
      onExit: (_subprocess, exitCode, signalCode, error) => {
        if (this.child !== child) return;
        this.child = null;
        const detail = error
          ? normalizeWorkerError(error)
          : new Error(
              `El procesador multimedia terminó${exitCode !== null ? ` con código ${exitCode}` : ""}${signalCode ? ` (${signalCode})` : ""}.`,
            );
        this.rejectAll(detail);
      },
    });

    this.child = child;
    return child;
  }

  process(
    type: MediaWorkerRequest["type"],
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<MediaProcessingResult> {
    if (this.pending.size >= MAX_PENDING_JOBS) {
      return Promise.reject(new Error("El procesador multimedia está ocupado. Intenta nuevamente en unos minutos."));
    }

    const id = crypto.randomUUID();
    const request: MediaWorkerRequest = {
      id,
      type,
      mimeType,
      // Copia defensiva: el mensaje IPC se serializa, pero no debe depender del
      // buffer que Baileys pueda liberar o reutilizar después de este método.
      bytes: Uint8Array.from(bytes),
    };

    return new Promise((resolve, reject) => {
      const timeoutSeconds = type === "transcribe-audio"
        ? loadWhisperConfig().timeoutSeconds + 30
        : 15 * 60;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`El procesamiento multimedia excedió ${timeoutSeconds} segundos y fue cancelado.`));
        this.restartChild();
      }, timeoutSeconds * 1000);

      this.pending.set(id, { resolve, reject, timeout });

      try {
        this.getChild().send(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        this.restartChild();
        reject(normalizeWorkerError(error));
      }
    });
  }

  private restartChild(): void {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        // El proceso ya pudo haber terminado.
      }
    }
  }

  terminate(): void {
    this.restartChild();
    this.rejectAll(new Error("Procesamiento multimedia detenido."));
  }
}
