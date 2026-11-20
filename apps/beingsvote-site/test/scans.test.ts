// All ballot scans: join, hash, summarize and zip. Synthetic data only. No network, no wallet, no real codes in output.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../public/js/format.js";
import {
  applyComputedHash,
  buildScanList,
  buildScanManifest,
  buildScanManifestCsv,
  manifestContainsBallotCodeKey,
  packScanArchive,
  scanArchiveFiles,
  scanImageFileName,
  scanReadingLabel,
  scanZipName,
  summarizeScans,
  toLegacyImageState,
  verifyAllScans,
} from "../public/js/scans.js";

const H1 = "aa".repeat(32);
const H2 = "bb".repeat(32);
const H3 = "cc".repeat(32);
const H4 = "dd".repeat(32);
const KEY1 = "0x" + "11".repeat(32);
const KEY2 = "0x" + "22".repeat(32);
const KEY3 = "0x" + "33".repeat(32);

const questions = [
  { id: "q1", text: "Colour", maxMarks: 1, choices: [{ id: "c1", text: "Blue" }, { id: "c2", text: "Green" }] },
  { id: "q2", text: "Snack", maxMarks: 1, choices: [{ id: "c1", text: "Apple" }] },
];

const ledgerEntries = [
  { ballotKey: KEY2, results: "O|V:c1", imageSha256: H2 },
  { ballotKey: KEY3, results: "U|B", imageSha256: H3 },
  { ballotKey: KEY1, results: "V:c1|B", imageSha256: H1 },
];
const entryByHash = Object.fromEntries(ledgerEntries.map((e) => [e.imageSha256, e]));

describe("scan readings", () => {
  it("writes a staff-facing line and never says you", () => {
    expect(scanReadingLabel("V:c1|B", questions)).toBe("Q1: Blue · Q2: blank");
    expect(scanReadingLabel("O|V:c1", questions)).toBe("Q1: overvote · Q2: Apple");
    expect(scanReadingLabel("U|B", questions)).toBe("Q1: unclear · Q2: blank");
    expect(scanReadingLabel("V:c1|B", questions)).not.toMatch(/you/i);
  });
});

describe("buildScanList", () => {
  it("sorts by hashed ballot key (not recording order) and labels ballots A1, A2, …", () => {
    const { items, setCompare } = buildScanList({
      ledgerEntries,
      storeImages: [
        { imageHash: H1, contentType: "image/png", size: 10 },
        { imageHash: H2, contentType: "image/jpeg", size: 20 },
        { imageHash: H4, contentType: "image/png", size: 30 },
      ],
      questions,
      expiredOmitted: 1,
    });
    expect(items).toHaveLength(4);
    // ledger was recorded KEY2, KEY3, KEY1; display order is KEY1, KEY2, KEY3
    expect(items.map((i) => i.recordedHash || i.storeHash)).toEqual([H1, H2, H3, H4]);
    expect(items[0]).toMatchObject({ label: "Ballot A1", onLedger: true, ballotKey: KEY1, recordedHash: H1, status: "pending", readingLabel: "Q1: Blue · Q2: blank" });
    expect(items[1]).toMatchObject({ label: "Ballot A2", ballotKey: KEY2, recordedHash: H2, status: "pending" });
    expect(items[2]).toMatchObject({ label: "Ballot A3", ballotKey: KEY3, recordedHash: H3, status: "missing" });
    expect(items[3]).toMatchObject({ label: "Extra A1", onLedger: false, storeHash: H4, status: "not-on-ledger" });
    expect(items.every((i) => !("ballotIndex" in i) && !("ballotCode" in i) && !("ballotCodes" in i))).toBe(true);
    expect(setCompare.missingFromStore).toEqual([H3]);
    expect(setCompare.notOnLedger).toEqual([H4]);
  });
});

