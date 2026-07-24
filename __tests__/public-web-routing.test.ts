import { describe, expect, it } from "bun:test";
import {
  isDirectPublicContentIntent,
  requiresInteractiveBrowser,
  shouldPreferDirectPublicWeb,
  userExplicitlyRequestsWebAgent,
} from "../src/public-web/routing.ts";
import { moduleRegistry } from "../src/modules/catalog.ts";
import { PUBLIC_WEB_TOOLS } from "../src/public-web/public-web-tools.ts";
import { MESSAGING_TOOLS } from "../src/tools/messaging-tools.ts";

const user = { authenticated: true, isAdmin: false, jid: "user@test" };

describe("enrutamiento web pública directa", () => {
  it("prefiere HTTP/API directa para Archive.org y Wikimedia Commons", () => {
    const request = "Entra a archive.org, busca un video gracioso y mándamelo";
    expect(isDirectPublicContentIntent(request)).toBe(true);
    expect(requiresInteractiveBrowser(request)).toBe(false);
    expect(shouldPreferDirectPublicWeb(request)).toBe(true);

    const tools = moduleRegistry.filterToolsForTurn([...PUBLIC_WEB_TOOLS, ...MESSAGING_TOOLS], request, user).tools.map((tool) => tool.function.name);
    expect(tools).toContain("public_media_search");
    expect(tools).toContain("public_media_download");
    expect(tools).toContain("message_send");
  });

  it("no sustituye el navegador cuando hay login o el usuario pide explícitamente un agente", () => {
    expect(requiresInteractiveBrowser("Entra a archive.org e inicia sesión con mi cuenta")).toBe(true);
    expect(shouldPreferDirectPublicWeb("Entra a archive.org e inicia sesión con mi cuenta")).toBe(false);
    expect(userExplicitlyRequestsWebAgent("Lanza un browser-agent para buscar un video en archive.org")).toBe(true);
    expect(shouldPreferDirectPublicWeb("Lanza un browser-agent para buscar un video en archive.org")).toBe(false);
  });
});
