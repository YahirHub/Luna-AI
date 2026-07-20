import { basename, extname, join } from "node:path";
import { statSync } from "node:fs";
import type { ToolDefinition } from "../ai.ts";
import type { MessagingTransport } from "../transports/types.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { guessMimeType } from "../workspace/workspace-manager.ts";
import { createFolderArchive } from "../artifacts/zip.ts";
import { sendFile, sendText } from "../messaging.ts";

const SENSITIVE_NAME = /(^|\/)(?:\.env(?:\.|$)|id_rsa(?:\.pub)?$|id_ed25519(?:\.pub)?$|[^/]+\.(?:pem|key|p12|pfx)$|(?:credentials|secrets?|auth)[^/]*\.json$|auth_info_[^/]+(?:\/|$)|persistent(?:\/|$))/i;

export const MESSAGING_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "message_send",
      description: "Envía texto o un archivo del workdir al mismo usuario por el transporte de chat activo. Al recibir una ruta, Luna detecta automáticamente el archivo; si es carpeta la comprime como ZIP. El adaptador decide si enviarlo como medio nativo o como documento.",
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

export async function sendWorkspacePath(
  transport: MessagingTransport,
  conversationId: string,
  workspace: WorkspaceManager,
  path: string,
  caption = "",
  allowSensitive = false,
): Promise<string> {
  let resolved = workspace.resolvePath(conversationId, path, { mustExist: true, allowDirectory: true });
  let relativePath = workspace.relativePath(conversationId, resolved);
  const info = statSync(resolved);
  if (info.isDirectory()) {
    const name = `${basename(resolved)}-${Date.now()}.zip`;
    const output = join("exports", name).replace(/\\/g, "/");
    const archived = createFolderArchive(workspace, conversationId, relativePath, output, false);
    relativePath = archived.outputPath;
    resolved = workspace.resolvePath(conversationId, relativePath, { mustExist: true });
  }

  const content = workspace.readBuffer(conversationId, relativePath, 500_000_000);
  const mimeType = guessMimeType(resolved);
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
  const delivery = await sendFile(
    transport,
    conversationId,
    {
      bytes: content,
      fileName,
      mimeType,
      caption: caption || undefined,
      mode: "auto",
    },
  );

  workspace.registerArtifact(conversationId, relativePath, "message_send", { temporary: false });
  return delivery === "queued"
    ? `⏳ ${fileName} quedó en cola y se enviará automáticamente cuando ${transport.label} reconecte.`
    : `✅ ${fileName} enviado por ${transport.label}.`;
}

export async function executeMessagingTool(
  args: Record<string, unknown>,
  dependencies: {
    transport: MessagingTransport;
    conversationId: string;
    workspace: WorkspaceManager;
  },
): Promise<string> {
  try {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const path = typeof args.path === "string" ? args.path.trim() : "";
    const caption = typeof args.caption === "string" ? args.caption.trim() : "";
    if (!text && !path) return "Error: debes proporcionar text o path.";

    let textDelivery: "sent" | "queued" | undefined;
    if (text) textDelivery = await sendText(dependencies.transport, dependencies.conversationId, text);
    if (!path) {
      return textDelivery === "queued"
        ? `⏳ Mensaje en cola; se enviará automáticamente cuando ${dependencies.transport.label} reconecte.`
        : `✅ Mensaje enviado por ${dependencies.transport.label}.`;
    }

    return await sendWorkspacePath(
      dependencies.transport,
      dependencies.conversationId,
      dependencies.workspace,
      path,
      caption,
      args.allow_sensitive === true,
    );
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