describe("applyComputedHash and verifyAll", () => {
  it("marks a match, a mismatch, expired, missing and a failed download", async () => {
    const { items } = buildScanList({
      ledgerEntries,
      storeImages: [
        { imageHash: H1, contentType: "image/png" },
        { imageHash: H2, contentType: "image/png" },
      ],
      questions,
    });
    expect(applyComputedHash(items[0]!, H1).status).toBe("match");
    expect(applyComputedHash(items[1]!, H4).status).toBe("mismatch");
    expect(applyComputedHash(items[0]!, "", { httpStatus: 410 }).status).toBe("expired");
    expect(applyComputedHash(items[0]!, "", { httpStatus: 404 }).status).toBe("missing");
    expect(applyComputedHash(items[0]!, "", { httpStatus: 500 }).status).toBe("failed");

    const bytes1 = new Uint8Array([1, 2, 3]);
    const bytes2 = new Uint8Array([4, 5, 6]);
    const hashes = new Map<string, string>([[H1, H1], [H2, H4]]);
    const store = new Map<string, Uint8Array>([[H1, bytes1], [H2, bytes2]]);
    const result = await verifyAllScans({
      items,
      fetchImage: async (hash) => ({ ok: true, status: 200, bytes: store.get(hash)!, contentType: "image/png" }),
      hashBytes: async (bytes) => (bytes === bytes1 ? H1 : H4),
    });
    expect(result.items[0]!.status).toBe("match");
    expect(result.items[1]!.status).toBe("mismatch");
    expect(result.items[2]!.status).toBe("missing");
    expect(result.blobs.has(H1)).toBe(true);
    expect(result.blobs.has(H2)).toBe(true); // mismatch is still saved so it can be inspected
  });

  it("treats a 410 from the store as expired and still lists the ledger reading", async () => {
    const { items } = buildScanList({
      ledgerEntries: [entryByHash[H1]!],
      storeImages: [{ imageHash: H1, contentType: "image/png" }],
    });
    const result = await verifyAllScans({
      items,
      fetchImage: async () => ({ ok: false, status: 410 }),
      hashBytes: async () => H1,
    });
    expect(result.items[0]!.status).toBe("expired");
    expect(result.items[0]!.readingRaw).toBe("V:c1|B");
    expect(result.blobs.size).toBe(0);
  });
});

describe("summarizeScans", () => {
  it("says N of N match and lists mismatches and missing pictures", () => {
    const { items, setCompare } = buildScanList({
      ledgerEntries,
      storeImages: [
        { imageHash: H1, contentType: "image/png" },
        { imageHash: H2, contentType: "image/png" },
      ],
      questions,
    });
    items[0] = applyComputedHash(items[0]!, H1);
    items[1] = applyComputedHash(items[1]!, H4);
    const summary = summarizeScans(items, { expiredOmitted: 2, setCompare });
    expect(summary.headline).toBe("1 of 2 match");
    expect(summary.match).toBe(1);
    expect(summary.mismatch).toHaveLength(1);
    expect(summary.mismatch[0]!.label).toBe("Ballot A2");
    expect(summary.missing).toHaveLength(1);
    expect(summary.missing[0]!.label).toBe("Ballot A3");
    expect(summary.allMatch).toBe(false);
    expect(summary.expiredOmitted).toBe(2);
  });
});

describe("manifest and zip", () => {
  it("builds JSON and CSV without a ballot code or sequence number, and names files by label and hash", async () => {
    const { items } = buildScanList({
      ledgerEntries: [entryByHash[H1]!, entryByHash[H2]!],
      storeImages: [
        { imageHash: H1, contentType: "image/png" },
        { imageHash: H2, contentType: "image/png" },
      ],
      questions,
    });
    items[0] = applyComputedHash(items[0]!, H1);
    items[1] = applyComputedHash(items[1]!, H2);
    const summary = summarizeScans(items);
    const manifest = buildScanManifest({ electionCode: "BEINGS-2026-TEST42", generatedAt: "2026-11-10T22:00:00.000Z", items, summary });
    expect(manifestContainsBallotCodeKey(manifest)).toBe(false);
    expect(manifest.note).toMatch(/does not include ballot codes/i);
    expect(manifest.ballots[0]).toMatchObject({ label: "Ballot A1", recordedHash: H1, computedHash: H1, status: "match" });
    expect(manifest.ballots[0]!.filename).toBe(`ballot-A1-${H1.slice(0, 12)}.png`);
    expect(JSON.stringify(manifest)).not.toMatch(/ballotCode|ballotIndex/);
    expect(manifest.note).toMatch(/not in print or scan order/i);

    const csv = buildScanManifestCsv(items);
    expect(csv).toMatch(/^label,ballotKey,reading,/);
    expect(csv).toContain("Ballot A1,");
    expect(csv).toContain("V:c1|B");
    expect(csv).not.toMatch(/ballotCode|ballotIndex/);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const blobs = new Map([[H1, { bytes, contentType: "image/png", ext: "png" }], [H2, { bytes, contentType: "image/png", ext: "png" }]]);
    const files = scanArchiveFiles({ electionCode: "BEINGS-2026-TEST42", items, blobs, summary, generatedAt: "2026-11-10T22:00:00.000Z" });
    expect(files.map((f) => f.name).sort()).toEqual([
      `ballot-A1-${H1.slice(0, 12)}.png`,
      `ballot-A2-${H2.slice(0, 12)}.png`,
      "manifest.csv",
      "manifest.json",
    ].sort());
    expect(files.every((f) => !/^[0-9A-HJKMNP-TV-Z]{12}\./.test(f.name))).toBe(true);

    const zip = packScanArchive({ electionCode: "BEINGS-2026-TEST42", items, blobs, summary, generatedAt: "2026-11-10T22:00:00.000Z", date: new Date("2026-11-10T22:00:00Z") });
    expect(zip.byteLength).toBeGreaterThan(100);
    expect(scanZipName("BEINGS-2026-TEST42")).toBe("BEINGS-2026-TEST42-ballot-scans.zip");
  });

  it("escapes commas and quotes in CSV readings", () => {
    const items = [
      {
        label: "Ballot A1",
        onLedger: true,
        ballotKey: KEY1,
        readingRaw: 'V:c1|weird, "mark"',
        readingLabel: 'Q1: odd, "choice"',
        recordedHash: H1,
        computedHash: H1,
        status: "match",
        contentType: "image/png",
        storeHash: H1,
      },
    ];
    const csv = buildScanManifestCsv(items as never);
    expect(csv).toContain('"V:c1|weird, ""mark"""');
    expect(csv).toContain('"Q1: odd, ""choice"""');
  });
});

