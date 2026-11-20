#!/usr/bin/env node
// Build or check a B.E.I.N.G.S. long-term public election record, offline. Never signs, never sends a transaction,
// never reads a private key. The only network use is the optional --check-chain, a READ-ONLY call to the public RPC.
//
//   node tools/election-record/build-record.mjs draft-note --election BEINGS-2026-QB1TTH --author 0x… --role organizer \
//        --tally-version 1 --checks R6 --text-file note.txt [--created-at ISO] --out notes/organizer-note-1.json
//       writes the UNSIGNED note and, next to it, <name>.eip712.json (exactly what the wallet will be asked to sign).
//
//   node tools/election-record/build-record.mjs build --election CODE --public-copy public/data/elections/CODE.json \
//        [--results results.json] --note notes/organizer-note-1.json [--note …] --out <dir> [--check-chain] \
//        [--onchain onchain.json] [--notes-contract 0x…] [--created-at ISO] [--keep-until ISO]
//       copies the public files into <dir>, writes <dir>/manifest.json, prints the record fingerprint.
//
//   node tools/election-record/build-record.mjs verify --dir <dir> [--check-chain]
//
// Public files only. Every JSON file is scanned for ballot codes (a "ballotCodes" key with entries, or any 12-character
// code-shaped string) and refused if one is found. Keep the secret full election file and the ballots PDF out of here.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, verifyTypedData, id as keccakId, JsonRpcProvider, Contract } from "ethers";
import * as R from "../../public/js/record.js";
import { canonicalize } from "../../public/js/format.js";
import { ABI } from "../../public/js/abi.js";
import { CONFIG, contractSets } from "../../public/js/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, "../..");

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    if (k === "note") (out.note ??= []).push(v);
    else out[k] = v;
  }
  return out;
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
};
const electionKey = (code) => keccakId(code).toLowerCase();

