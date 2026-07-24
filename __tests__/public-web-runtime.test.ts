import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";
import {
  downloadPublicMedia,
  extractPublicUrls,
  searchInternetArchive,
  searchPublicMedia,
  searchWikimediaCommons,
} from "../src/public-web/public-web-runtime.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const validateUrl = async (raw: string) => new URL(raw);

describe("web pública directa", () => {
  it("extrae URLs de medios sin devolver todo el HTML", () => {
    const html = `
      <html><head><meta property="og:video" content="/media/funny.mp4"></head>
      <body>
        <a href="/page">Página</a>
        <video src="https://cdn.example.com/a.webm" data-download="/media/direct.mp4"></video>
        <img srcset="/small.jpg 320w, /large.jpg 1280w">
        <script>window.media = {"contentUrl":"\\/media\\/escaped.webm"};</script>
      </body></html>`;
    const matches = extractPublicUrls(html, "https://example.com/item", "media", "", 10);
    expect(matches.map((entry) => entry.url)).toContain("https://example.com/media/funny.mp4");
    expect(matches.map((entry) => entry.url)).toContain("https://cdn.example.com/a.webm");
    expect(matches.map((entry) => entry.url)).toContain("https://example.com/media/direct.mp4");
    expect(matches.map((entry) => entry.url)).toContain("https://example.com/large.jpg");
    expect(matches.map((entry) => entry.url)).toContain("https://example.com/media/escaped.webm");
    expect(matches.map((entry) => entry.url)).not.toContain("https://example.com/page");
  });

  it("busca Internet Archive y resuelve un archivo directo desde metadata", async () => {
    const requested: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("advancedsearch.php")) {
        return new Response(JSON.stringify({ response: { docs: [{ identifier: "funny-item", title: "Funny item" }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/metadata/funny-item")) {
        return new Response(JSON.stringify({
          metadata: { title: "Funny item", creator: "Tester", runtime: "0:42" },
          files: [
            { name: "__ia_thumb.jpg", source: "original", size: "1000" },
            { name: "funny-item.webm", source: "derivative", size: "9000000", mime: "video/webm" },
            { name: "funny-item.mp4", source: "original", size: "7000000", mime: "video/mp4", length: "42" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };

    const results = await searchInternetArchive("funny video", "video", 3, { fetchImpl, validateUrl });
    expect(results).toHaveLength(1);
    expect(results[0]?.direct_url).toBe("https://archive.org/download/funny-item/funny-item.mp4");
    expect(results[0]?.duration).toBe("0:42");
    expect(requested.some((url) => url.includes("mediatype%3Amovies"))).toBe(true);
  });

  it("busca Wikimedia Commons con URL directa y metadatos de licencia", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      query: {
        pages: [{
          title: "File:Funny cat.jpg",
          imageinfo: [{
            url: "https://upload.wikimedia.org/funny-cat.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Funny_cat.jpg",
            mime: "image/jpeg",
            size: 12345,
            width: 640,
            height: 480,
            extmetadata: {
              Artist: { value: "Jane Doe" },
              LicenseShortName: { value: "CC BY-SA 4.0" },
              LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
              ImageDescription: { value: "<b>Funny cat</b> sitting." },
            },
          }],
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const results = await searchWikimediaCommons("funny cat", "image", 3, { fetchImpl, validateUrl });
    expect(results).toHaveLength(1);
    expect(results[0]?.direct_url).toBe("https://upload.wikimedia.org/funny-cat.jpg");
    expect(results[0]?.license).toBe("CC BY-SA 4.0");
    expect(results[0]?.creator).toBe("Jane Doe");
    expect(results[0]?.description).toContain("Funny cat");
  });

  it("hace fallback entre Archive y Commons cuando la fuente primaria falla", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("archive.org/advancedsearch.php")) throw new Error("archive temporalmente no disponible");
      if (url.includes("commons.wikimedia.org/w/api.php")) {
        return new Response(JSON.stringify({
          query: { pages: [{ title: "File:Fallback.webm", imageinfo: [{
            url: "https://upload.wikimedia.org/fallback.webm",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Fallback.webm",
            mime: "video/webm",
            size: 1000,
          }] }] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };

    const results = await searchPublicMedia("funny video", "auto", "video", 2, { fetchImpl, validateUrl });
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("wikimedia-commons");
    expect(results[0]?.direct_url).toBe("https://upload.wikimedia.org/fallback.webm");
  });

  it("descarga una URL directa al workdir sin navegador", async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-public-download-"));
    roots.push(root);
    const workspace = new WorkspaceManager(root);
    const body = new TextEncoder().encode("fake-mp4-content");
    const fetchImpl = async () => new Response(body, {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": String(body.byteLength) },
    });

    const result = await downloadPublicMedia(
      "https://archive.org/download/item/video.mp4",
      workspace,
      "jid@test",
      "video.mp4",
      10 * 1024 * 1024,
      { fetchImpl, validateUrl },
    );
    expect(result.path).toBe("downloads/public/video.mp4");
    expect(workspace.readBuffer("jid@test", "downloads/public/video.mp4").toString()).toBe("fake-mp4-content");
    expect(workspace.listArtifacts("jid@test").some((artifact) => artifact.path === "downloads/public/video.mp4")).toBe(true);
  });
});
