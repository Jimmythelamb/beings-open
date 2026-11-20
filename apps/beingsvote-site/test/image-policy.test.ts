import { describe, expect, it } from "vitest";
import {
  isPublicBallotImages,
  isPublicImagesHeader,
  isPublicImagesMetadata,
  loadElectionImagePolicy,
  policyFromElectionFile,
  retentionRange,
  PUBLIC_IMAGE_RETENTION_MAX_DAYS,
  PUBLIC_IMAGE_RETENTION_MIN_DAYS,
} from "../src/imagePolicy.js";

describe("election image policy", () => {
  it("treats a missing or false flag as off, and only an explicit true as on", () => {
    expect(isPublicBallotImages(undefined)).toBe(false);
    expect(isPublicBallotImages({})).toBe(false);
    expect(isPublicBallotImages({ publicBallotImages: false })).toBe(false);
    expect(isPublicBallotImages({ publicBallotImages: "true" })).toBe(false);
    expect(isPublicBallotImages({ publicBallotImages: true })).toBe(true);
  });

  it("reads retention days from the election file", () => {
    expect(policyFromElectionFile({ publicBallotImages: true, imageRetention: { days: 45 } })).toEqual({
      publicBallotImages: true,
      retentionDays: 45,
    });
    expect(policyFromElectionFile({ file: "ignored" }).publicBallotImages).toBe(false);
  });

  it("limits public pictures to 30–60 days and private ones to 1–365", () => {
    expect(retentionRange(true)).toEqual({ min: PUBLIC_IMAGE_RETENTION_MIN_DAYS, max: PUBLIC_IMAGE_RETENTION_MAX_DAYS });
    expect(retentionRange(false)).toEqual({ min: 1, max: 365 });
  });

  it("accepts the usual true/1/yes header and stored metadata forms", () => {
    expect(isPublicImagesHeader("true")).toBe(true);
    expect(isPublicImagesHeader("1")).toBe(true);
    expect(isPublicImagesHeader("yes")).toBe(true);
    expect(isPublicImagesHeader("no")).toBe(false);
    expect(isPublicImagesHeader(null)).toBe(false);
    expect(isPublicImagesMetadata(1)).toBe(true);
    expect(isPublicImagesMetadata("1")).toBe(true);
    expect(isPublicImagesMetadata("true")).toBe(true);
    expect(isPublicImagesMetadata(0)).toBe(false);
  });

  it("loads a public copy from the election-files base and unwraps { file }", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ publicCopy: true, file: { publicBallotImages: true, imageRetention: { days: 30 } } }) };
    };
    const policy = await loadElectionImagePolicy("BEINGS-2026-TEST42", { base: "https://beingsvote.live/data/elections", fetchImpl });
    expect(calls).toEqual(["https://beingsvote.live/data/elections/BEINGS-2026-TEST42.json"]);
    expect(policy).toEqual({ publicBallotImages: true, retentionDays: 30 });
  });

  it("fails closed on a bad code, a missing base, or an HTTP error", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
    expect(await loadElectionImagePolicy("not-a-code", { base: "https://example.test/data", fetchImpl })).toBeNull();
    expect(await loadElectionImagePolicy("BEINGS-2026-TEST42", { fetchImpl })).toBeNull();
    expect(await loadElectionImagePolicy("BEINGS-2026-TEST42", { base: "https://example.test/data", fetchImpl })).toBeNull();
  });
});
