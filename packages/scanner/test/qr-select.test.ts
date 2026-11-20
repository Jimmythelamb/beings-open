// The receipt QR is an https link. The scanner must keep the BEINGS1 payload and ignore that link.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../prototype/qr_select.py", import.meta.url));
const ELECTION = "BEINGS-2026-K7M4Q2";
const BALLOT = "4F9Q7M2XHT8B";
const SCAN = `BEINGS1|${ELECTION}|${BALLOT}|L3`;
const RECEIPT = `https://beingsvote.live/check.html#e=${ELECTION}`;

function choose(candidates: string[]): string {
  return execFileSync("python3", [script, ...candidates], { encoding: "utf8" }).trim();
}

describe("receipt QR is not a scan", () => {
  it("ignores a check-page link even when a detector reports it first", () => {
    expect(RECEIPT.includes(BALLOT)).toBe(false);
    expect(RECEIPT.includes("?")).toBe(false);
    expect(choose([RECEIPT, SCAN])).toBe(SCAN);
    expect(choose([SCAN, RECEIPT])).toBe(SCAN);
    expect(choose([RECEIPT])).toBe("");
    expect(choose([`https://beingsvote.live/check.html#e=${ELECTION}&b=${BALLOT}`, SCAN])).toBe(SCAN);
    expect(choose(["BEINGS1|not-an-election|SHORT|L3", RECEIPT])).toBe("");
  });

  it("keeps the receipt finder smaller than a registration mark", () => {
    const safe = execFileSync("python3", [script, "--finder-ok", "0.7"], { encoding: "utf8" });
    expect(safe).toBe("");
    expect(() => execFileSync("python3", [script, "--finder-ok", "0.9"], { encoding: "utf8" })).toThrow();
  });
});
