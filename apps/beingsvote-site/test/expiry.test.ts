import { describe, expect, it } from "vitest";
import { computeDeleteAfter, isExpired, parseDeleteAfter } from "../src/expiry.js";
import { runCleanup } from "../src/cleanup.js";
import { MockStore, NOW } from "./helpers.js";

describe("deleteAfter", () => {
  it("is now + N days as an ISO date", () => {
    expect(computeDeleteAfter(NOW, "14", 365)).toBe("2026-11-15T12:00:00.000Z");
    expect(computeDeleteAfter(NOW, 1, 365)).toBe("2026-11-02T12:00:00.000Z");
    expect(computeDeleteAfter(NOW, "365", 365)).toBe("2027-11-01T12:00:00.000Z");
  });
  it("rejects 0, negatives, fractions, text, missing and anything over the cap", () => {
    for (const v of ["0", "-1", "1.5", "abc", "", null, undefined, "366", 0, 400, "1e3", " "]) {
      expect(computeDeleteAfter(NOW, v, 365)).toBeNull();
    }
  });
  it("honours an optional minimum, used for public pictures (30 to 60 days)", () => {
    expect(computeDeleteAfter(NOW, "30", 60, 30)).toBe("2026-12-01T12:00:00.000Z");
    expect(computeDeleteAfter(NOW, "60", 60, 30)).toBe("2026-12-31T12:00:00.000Z");
    expect(computeDeleteAfter(NOW, "29", 60, 30)).toBeNull();
    expect(computeDeleteAfter(NOW, "61", 60, 30)).toBeNull();
    expect(computeDeleteAfter(NOW, "14", 365, 1)).toBe("2026-11-15T12:00:00.000Z");
  });
});

describe("isExpired", () => {
  it("is false before, true at and after deleteAfter", () => {
    const d = "2026-11-15T12:00:00.000Z";
    expect(isExpired(d, new Date("2026-11-15T11:59:59.999Z"))).toBe(false);
    expect(isExpired(d, new Date("2026-11-15T12:00:00.000Z"))).toBe(true);
    expect(isExpired(d, new Date("2027-01-01T00:00:00.000Z"))).toBe(true);
  });
  it("treats missing or garbage dates as not expired (cleanup reports them instead)", () => {
    expect(isExpired(undefined, NOW)).toBe(false);
    expect(isExpired("not a date", NOW)).toBe(false);
    expect(parseDeleteAfter(5)).toBeNull();
  });
});

describe("scheduled cleanup", () => {
  const meta = (deleteAfter: unknown) => ({ electionCode: "BEINGS-2026-4CRWX2", ballotCodeHash: "0x" + "a".repeat(64), contentType: "image/png", size: 1, uploadedAt: "2026-10-01T00:00:00.000Z", deleteAfter }) as never;

  it("deletes only expired blobs and reports the odd ones without deleting them", async () => {
    const s = new MockStore();
    await s.set("E/old", new Uint8Array([1]), { metadata: meta("2026-10-31T00:00:00.000Z") });
    await s.set("E/due", new Uint8Array([1]), { metadata: meta(NOW.toISOString()) });
    await s.set("E/new", new Uint8Array([1]), { metadata: meta("2026-11-30T00:00:00.000Z") });
    await s.set("E/odd", new Uint8Array([1]), { metadata: meta("garbage") });
    const r = await runCleanup(s, NOW);
    expect(r).toEqual({ scanned: 4, deleted: 2, kept: 1, needsAttention: ["E/odd"] });
    expect([...s.map.keys()].sort()).toEqual(["E/new", "E/odd"]);
  });

  it("is a no-op on an empty store and safe to run twice", async () => {
    const s = new MockStore();
    expect(await runCleanup(s, NOW)).toEqual({ scanned: 0, deleted: 0, kept: 0, needsAttention: [] });
    await s.set("E/old", new Uint8Array([1]), { metadata: meta("2020-01-01T00:00:00.000Z") });
    await runCleanup(s, NOW);
    expect((await runCleanup(s, NOW)).deleted).toBe(0);
  });
});
