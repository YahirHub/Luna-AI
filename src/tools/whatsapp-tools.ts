import { basename, extname, join } from "node:path";
import { statSync } from "node:fs";
import type { WASocket } from "@whiskeysockets/baileys";
import type { ToolDefinition } from "../ai.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { guessMimeType } from "../workspace/workspace-manager.ts";
import { createFolderArchive } from "../artifacts/zip.ts";

const MEDIA_THRESHOLD_BYTES = 10 * 1024 * 1024;
const SENSITIVE_NAME = /(^|\/)(?:\.env(?:\.|$)|id_rsa(?:\.pub)?$|id_ed25519(?:\.pub)?$|[^/]+\.(?:pem|key|p12|pfx)$|(?:credentials|secrets?|auth)[^/]*\.json$|auth_info_baileys(?:\/|$)|persistent(?:\/|$))/i;

export const WHATSAPP_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "whatsapp_send",
      description: "Envía texto o un archivo del workdir al mismo usuario que pidió la acción. Imágenes, audio y video menores o iguales a 10 MB se envían como medio; archivos mayores se envían como documento. Si path es una carpeta, la comprime como ZIP.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          path: { type: "string", description: "Ruta relativa del archivo o carpeta en el workdir." },
          caption: { type: "string" },
          allow_sensitive: { type: "boolean", description: "Solo true si el usuario confirmó enviar un ZIP que contiene posibles credenciales." },
        },
        additionalProperties: false,
      },
    },
  },
];

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
  sock: WASocket,
  jid: string,
  workspace: WorkspaceManager,
  path: string,
  caption = "",
  allowSensitive = false,
): Promise<string> {
  let resolved = workspace.resolvePath(jid, path, { mustExist: true, allowDirectory: true });
  let relativePath = workspace.relativePath(jid, resolved);
  const info = statSync(resolved);
  if (info.isDirectory()) {
    const name = `${basename(resolved)}-${Date.now()}.zip`;
    const output = join("exports", name).replace(/\\/g, "/");
    const archived = createFolderArchive(workspace, jid, relativePath, output, false);
    relativePath = archived.outputPath;
    resolved = workspace.resolvePath(jid, relativePath, { mustExist: true });
  }

  const content = workspace.readBuffer(jid, relativePath, 500_000_000);
  const mime = guessMimeType(resolved);
  if (extname(resolved).toLowerCase() === ".zip") {
    const sensitive = zipEntryNames(content).filter((name) => SENSITIVE_NAME.test(name));
    if (sensitive.length && !allowSensitive) {
      return [
        "Error: el ZIP contiene posibles credenciales y no se envió.",
        ...sensitive.slice(0, 20).map((name) => `- ${name}`),
        "Pide confirmación explícita al usuario y vuelve a llamar con allow_sensitive=true.",
      ].join("\n");
    }
  }

  const fileName = basename(resolved);
  const kind = content.length <= MEDIA_THRESHOLD_BYTES ? mediaKind(mime) : "document";
  if (kind === "image") await sock.sendMessage(jid, { image: content, caption: caption || undefined, mimetype: mime });
  else if (kind === "audio") await sock.sendMessage(jid, { audio: content, mimetype: mime, ptt: false });
  else if (kind === "video") await sock.sendMessage(jid, { video: content, caption: caption || undefined, mimetype: mime });
  else await sock.sendMessage(jid, { document: content, mimetype: mime, fileName, caption: caption || undefined });

  workspace.registerArtifact(jid, relativePath, "whatsapp_send", { temporary: false });
  return `✅ ${fileName} enviado por WhatsApp como ${kind === "document" ? "documento" : kind}.`;
}

export async function executeWhatsAppTool(
  args: Record<string, unknown>,
  dependencies: { sock: WASocket; jid: string; workspace: WorkspaceManager },
): Promise<string> {
  try {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const path = typeof args.path === "string" ? args.path.trim() : "";
    const caption = typeof args.caption === "string" ? args.caption.trim() : "";
    if (!text && !path) return "Error: debes proporcionar text o path.";
    if (text) await dependencies.sock.sendMessage(dependencies.jid, { text });
    if (!path) return "✅ Mensaje enviado por WhatsApp.";
    return await sendWorkspacePath(dependencies.sock, dependencies.jid, dependencies.workspace, path, caption, args.allow_sensitive === true);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
