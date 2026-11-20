import { describe, expect, it } from "vitest";
import { handleUpload } from "../src/upload.js";
import { ballotKey, sha256Hex } from "../src/codes.js";
import { BALLOT, ELECTION, MockStore, NOW, PNG, PNG_HASH, testConfig, uploadRequest } from "./helpers.js";

const run = (req: Request, store = new MockStore(), over = {}, now = NOW) => handleUpload(req, { store, config: testConfig(over), now: () => now });

describe("upload: hash checking", () => {
  it("stores the image under <election>/<sha256> with metadata", async () => {
    const store = new MockStore();
    const res = await run(uploadRequest(), store);
    expect(res.status).toBe(201);
    const key = `${ELECTION}/${PNG_HASH}`;
    const e = store.map.get(key)!;
    expect(Buffer.from(e.data)).toEqual(Buffer.from(PNG));
    expect(e.metadata).toEqual({
      electionCode: ELECTION,
      ballotCodeHash: ballotKey(BALLOT),
      contentType: "image/png",
      size: PNG.byteLength,
      uploadedAt: NOW.toISOString(),
      deleteAfter: "2026-11-15T12:00:00.000Z",
    });
    expect(JSON.stringify(e.metadata)).not.toContain(BALLOT); // raw ballot code never stored
  });

  it("rejects a body whose SHA-256 is not the claimed hash (422) and stores nothing", async () => {
    const store = new MockStore();
    const wrong = sha256Hex("something else");
    const res = await run(uploadRequest({ headers: { "x-image-sha256": wrong } }), store);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { actualSha256: string }).actualSha256).toBe(PNG_HASH);
    expect(store.map.size).toBe(0);
  });

  it("rejects a changed byte even if the claimed hash is that of the original", async () => {
    const tampered = new Uint8Array(PNG);
    tampered[10] = (tampered[10] ?? 0) ^ 1;
    const res = await run(uploadRequest({ body: tampered, headers: { "x-image-sha256": PNG_HASH } }));
    expect(res.status).toBe(422);
  });

  it("accepts an upper-case claimed hash (normalized) and refuses malformed ones", async () => {
    expect((await run(uploadRequest({ headers: { "x-image-sha256": PNG_HASH.toUpperCase() } }))).status).toBe(201);
    for (const bad of ["", "abc", "g".repeat(64), PNG_HASH + "0"]) {
      expect((await run(uploadRequest({ headers: { "x-image-sha256": bad } }))).status).toBe(400);
    }
  });
});

describe("upload: validation", () => {
  it("enforces the content type allowlist", async () => {
    for (const ct of ["image/gif", "text/html", "image/svg+xml", "application/octet-stream", ""]) {
      expect((await run(uploadRequest({ headers: { "content-type": ct } }))).status).toBe(415);
    }
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect((await run(uploadRequest({ body: jpeg, headers: { "content-type": "image/jpeg" } }))).status).toBe(201);
    const pdf = new TextEncoder().encode("%PDF-1.4 hello");
    expect((await run(uploadRequest({ body: pdf, headers: { "content-type": "application/pdf; charset=binary" } }))).status).toBe(201);
  });

  it("refuses content that is not what its content type says", async () => {
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    expect((await run(uploadRequest({ body: html, headers: { "content-type": "image/png" } }))).status).toBe(415);
  });

  it("enforces the size limit, by header and by actual bytes", async () => {
    const big = new Uint8Array(1001);
    big.set(PNG);
    expect((await run(uploadRequest({ body: big }), new MockStore(), { maxImageBytes: 1000 })).status).toBe(413);
    const exact = new Uint8Array(1000);
    exact.set(PNG);
    expect((await run(uploadRequest({ body: exact }), new MockStore(), { maxImageBytes: 1000 })).status).toBe(201);
    // lying content-length header (smaller than the body) cannot sneak a large body through
    const lying = uploadRequest({ body: big, headers: { "content-length": "10" } });
    expect((await run(lying, new MockStore(), { maxImageBytes: 1000 })).status).toBe(413);
  });

  it("requires valid election code, ballot key and retention days", async () => {
    expect((await run(uploadRequest({ headers: { "x-election-code": "BEINGS-2026-4CRWXU" } }))).status).toBe(400);
    expect((await run(uploadRequest({ headers: { "x-election-code": null } }))).status).toBe(400);
    expect((await run(uploadRequest({ headers: { "x-election-code": "../x" } }))).status).toBe(400);
    expect((await run(uploadRequest({ headers: { "x-ballot-key": BALLOT } }))).status).toBe(400);
    expect((await run(uploadRequest({ headers: { "x-ballot-key": null } }))).status).toBe(400);
    expect((await run(uploadRequest({ headers: { "x-retention-days": "0" } }))).status).toBe(400);
    expect((await run(uploadRequest({ headers: { "x-retention-days": "366" } }))).status).toBe(400);
    expect((await run(uploadRequest({ headers: { "x-retention-days": null } }))).status).toBe(400);
  });
});