describe("legacy verifier state", () => {
  it("maps match and mismatch into the existing flag vocabulary", () => {
    const { items, setCompare } = buildScanList({
      ledgerEntries: [entryByHash[H1]!, entryByHash[H2]!],
      storeImages: [
        { imageHash: H1, contentType: "image/png" },
        { imageHash: H2, contentType: "image/png" },
      ],
    });
    items[0] = applyComputedHash(items[0]!, H1);
    items[1] = applyComputedHash(items[1]!, H4);
    const blobs = new Map([[H1, { bytes: new Uint8Array([1]), ext: "png", contentType: "image/png" }]]);
    const legacy = toLegacyImageState(items, setCompare, blobs, 0);
    expect(legacy.items.map((i) => i.status)).toEqual(["verified", "tampered"]);
    expect(legacy.summary.verified).toBe(1);
    expect(legacy.summary.tampered).toEqual([H2]);
    expect(legacy.blobs.get(H1)?.ext).toBe("png");
  });
});

describe("privacy of the pages", () => {
  const read = (name: string) => readFileSync(new URL(`../public/js/${name}`, import.meta.url), "utf8");

  it("does not put the all-scans gallery on the public results or voter pages", () => {
    const results = read("results.js");
    const voter = read("voter.js");
    expect(results).not.toMatch(/scans-ui|scanPanel|All ballot scans/);
    expect(voter).not.toMatch(/scans-ui|scanPanel|All ballot scans/);
    expect(voter).toContain("View original ballot image");
    const fetchAt = voter.indexOf("fetch(");
    const clickAt = voter.indexOf('addEventListener("click"');
    expect(fetchAt).toBeGreaterThan(clickAt);
  });

  it("shows the public-images notice and a single-picture lookup on results and check-my-ballot, without auto-fetching", () => {
    const results = read("results.js");
    const voter = read("voter.js");
    const lookup = read("public-images.js");
    expect(results).toContain("publicImagesNotice");
    expect(results).toContain("publicImageLookup");
    expect(voter).toContain("publicImagesCallout");
    expect(lookup).toContain("public for 30 to 60 days, then are removed");
    expect(lookup).toContain("Fingerprints and readings stay on the chain");
    expect(lookup).toContain("Image expired");
    const fetchAt = lookup.indexOf("fetchPublicBallotImage");
    const clickAt = lookup.indexOf('addEventListener("click"');
    const loadAt = lookup.indexOf("view.load");
    expect(clickAt).toBeGreaterThan(0);
    expect(loadAt).toBeGreaterThan(clickAt);
    expect(fetchAt).toBeGreaterThan(0);
  });

  it("puts the gallery on the admin and verifier pages only", () => {
    expect(read("admin.js")).toContain("scanPanel");
    expect(read("verifier.js")).toContain("scanPanel");
    expect(read("admin.js")).toContain("scans-ui.js");
    expect(read("verifier.js")).toContain("scans-ui.js");
  });
});

// silence unused import if sha256Hex is unused
void sha256Hex;
