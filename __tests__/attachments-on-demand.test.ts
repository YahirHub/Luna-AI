import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachmentManager } from "../src/attachments/attachment-manager.ts";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";
import type { TransportIncomingMessage } from "../src/transports/types.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() {
  const root = join(tmpdir(), `luna-attachments-${crypto.randomUUID()}`);
  roots.push(root);
  const workspace = new WorkspaceManager(join(root, "contexts"));
  const manager = new AttachmentManager(workspace);
  return { manager, workspace };
}

describe("adjuntos bajo demanda", () => {
  it("registrar metadata no descarga el archivo", () => {
    const { manager } = setup();
    let downloads = 0;
    const message: TransportIncomingMessage = {
      id: "m1", conversationId: "user", fromSelf: false, text: "mira esto", mediaKind: "image",
      caption: "mira esto", raw: {}, mediaMimeType: "image/png", mediaFileName: "captura.png", mediaSizeBytes: 4,
      downloadMedia: async () => { downloads += 1; return new Uint8Array([1, 2, 3, 4]); },
    };
    const attachment = manager.register("user", message);
    expect(downloads).toBe(0);
    expect(manager.buildIncomingContext(attachment, message.text)).toContain("NO DESCARGADO AUTOMÁTICAMENTE");
    expect(downloads).toBe(0);
  });

  it("descarga solo cuando una tool lo solicita y lo guarda en inbox", async () => {
    const { manager, workspace } = setup();
    let downloads = 0;
    const message: TransportIncomingMessage = {
      id: "m2", conversationId: "user", fromSelf: false, text: "", mediaKind: "document",
      caption: "", raw: {}, mediaMimeType: "text/plain", mediaFileName: "nota.txt", mediaSizeBytes: 5,
      downloadMedia: async () => { downloads += 1; return new TextEncoder().encode("hola\n"); },
    };
    const attachment = manager.register("user", message);
    const stored = await manager.downloadToWorkspace("user", attachment.id);
    expect(downloads).toBe(1);
    const absolute = workspace.resolvePath("user", stored.path, { mustExist: true });
    expect(existsSync(absolute)).toBe(true);
    expect(readFileSync(absolute, "utf8")).toBe("hola\n");
  });
});
