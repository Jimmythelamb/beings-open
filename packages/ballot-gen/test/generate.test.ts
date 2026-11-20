import { describe, expect, it } from "vitest";
import { BALLOT_CODE_RE, BeingsError, ballotKey, ballotListRoot, electionFileProblems, electionKey, keccakHex, sha256Json, validate } from "@beings/core";
import { generateElection, shuffled, validateLayout } from "../src/index.js";
import { realRng, sampleElection, seededRng } from "./helpers.js";

describe("generateElection", () => {
  it("makes unique, well-formed codes, the right count, and a valid election file", async () => {
    const g = await generateElection(sampleElection(), { count: 40 });
    const codes = g.electionFile.ballotCodes;
    expect(codes).toHaveLength(40);
    expect(new Set(codes).size).toBe(40);
    for (const c of codes) expect(c).toMatch(BALLOT_CODE_RE);
    expect([...codes]).toEqual([...codes].sort());
    expect(g.electionFile.electionCode).toMatch(/^BEINGS-2026-[0-9A-Z]{6}$/);
    expect(g.ballotList.count).toBe(40);
  });

  it("ballotListRoot equals core's Merkle root and the keys are keccak256 of the codes", async () => {
    const g = await generateElection(sampleElection(), { count: 33 });
    const codes = g.electionFile.ballotCodes;
    expect(g.ballotList.ballotListRoot).toBe(ballotListRoot(codes));
    expect(g.createElection.ballotListRoot).toBe(ballotListRoot(codes));
    expect(g.ballotList.ballots.map((b) => b.ballotCode)).toEqual([...codes]);
    for (const b of g.ballotList.ballots) {
      expect(b.ballotKey).toBe(ballotKey(b.ballotCode));
      expect(b.ballotKey).toBe(keccakHex(b.ballotCode));
    }
    expect(g.ballotList.electionKey).toBe(electionKey(g.electionFile.electionCode));
    expect(g.electionFileSha256).toBe(sha256Json(g.electionFile));
    expect(g.createElection.fileSha256).toBe("0x" + g.electionFileSha256);
    expect(g.createElection.ballotCount).toBe(33);
  });

  it("is reproducible with a fixed random source, and different with the real one", async () => {
    const a = await generateElection(sampleElection(), { count: 10, rng: seededRng(7) });
    const b = await generateElection(sampleElection(), { count: 10, rng: seededRng(7) });
    expect(Buffer.from(a.pdf).equals(Buffer.from(b.pdf))).toBe(true);
    expect(a.layoutSha256).toBe(b.layoutSha256);
    const c = await generateElection(sampleElection(), { count: 10, rng: realRng });
    expect(c.ballotList.ballotListRoot).not.toBe(a.ballotList.ballotListRoot);
  });

  it("reprints an existing batch: given ballotCodes are kept, count must match", async () => {
    const first = await generateElection(sampleElection(), { count: 5 });
    const again = await generateElection(first.electionFile, {});
    expect(again.ballotList.ballotListRoot).toBe(first.ballotList.ballotListRoot);
    expect(again.electionFileSha256).toBe(first.electionFileSha256);
    await expect(generateElection(first.electionFile, { count: 6 })).rejects.toThrow(/does not match/);
  });

  it("warns when there are too few or no spare ballots", async () => {
    expect((await generateElection(sampleElection(), { count: 20 })).warnings.join()).toMatch(/only 20 ballots for 30/);
    expect((await generateElection(sampleElection(), { count: 30 })).warnings.join()).toMatch(/no spare/);
    expect((await generateElection(sampleElection(), { count: 34 })).warnings).toEqual([]);
  });

  it("rejects bad input with clear errors", async () => {
    await expect(generateElection(sampleElection(), {})).rejects.toThrow(/count must be/);
    await expect(generateElection(sampleElection(), { count: 0 })).rejects.toThrow(/count must be/);
    await expect(generateElection(sampleElection(), { count: 1.5 })).rejects.toThrow(/count must be/);
    await expect(generateElection({ ...sampleElection(), bogus: 1 }, { count: 3 })).rejects.toBeInstanceOf(BeingsError);
    await expect(generateElection(null, { count: 3 })).rejects.toThrow(/JSON object/);
    await expect(generateElection({ ...sampleElection(), ballotCodes: ["AAAAAAAAAAAA", "AAAAAAAAAAAA"] }, {})).rejects.toThrow(/duplicate/);
    await expect(generateElection({ ...sampleElection(), ballotCodes: ["nope"] }, {})).rejects.toThrow(/invalid ballot code/);
  });

  it("refuses a question with too many choices to fit on one page, and non-Latin-1 text", async () => {
    const e = sampleElection() as { questions: { choices: { id: string; text: string }[] }[] };
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `c${i + 1}`, text: `Choice ${i + 1}` }));
    e.questions[2]!.choices = many;
    await expect(generateElection(e, { count: 3 })).rejects.toThrow(/fit|page|space/i);
    const f = sampleElection() as { name: string };
    f.name = "Élection 选举";
    await expect(generateElection(f, { count: 3 })).rejects.toThrow(/character|font|Latin/i);
  });
});

