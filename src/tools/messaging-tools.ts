import { basename, extname, join } from "node:path";
import { statSync } from "node:fs";
import type { ToolDefinition } from "../ai.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { MessagingTransport } from "../transports/types.ts";
import { guessMimeType } from "../workspace/workspace-manager.ts";
import { createFolderArchive } from "../artifacts/zip.ts";

const MEDIA_THRESHOLD_BYTES = 10 * 1024 * 1024;
const SENSITIVE_NAME = /(^|\/)(?:\.env(?:\.|$)|id_rsa(?:\.pub)?$|id_ed25519(?:\.pub)?$|[^/]+\.(?:pem|key|p12|pfx)$|(?:credentials|secrets?|auth)[^/]*\.json$|auth_info_baileys(?:\/|$)|persistent(?:\/|$))/i;

export const MESSAGING_TOOLS: ToolDefinition[] = [{
  type: "function",
  function: {
    name: "message_send",
    description: "Envía texto o una ruta del workdir mediante el transporte activo. El adaptador decide si el archivo se entrega como imagen, audio, video o documento; una carpeta se comprime como ZIP.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        path: { type: "string", description: "Ruta relativa del archivo o carpeta en el workdir." },
        caption: { type: "string" },
        allow_sensitive: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
}];

function zipEntryNames(buffer: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    names.push(buffer.subarray(nameStart, nameStart + nameLength).toString("utf-8"));
    offset = nameStart + nameLength + extraLength + compressedSize;
  }
  return names;
}

function mediaKind(mime: string): "image" | "audio" | "video" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

export async function sendWorkspacePath(
  transport: MessagingTransport,
  jid: string,
  workspace: WorkspaceManager,
  path: string,
  caption = "",
  allowSensitive = false,
): Promise<string> {
  let resolved = workspace.resolvePath(jid, path, { mustExist: true, allowDirectory: true });
  let relativePath = workspace.relativePath(jid, resolved);
  if (statSync(resolved).isDirectory()) {
    const output = join("exports", `${basename(resolved)}-${Date.now()}.zip`).replace(/\\/g, "/");
    relativePath = createFolderArchive(workspace, jid, relativePath, output, false).outputPath;
    resolved = workspace.resolvePath(jid, relativePath, { mustExist: true });
  }
  const content = workspace.readBuffer(jid, relativePath, 500_000_000);
  const mime = guessMimeType(resolved);
  if (extname(resolved).toLowerCase() === ".zip") {
    const sensitive = zipEntryNames(content).filter((name) => SENSITIVE_NAME.test(name));
    if (sensitive.length && !allowSensitive) return `Error: el ZIP contiene posibles credenciales y no se envió.\n${sensitive.slice(0, 20).map((name) => `- ${name}`).join("\n")}`;
  }
  const fileName = basename(resolved);
  const kind = content.length <= MEDIA_THRESHOLD_BYTES ? mediaKind(mime) : "document";
  const outbound = kind === "image" ? { image: content, caption: caption || undefined, mimetype: mime }
    : kind === "audio" ? { audio: content, mimetype: mime, ptt: false }
      : kind === "video" ? { video: content, caption: caption || undefined, mimetype: mime }
        : { document: content, mimetype: mime, fileName, caption: caption || undefined };
  const delivery = await transport.send(jid, outbound);
  workspace.registerArtifact(jid, relativePath, "message_send", { temporary: false });
  return delivery === "queued" ? `⏳ ${fileName} quedó en cola.` : `✅ ${fileName} enviado como ${kind === "document" ? "documento" : kind}.`;
}

export async function executeMessagingTool(
  args: Record<string, unknown>,
  dependencies: { transport: MessagingTransport; jid: string; workspace: WorkspaceManager },
): Promise<string> {
  try {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const path = typeof args.path === "string" ? args.path.trim() : "";
    const caption = typeof args.caption === "string" ? args.caption.trim() : "";
    if (!text && !path) return "Error: debes proporcionar text o path.";
    const textDelivery = text ? await dependencies.transport.send(dependencies.jid, { text }) : undefined;
    if (!path) return textDelivery === "queued" ? "⏳ Mensaje en cola." : "✅ Mensaje enviado.";
    return sendWorkspacePath(dependencies.transport, dependencies.jid, dependencies.workspace, path, caption, args.allow_sensitive === true);
  } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
}
