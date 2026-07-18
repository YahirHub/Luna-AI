import type { WorkspaceManager, WorkspaceArtifact } from "./workspace-manager.ts";

const CONTENT_REQUEST = /(?:\b(?:dame|muestra|ensena|enséñame|lee|leeme|léeme|quiero|contenido|texto|transcribe)\b[\s\S]{0,80}\b(?:pdf|archivo|documento|informe|artefacto)\b|\b(?:pdf|archivo|documento|informe|artefacto)\b[\s\S]{0,80}\b(?:contenido|texto|completo|leer|lee|dame|muestra)\b)/i;

export function isArtifactContentRequest(text: string): boolean {
  return CONTENT_REQUEST.test(text);
}

function selectArtifact(artifacts: WorkspaceArtifact[], request: string): WorkspaceArtifact | undefined {
  if (artifacts.length === 0) return undefined;
  const lower = request.toLowerCase();
  const explicit = artifacts.find((item) => lower.includes(item.filename.toLowerCase()) || lower.includes(item.path.toLowerCase()));
  if (explicit) return explicit;
  const wantsPdf = /\bpdf\b/i.test(request);
  const candidates = wantsPdf ? artifacts.filter((item) => item.mimeType === "application/pdf") : artifacts;
  return [...candidates].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1);
}

export function buildArtifactContentReply(
  manager: WorkspaceManager,
  jid: string,
  request: string,
  maxChars = 100_000,
): string | null {
  if (!isArtifactContentRequest(request)) return null;
  const artifact = selectArtifact(manager.listArtifacts(jid), request);
  if (!artifact) return null;
  try {
    const result = manager.readArtifactText(jid, artifact.id, maxChars);
    return [
      `📄 Contenido exacto de ${result.artifact.filename}`,
      `Fuente utilizada para generar el artefacto: ${result.sourcePath}`,
      "",
      result.content,
    ].join("\n");
  } catch {
    return null;
  }
}

export function splitArtifactReply(text: string, maxChars = 12_000): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
