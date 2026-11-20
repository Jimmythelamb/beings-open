#!/usr/bin/env node
// beings-scan-upload: hash a scanned ballot image and upload it to the image store.
//
//   SCANNER_UPLOAD_TOKEN=... beings-scan-upload --file scan.png --election BEINGS-2026-XXXXXX \
//       --ballot-code 4F9Q-7M2X-HT8B --retention-days 14 [--url https://beings-ballot-images.beingsvote-test.workers.dev]
//   beings-scan-upload --file scan.png --result page1-result.json --election BEINGS-2026-XXXXXX --retention-days 14
//   beings-scan-upload --file scan.png --hash-only        # just print the SHA-256 (the imageHash for the ballot record)
//
// The token comes from the environment only (never a flag, so it does not land in shell history).
import { readFileSync } from "node:fs";
import { ballotPoolProof, normalizeBallotCode, sha256Hex } from "@beings/core";
import { resolveStoreBaseUrl, uploadScan } from "./imageStore.js";

function parse(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[k] = true;
    else {
      out[k] = next;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const file = a.file;
  if (typeof file !== "string") throw new Error("--file <image> is required");
  const bytes = new Uint8Array(readFileSync(file));
  if (a["hash-only"]) {
    console.log(sha256Hex(bytes));
    return;
  }
  const token = process.env.SCANNER_UPLOAD_TOKEN;
  if (!token) throw new Error("set SCANNER_UPLOAD_TOKEN in the environment");
  const electionCode = a.election;
  if (typeof electionCode !== "string") throw new Error("--election <code> is required");
  let ballotCode = typeof a["ballot-code"] === "string" ? a["ballot-code"] : undefined;
  let expected: string | undefined;
  if (typeof a.result === "string") {
    const r = JSON.parse(readFileSync(a.result, "utf8")) as { ballotCode?: string; imageSha256?: string };
    ballotCode ??= r.ballotCode;
    expected = r.imageSha256;
  }
  if (!ballotCode) throw new Error("--ballot-code <code> (or --result <omr_finish json>) is required");
  const code = normalizeBallotCode(ballotCode);
  const days = Number(a["retention-days"]);
  if (!Number.isInteger(days) || days < 1) throw new Error("--retention-days <whole number >= 1> is required");
  let poolProof: { proof: string[]; rootIndex: number } | undefined;
  if (typeof a["ballot-proof"] === "string") {
    poolProof = {
      proof: a["ballot-proof"].split(",").map((part) => part.trim()).filter(Boolean),
      rootIndex: Number(a["root-index"] ?? 0),
    };
  }
  if (typeof a["election-file"] === "string") {
    const json = JSON.parse(readFileSync(a["election-file"], "utf8")) as { ballotCodes?: string[]; file?: { ballotCodes?: string[]; addedBallotPools?: { codes?: string[] }[] }; addedBallotPools?: { codes?: string[] }[] };
    const file = Array.isArray(json.ballotCodes) ? json : json.file;
    const pools = [file?.ballotCodes ?? []];
    for (const pool of file?.addedBallotPools ?? []) if (Array.isArray(pool.codes)) pools.push(pool.codes);
    const found = ballotPoolProof(pools, code);
    if (!found) throw new Error("this ballot is not in the election file's ballot pool");
    poolProof = { proof: found.proof, rootIndex: found.rootIndex };
  }
  const res = await uploadScan({
    baseUrl: resolveStoreBaseUrl(typeof a.url === "string" ? a.url : undefined, process.env.IMAGE_STORE_URL),
    token,
    electionCode,
    ballotCode: code,
    bytes,
    retentionDays: days,
    ...(expected ? { expectedImageSha256: expected } : {}),
    ...(poolProof ? { poolProof } : {}),
  });
  console.log(JSON.stringify({ status: res.status, imageSha256: res.imageSha256, deleteAfter: res.deleteAfter }, null, 2));
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