describe("upload: idempotence", () => {
  it("the same upload twice is a success and keeps one blob", async () => {
    const store = new MockStore();
    expect((await run(uploadRequest(), store)).status).toBe(201);
    const again = await run(uploadRequest(), store);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("exists");
    expect(store.map.size).toBe(1);
  });

  it("a repeat never shortens retention but may extend it", async () => {
    const store = new MockStore();
    await run(uploadRequest({ headers: { "x-retention-days": "30" } }), store);
    const key = `${ELECTION}/${PNG_HASH}`;
    expect(store.map.get(key)!.metadata.deleteAfter).toBe("2026-12-01T12:00:00.000Z");
    await run(uploadRequest({ headers: { "x-retention-days": "7" } }), store);
    expect(store.map.get(key)!.metadata.deleteAfter).toBe("2026-12-01T12:00:00.000Z");
    const ext = await run(uploadRequest({ headers: { "x-retention-days": "90" } }), store, {}, new Date("2026-11-05T12:00:00.000Z"));
    expect(((await ext.json()) as { extended: boolean }).extended).toBe(true);
    expect(store.map.get(key)!.metadata.deleteAfter).toBe("2027-02-03T12:00:00.000Z");
    expect(store.map.get(key)!.metadata.uploadedAt).toBe(NOW.toISOString()); // original upload time kept
  });

  it("the same image claimed for a different ballot is refused (409)", async () => {
    const store = new MockStore();
    await run(uploadRequest(), store);
    const other = await run(uploadRequest({ headers: { "x-ballot-key": ballotKey("AAAAAAAAAAAA") } }), store);
    expect(other.status).toBe(409);
  });
});

describe("upload: public ballot images retention", () => {
  const policyOn = async () => ({ publicBallotImages: true, retentionDays: 30 });
  const policyOff = async () => ({ publicBallotImages: false, retentionDays: 90 });
  const runPublic = (req: Request, store = new MockStore(), policyFor?: typeof policyOn | typeof policyOff) =>
    handleUpload(req, { store, config: testConfig(), now: () => NOW, ...(policyFor ? { policyFor } : {}) });

  it("accepts 30 to 60 days when X-Public-Images is set, and stores the public flag", async () => {
    const store = new MockStore();
    const res = await runPublic(uploadRequest({ headers: { "x-retention-days": "30", "x-public-images": "true" } }), store);
    expect(res.status).toBe(201);
    expect(store.map.get(`${ELECTION}/${PNG_HASH}`)!.metadata.publicImages).toBe(1);
    expect(store.map.get(`${ELECTION}/${PNG_HASH}`)!.metadata.deleteAfter).toBe("2026-12-01T12:00:00.000Z");
    expect((await runPublic(uploadRequest({ headers: { "x-retention-days": "60", "x-public-images": "1" } }))).status).toBe(201);
  });

  it("rejects 14 or 90 days when pictures are public", async () => {
    const r14 = await runPublic(uploadRequest({ headers: { "x-retention-days": "14", "x-public-images": "true" } }));
    expect(r14.status).toBe(400);
    expect(((await r14.json()) as { error: string }).error).toMatch(/30 to 60/);
    expect((await runPublic(uploadRequest({ headers: { "x-retention-days": "90", "x-public-images": "true" } }))).status).toBe(400);
    const viaPolicy = await runPublic(uploadRequest({ headers: { "x-retention-days": "90" } }), new MockStore(), policyOn);
    expect(viaPolicy.status).toBe(400);
  });

  it("still allows 1–365 days when the setting is off", async () => {
    expect((await runPublic(uploadRequest({ headers: { "x-retention-days": "14" } }), new MockStore(), policyOff)).status).toBe(201);
    expect((await runPublic(uploadRequest({ headers: { "x-retention-days": "365" } }), new MockStore(), policyOff)).status).toBe(201);
    expect((await runPublic(uploadRequest({ headers: { "x-retention-days": "366" } }), new MockStore(), policyOff)).status).toBe(400);
  });

  it("refuses X-Public-Images when the election file says the setting is off", async () => {
    const res = await runPublic(uploadRequest({ headers: { "x-retention-days": "30", "x-public-images": "true" } }), new MockStore(), policyOff);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not public/);
  });
});