describe("shuffled", () => {
  it("is a permutation and changes the order", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const s = shuffled(items, seededRng(3));
    expect([...s].sort((a, b) => a - b)).toEqual(items);
    expect(s).not.toEqual(items);
  });
});

describe("layout", () => {
  it("is valid against the layout schema, deterministic, and has every choice once", async () => {
    const g = await generateElection(sampleElection(), { count: 4, rng: seededRng(1) });
    validateLayout(g.layout);
    const h = await generateElection({ ...sampleElection(), electionCode: g.electionFile.electionCode }, { count: 4, rng: seededRng(2) });
    expect(h.layout).toEqual(g.layout);
    const ids = g.layout.questions.map((q) => `${q.id}:${q.ovals.map((o) => o.choiceId).join(",")}`);
    expect(ids).toEqual(["q1:c1,c2", "q2:c1,c2,c3,c4", "q3:c1,c2,c3,c4,c5"]);
    expect(g.layout.questions.map((q) => q.maxMarks)).toEqual([1, 1, 2]);
  });

  it("keeps ovals at least 8 mm apart (spec 6.1), 5-6 mm wide, inside the frame, clear of the QR and receipt", async () => {
    const g = await generateElection(sampleElection(), { count: 4 });
    const all = g.layout.questions.flatMap((q) => q.ovals);
    for (const o of all) {
      expect(o.widthMm).toBeGreaterThanOrEqual(5);
      expect(o.widthMm).toBeLessThanOrEqual(6);
      expect(o.center.x).toBeGreaterThan(0);
      expect(o.center.x).toBeLessThan(g.layout.frame.widthMm);
      expect(o.uv.x).toBeCloseTo(o.center.x / g.layout.frame.widthMm, 3);
      expect(o.uv.y).toBeCloseTo(o.center.y / g.layout.frame.heightMm, 3);
      expect(o.center.y + o.heightMm / 2).toBeLessThan(g.layout.tearLineY);
      const q = g.layout.qr.bbox;
      expect(o.center.y - o.heightMm / 2 > q.y + q.height || o.center.x + o.widthMm / 2 < q.x).toBe(true);
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!, b = all[j]!;
        expect(Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)).toBeGreaterThanOrEqual(8);
      }
    }
    expect(g.layout.markers.map((m) => m.id)).toEqual(["TL", "TR", "BL", "BR"]);
  });

  it("the scanned body is self-contained: no mark, oval, QR or code lies at or below the tear line, and the bottom marks are clear of a ragged tear", async () => {
    const g = await generateElection(sampleElection(), { count: 4 });
    const L = g.layout;
    const tear = L.tearLineY;
    const bottom = (b: { y: number; height: number }): number => b.y + b.height;
    // everything the scanner reads sits above the tear line
    for (const m of L.markers) expect(m.center.y + m.sizeMm / 2, `marker ${m.id}`).toBeLessThan(tear);
    for (const q of L.questions) {
      expect(bottom(q.headingBox)).toBeLessThan(tear);
      for (const o of q.ovals) expect(o.center.y + o.heightMm / 2, `${q.id}/${o.choiceId}`).toBeLessThan(tear);
    }
    expect(bottom(L.qr.bbox) + L.qr.quietZoneModules * L.qr.moduleMm).toBeLessThan(tear);
    expect(bottom(L.ballotCodeText.bbox)).toBeLessThan(tear);
    expect(bottom(L.examplesPanel)).toBeLessThan(tear);
    // the receipt is entirely below it
    expect(L.receiptStub.y).toBeGreaterThan(tear);
    expect(bottom(L.receiptStub)).toBeLessThan(L.page.heightMm - L.markers[0]!.center.x + 14); // inside the page
    // ragged-tear clearance: at least 8 mm of clear paper between the bottom marks and the tear
    for (const id of ["BL", "BR"] as const) {
      const m = L.markers.find((x) => x.id === id)!;
      expect(tear - (m.center.y + m.sizeMm / 2), id).toBeGreaterThanOrEqual(8);
    }
    // everything lies inside the four marks (frame rectangle): ovals, QR, code
    const inside = (x: number, y: number): boolean => x >= 0 && x <= L.frame.widthMm && y >= 0 && y <= L.frame.heightMm;
    for (const q of L.questions) for (const o of q.ovals) {
      expect(inside(o.center.x - o.widthMm / 2, o.center.y - o.heightMm / 2)).toBe(true);
      expect(inside(o.center.x + o.widthMm / 2, o.center.y + o.heightMm / 2)).toBe(true);
    }
    for (const b of [L.qr.bbox, L.ballotCodeText.bbox]) expect(inside(b.x, b.y) && inside(b.x + b.width, bottom(b))).toBe(true);
    // the bottom marks are the bottom of the frame, and they are not on the receipt
    expect(L.frame.heightMm).toBeCloseTo(L.markers.find((m) => m.id === "BL")!.center.y, 3);
    expect(L.frame.heightMm).toBeLessThan(tear);
  });

  it("keeps layout version 3 and the machine-read QR where the scanner already looks", async () => {
    const g = await generateElection(sampleElection(), { count: 4 });
    expect(g.layout.layoutVersion).toBe(3);
    expect(g.layout.qr).toMatchObject({
      payloadFormat: "BEINGS1|<electionCode>|<ballotCode>|L<layoutVersion>",
      errorCorrection: "M",
      moduleMm: 0.8,
      quietZoneModules: 4,
      modules: 29,
      bbox: { x: 146, y: 22, width: 23.2, height: 23.2 },
    });
    expect(g.layout.tearLineY).toBe(227);
  });

  it("prints the election code on the ballot and the receipt, and the receipt QR carries only that code", async () => {
    const g = await generateElection({ ...sampleElection(), electionCode: "BEINGS-2026-K7M4Q2" }, { count: 4, rng: seededRng(4), siteOrigin: "https://beingsvote.live" });
    const L = g.layout;
    const url = `https://beingsvote.live/check.html#e=${g.electionFile.electionCode}`;
    expect(L.electionCode).toBe("BEINGS-2026-K7M4Q2");
    expect(L.receiptQr.purpose).toBe("voter-check-link");
    expect(L.receiptQr.url).toBe(url);
    expect(L.receiptQr.url.includes("?")).toBe(false);
    expect(L.receiptQr.url.startsWith("BEINGS1")).toBe(false);
    expect(L.receiptQr.moduleMm * 7).toBeLessThan(6);
    for (const code of g.electionFile.ballotCodes) {
      expect(L.receiptQr.url.includes(code)).toBe(false);
      expect(JSON.stringify(L.receiptQr).includes(code)).toBe(false);
    }
    const bottom = (b: { y: number; height: number }) => b.y + b.height;
    expect(bottom(L.electionCodeText.bbox)).toBeLessThan(L.tearLineY);
    expect(L.receiptElectionCodeText.bbox.y).toBeGreaterThan(L.tearLineY);
    expect(L.receiptQr.bbox.y).toBeGreaterThan(L.tearLineY);
    expect(bottom(L.receiptQr.bbox) + L.receiptQr.quietZoneModules * L.receiptQr.moduleMm).toBeLessThan(L.page.heightMm - 14);
    expect(bottom(L.qr.bbox) + L.qr.quietZoneModules * L.qr.moduleMm).toBeLessThan(L.tearLineY);
    const gap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
      Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));
    expect(gap(L.qr.bbox, L.receiptQr.bbox)).toBeGreaterThan(10);
    expect(gap(L.electionCodeText.bbox, L.qr.bbox)).toBeGreaterThan(1);
    const again = await generateElection(sampleElection(), { count: 2, rng: seededRng(4) });
    expect(again.layout.receiptQr.url).toBe(`https://beingsvote.live/check.html#e=${again.electionFile.electionCode}`);
    await expect(generateElection(sampleElection(), { count: 1, siteOrigin: "https://preview.example/check.html" })).rejects.toThrow(/origin/);
    await expect(generateElection(sampleElection(), { count: 1, siteOrigin: "http://beingsvote.live" })).rejects.toThrow(/origin/);
  });

  it("every question and every oval has an id box, and the ids match the election file", async () => {
    const g = await generateElection(sampleElection(), { count: 4 });
    expect(g.layout.questions.map((q) => q.id)).toEqual(g.electionFile.questions.map((q) => q.id));
    for (const q of g.layout.questions) {
      expect(q.idBox.width).toBeGreaterThan(0);
      for (const o of q.ovals) expect(o.idBox.width).toBeGreaterThan(0);
    }
  });
});

