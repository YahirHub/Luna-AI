import { describe, expect, it } from "bun:test";
import { acquireBrowserProfileLease } from "../src/browser/browser-runtime.ts";

describe("Browser profile lease", () => {
  it("no bloquea agentes futuros si un agente en cola se cancela", async () => {
    const key = `lease-${crypto.randomUUID()}`;
    const releaseFirst = await acquireBrowserProfileLease(key);

    const cancelled = new AbortController();
    const second = acquireBrowserProfileLease(key, cancelled.signal);
    cancelled.abort(new Error("agent-cancelled"));
    await expect(second).rejects.toThrow("agent-cancelled");

    const third = acquireBrowserProfileLease(key);
    releaseFirst();

    const releaseThird = await Promise.race([
      third,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lease-deadlock")), 500)),
    ]);
    expect(typeof releaseThird).toBe("function");
    releaseThird();
  });
});

import { mergeBrowserStorageStates } from "../src/browser/browser-runtime.ts";

it("fusiona cookies y localStorage de agentes concurrentes sin perder otros sitios", () => {
  const merged = mergeBrowserStorageStates({
    cookies: [
      { name: "session", domain: "a.test", path: "/", value: "a1" },
      { name: "shared", domain: "shared.test", path: "/", value: "old" },
    ],
    origins: [
      { origin: "https://a.test", localStorage: [{ name: "token", value: "a" }] },
    ],
  }, {
    cookies: [
      { name: "session", domain: "b.test", path: "/", value: "b1" },
      { name: "shared", domain: "shared.test", path: "/", value: "new" },
    ],
    origins: [
      { origin: "https://b.test", localStorage: [{ name: "token", value: "b" }] },
      { origin: "https://a.test", localStorage: [{ name: "theme", value: "dark" }] },
    ],
  });

  expect(Array.isArray(merged.cookies)).toBe(true);
  expect((merged.cookies as Array<Record<string, unknown>>).find((item) => item.domain === "a.test")?.value).toBe("a1");
  expect((merged.cookies as Array<Record<string, unknown>>).find((item) => item.domain === "b.test")?.value).toBe("b1");
  expect((merged.cookies as Array<Record<string, unknown>>).find((item) => item.domain === "shared.test")?.value).toBe("new");

  const origins = merged.origins as Array<Record<string, unknown>>;
  const aOrigin = origins.find((item) => item.origin === "https://a.test");
  expect(aOrigin).toBeDefined();
  expect(aOrigin?.localStorage).toEqual([
    { name: "token", value: "a" },
    { name: "theme", value: "dark" },
  ]);
  expect(origins.some((item) => item.origin === "https://b.test")).toBe(true);
});
