import { afterEach, describe, expect, it } from "bun:test";
import { scheduleSearch } from "../src/search/search-coordinator.ts";

const originalConcurrency = process.env.LUNA_SEARCH_CONCURRENCY;
const originalInterval = process.env.LUNA_SEARCH_MIN_INTERVAL_MS;

afterEach(() => {
  if (originalConcurrency === undefined) delete process.env.LUNA_SEARCH_CONCURRENCY;
  else process.env.LUNA_SEARCH_CONCURRENCY = originalConcurrency;
  if (originalInterval === undefined) delete process.env.LUNA_SEARCH_MIN_INTERVAL_MS;
  else process.env.LUNA_SEARCH_MIN_INTERVAL_MS = originalInterval;
});

describe("coordinador global de búsquedas", () => {
  it("serializa ráfagas de subagentes y respeta el intervalo mínimo", async () => {
    process.env.LUNA_SEARCH_CONCURRENCY = "1";
    process.env.LUNA_SEARCH_MIN_INTERVAL_MS = "20";
    const starts: number[] = [];

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => scheduleSearch(`worker-${index}`, async () => {
        starts.push(Date.now());
        return index;
      })),
    );

    expect(results).toEqual([0, 1, 2, 3]);
    expect(starts).toHaveLength(4);
    for (let index = 1; index < starts.length; index += 1) {
      expect((starts[index] ?? 0) - (starts[index - 1] ?? 0)).toBeGreaterThanOrEqual(15);
    }
  });
});