/** Read-only facts from Coston2 for one election and tally version. Tries the current contracts, then each legacy set. */
async function readChain(code, tallyVersion, { rpcUrl = CONFIG.rpcUrl, contracts = null } = {}) {
  const sets = contracts ? [{ contracts }] : contractSets();
  const provider = new JsonRpcProvider(rpcUrl, CONFIG.chainId, { staticNetwork: true });
  const key = electionKey(code);
  let lastError = null;
  for (const set of sets) {
    const registry = new Contract(set.contracts.registry, ABI.registry, provider);
    const tally = new Contract(set.contracts.tally, ABI.tally, provider);
    try {
      const e = await registry.elections(key);
      if (Number(e.status) === 0) continue;
      const [v, count] = await Promise.all([registry.latestVersion(key), tally.resultCount(key)]);
      const version = tallyVersion ?? Number(count);
      const r = await tally.getResult(key, version);
      return {
        organizer: e.organizer,
        status: ["None", "Setup", "Open", "Closed", "Tallied"][Number(e.status)],
        registeredVoters: Number(e.registeredVoters),
        ballotCount: Number(e.ballotCount),
        tallyVersions: Number(count),
        contracts: set.contracts,
        onChain: {
          fileCid: v.cid,
          fileSha256: v.fileSha256.toLowerCase(),
          resultsCid: r.resultsCid,
          resultsSha256: r.resultsSha256.toLowerCase(),
          merkleRoot: r.merkleRoot.toLowerCase(),
          failedChecks: Number(r.failedChecks),
          failedCheckIds: R.failedCheckIds(Number(r.failedChecks)),
          finality: Number(r.finality) === 1 ? "Final" : "Provisional",
          tallyPostedAt: new Date(Number(r.postedAt) * 1000).toISOString(),
        },
      };
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`No election ${code} on the current or earlier Coston2 contracts.`);
}

async function draftNoteCmd(a) {
  const code = a.election;
  const text = a["text-file"] ? readFileSync(a["text-file"], "utf8") : a.text;
  const note = R.draftNote({
    electionCode: code,
    electionKey: electionKey(code),
    tallyVersion: Number(a["tally-version"] ?? 1),
    author: a.author,
    role: a.role ?? "organizer",
    checks: a.checks ? String(a.checks).split(",").map((s) => s.trim()).filter(Boolean) : [],
    kind: a.kind ?? "explanation",
    displayName: a["display-name"] ?? "",
    createdAt: a["created-at"] ?? new Date().toISOString(),
    text,
  });
  const td = R.noteTypedData(note, keccak256);
  writeJson(a.out, note);
  const tdPath = a.out.replace(/\.json$/, "") + ".eip712.json";
  writeJson(tdPath, { ...td, _about: "Unsigned EIP-712 payload. The author's wallet signs exactly this (eth_signTypedData_v4). Nothing here is secret." });
  console.log(JSON.stringify({ note: a.out, typedData: tdPath, bodyHash: td.message.bodyHash, unsignedNoteSha256: await R.noteFileSha256(note), signed: false }, null, 2));
}

async function buildCmd(a) {
  const code = a.election;
  const key = electionKey(code);
  const out = resolve(a.out);
  const pub = readJson(a["public-copy"] ?? join(siteRoot, "public/data/elections", `${code}.json`));
  if (!pub.publicCopy) throw new Error("The election file given isn't marked as a public copy. Use the public copy (ballot codes removed), never the secret full file.");
  const notes = (a.note ?? []).map((p) => ({ p, json: readJson(p) }));
  let tallyVersion = Number(a["tally-version"] ?? notes[0]?.json.tallyVersion ?? 1);
  let chain = a.onchain ? readJson(a.onchain) : null;
  if (a["check-chain"]) chain = await readChain(code, tallyVersion);
  if (!chain) throw new Error("Give --check-chain (read-only) or --onchain <file> with the on-chain facts.");
  const files = [{ path: "election.public.json", role: "public-election-copy", json: pub, matchesOnChainFileHash: false, note: "Ballot codes removed, so this copy's fingerprint differs from the registered fileSha256 by design." }];
  if (a.results) {
    const res = readJson(a.results);
    const sha = "0x" + (await R.recordFileSha256({ json: res }));
    const matches = sha === chain.onChain.resultsSha256;
    if (!matches) throw new Error(`results file fingerprint ${sha} doesn't match the on-chain resultsSha256 ${chain.onChain.resultsSha256}. Don't publish it as the official results file.`);
    files.push({ path: "results.json", role: "results-doc", json: res, matchesOnChainResultsHash: true });
  }
  for (const [i, n] of notes.entries()) {
    const errs = R.validateNote(n.json);
    if (errs.length) throw new Error(`${n.p}: ${errs.join(" ")}`);
    if (n.json.electionCode !== code || n.json.electionKey !== key) throw new Error(`${n.p} is for another election.`);
    const signed = n.json.signature !== undefined;
    if (signed) {
      const v = R.verifyNoteSignature(n.json, { keccak256, verifyTypedData });
      if (!v.valid) throw new Error(`${n.p}: ${v.errors.join(" ")}`);
    }
    files.push({ path: `notes/${basename(n.p)}`, role: "official-note", json: n.json, signed, author: n.json.author, authorRole: n.json.role, noteSha256: await R.noteFileSha256(n.json) });

  }
  const contracts = { ...(chain.contracts ?? CONFIG.contracts), notes: a["notes-contract"] ?? CONFIG.contracts.notes ?? null };
  if (!contracts.notes) contracts.notes = null;
  const { manifest, manifestSha256 } = await R.buildRecordManifest({
    electionCode: code,
    electionKey: key,
    contracts,
    tallyVersion,
    onChain: chain.onChain,
    retention: a["keep-until"] ? { keepUntil: a["keep-until"] } : { keepUntil: null, status: "pending the organizer's decision (suggested: 5 years for a classroom test)" },
    createdAt: a["created-at"] ?? new Date().toISOString(),
    mirrors: [{ kind: "site", url: `https://beingsvote.live/data/records/${code}/` }],
    files,
  });
  for (const f of files) writeJson(join(out, f.path), f.json);
  writeJson(join(out, "manifest.json"), manifest);
  const unsigned = files.filter((f) => f.role === "official-note" && !f.signed).map((f) => f.path);
  console.log(JSON.stringify({ out, manifestSha256, files: manifest.files.map((f) => ({ path: f.path, sha256: f.sha256 })), draft: unsigned.length > 0, unsignedNotes: unsigned }, null, 2));
}

async function verifyCmd(a) {
  const dir = resolve(a.dir);
  const manifest = readJson(join(dir, "manifest.json"));
  const fetched = {};
  for (const f of manifest.files) {
    const p = join(dir, f.path);
    fetched[f.path] = existsSync(p) ? (f.hashOf === "bytes" ? { bytes: readFileSync(p) } : { json: readJson(p) }) : null;
  }
  const checks = await R.checkRecordFiles(manifest, fetched);
  const notes = [];
  for (const f of manifest.files.filter((x) => x.role === "official-note")) {
    const n = fetched[f.path]?.json;
    if (!n) continue;
    notes.push({ path: f.path, signed: n.signature !== undefined, signature: n.signature !== undefined ? R.verifyNoteSignature(n, { keccak256, verifyTypedData }) : null });
  }
  let chain = null;
  if (a["check-chain"]) {
    chain = await readChain(manifest.electionCode, manifest.tallyVersion);
    chain.matches = canonicalize(chain.onChain) === canonicalize(manifest.onChain);
  }
  console.log(JSON.stringify({ manifestSha256: await R.manifestSha256(manifest), files: checks.map(({ path, state }) => ({ path, state })), notes, chain }, null, 2));
  if (checks.some((c) => c.state !== "match") || notes.some((n) => n.signed && !n.signature.valid) || (chain && !chain.matches)) process.exitCode = 2;
}

const a = args(process.argv.slice(2));
const cmd = a._[0];
const run = { "draft-note": draftNoteCmd, build: buildCmd, verify: verifyCmd }[cmd];
if (!run) {
  console.error("usage: build-record.mjs draft-note | build | verify  (see the comment at the top of this file)");
  process.exit(1);
}
run(a).catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
