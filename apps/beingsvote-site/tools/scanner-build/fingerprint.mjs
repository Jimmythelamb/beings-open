#!/usr/bin/env node
// Scanner build fingerprint: SHA-256 of the raw bytes of each file named, the same formula the ledger scripts use for
// the scanner app fingerprint (sha256 of packages/scanner/prototype/omr.py). Read-only: hashes files, prints hex, nothing else.
//   node tools/scanner-build/fingerprint.mjs ../../packages/scanner/prototype/omr.py
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SCANNER_BUILDS } from "../../public/js/scanner-builds.js";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: fingerprint.mjs <file> [file…]");
  process.exit(2);
}
for (const f of files) {
  const hex = createHash("sha256").update(readFileSync(f)).digest("hex");
  const known = SCANNER_BUILDS.find((b) => b.sha256 === hex);
  console.log(`${hex}  ${f}${known ? `  (listed: ${known.label})` : "  (not in the approved list)"}`);
}