describe("layoutHash in the election file", () => {
  it("election-file.json carries layoutHash = SHA-256 of the canonical layout, and it is required in the output", async () => {
    const g = await generateElection(sampleElection(), { count: 6 });
    expect(g.electionFile.layoutHash).toBe(sha256Json(g.layout));
    expect(g.electionFile.layoutHash).toMatch(/^[0-9a-f]{64}$/);
    expect(g.layoutHash).toBe(g.electionFile.layoutHash);
    expect(g.layoutSha256).toBe(g.layoutHash);
    expect(electionFileProblems(g.electionFile, { requireLayoutHash: true })).toEqual([]);
    expect(() => validate("electionFile", g.electionFile)).not.toThrow();
  });

  it("the election file hash that goes on-chain covers the layout hash", async () => {
    const g = await generateElection(sampleElection(), { count: 6 });
    expect(g.electionFileSha256).toBe(sha256Json(g.electionFile));
    expect(g.createElection.fileSha256).toBe("0x" + g.electionFileSha256);
    const { layoutHash: _l, ...without } = g.electionFile;
    void _l;
    expect(sha256Json(without)).not.toBe(g.electionFileSha256);
    // a different layout (a changed question text) gives a different layoutHash and so a different election file hash
    const changed = sampleElection() as { questions: { text: string }[] };
    changed.questions[0]!.text += " (changed)";
    const h = await generateElection(changed, { count: 6, rng: seededRng(3) });
    expect(h.layoutHash).not.toBe(g.layoutHash);
  });

  it("tampering with the layout is detected: its hash no longer equals the one in the election file", async () => {
    const g = await generateElection(sampleElection(), { count: 4 });
    const tampered = JSON.parse(JSON.stringify(g.layout));
    tampered.questions[0].ovals[0].center.x += 0.5;
    expect(sha256Json(tampered)).not.toBe(g.electionFile.layoutHash);
    expect(sha256Json(JSON.parse(JSON.stringify(g.layout)))).toBe(g.electionFile.layoutHash); // key order and formatting do not matter
  });

  it("the layout (and so its hash) does not depend on the ballot codes: same questions, different codes, same layoutHash", async () => {
    const a = await generateElection({ ...sampleElection(), electionCode: "BEINGS-2026-K7M4Q2" }, { count: 5, rng: seededRng(1) });
    const b = await generateElection({ ...sampleElection(), electionCode: "BEINGS-2026-K7M4Q2" }, { count: 9, rng: seededRng(2) });
    expect(a.layoutHash).toBe(b.layoutHash);
    expect(a.electionFileSha256).not.toBe(b.electionFileSha256);
  });

  it("a reprint keeps layoutHash; a wrong or malformed layoutHash in the input is refused clearly; a file without one gets it added (older files)", async () => {
    const first = await generateElection(sampleElection(), { count: 5 });
    const again = await generateElection(first.electionFile, {});
    expect(again.electionFile.layoutHash).toBe(first.electionFile.layoutHash);
    expect(again.electionFileSha256).toBe(first.electionFileSha256);
    await expect(generateElection({ ...first.electionFile, layoutHash: "0".repeat(64) }, {})).rejects.toThrow(/layoutHash .* does not match the layout/);
    await expect(generateElection({ ...first.electionFile, layoutHash: "XYZ" }, {})).rejects.toThrow(BeingsError);
    const { layoutHash: _l, ...older } = first.electionFile;
    void _l;
    const upgraded = await generateElection(older, {});
    expect(upgraded.electionFile.layoutHash).toBe(first.electionFile.layoutHash);
  });
});
