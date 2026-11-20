// Three-threshold Merkle consensus for one batch of fill scores. Same rules as packages/core/src/consensus.ts.
// Fill scores are computed once by the mark reader. This re-derives the results string three times and
// compares the Merkle roots. Ballot codes are hashed into the leaf key and are never written out.
import { keccak256Hex } from "./keccak256.mjs";

export const CONSENSUS_KIND = "beings-consensus/1";
export const CONSENSUS_LEAF_ORDER =
  "Leaves are keccak256(key || keccak256(results string)), sorted ascending by that hash before sorted-pair hashing. The report lists ballots by key, ascending.";
export const ZERO_ROOT = `0x${"00".repeat(32)}`;
const DEFAULT_TIGHT = { emptyBelow: 10, markedAbove: 55 };
const DEFAULT_STANDARD = { emptyBelow: 15, markedAbove: 50 };
const DEFAULT_LOOSE = { emptyBelow: 20, markedAbove: 45 };
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

function assertPair(name, pair) {
  if (!pair || typeof pair !== "object") throw new Error(`${name} thresholds are missing`);
  for (const key of ["emptyBelow", "markedAbove"]) {
    const n = pair[key];
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`${name}.${key} must be an integer 0-100`);
  }
  if (pair.emptyBelow > pair.markedAbove + 1) throw new Error(`${name}: emptyBelow must be <= markedAbove + 1`);
  return { emptyBelow: pair.emptyBelow, markedAbove: pair.markedAbove };
}

export function resolveConsensusThresholds(election) {
  const file = election?.consensusThresholds ?? {};
  const standard = file.standard ?? {
    emptyBelow: election?.resultRules?.emptyBelow ?? DEFAULT_STANDARD.emptyBelow,
    markedAbove: election?.resultRules?.markedAbove ?? DEFAULT_STANDARD.markedAbove,
  };
  return {
    tight: assertPair("tight", file.tight ?? DEFAULT_TIGHT),
    standard: assertPair("standard", standard),
    loose: assertPair("loose", file.loose ?? DEFAULT_LOOSE),
  };
}

function imageKey(imageSha256) {
  const h = String(imageSha256).startsWith("0x") || String(imageSha256).startsWith("0X") ? String(imageSha256).slice(2) : String(imageSha256);
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("imageSha256 must be 32 bytes of hex");
  return `0x${h.toLowerCase()}`;
}

function ballotKeyOf(code) {
  if (!CODE_RE.test(code)) throw new Error("ballot code must be 12 Crockford base-32 characters");
  return keccak256Hex(code);
}

function hexToBytes(hex) {
  const h = hex.slice(2);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function consensusLeaf(key, resultsString) {
  return keccak256Hex(concat(hexToBytes(key), hexToBytes(keccak256Hex(resultsString))));
}

function hashPair(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return keccak256Hex(concat(hexToBytes(lo), hexToBytes(hi)));
}

function merkleRoot(leaves) {
  const sorted = [...leaves].sort();
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new Error("duplicate leaf");
  if (!sorted.length) return ZERO_ROOT;
  let level = sorted;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const b = level[i + 1];
      next.push(b === undefined ? level[i] : hashPair(level[i], b));
    }
    level = next;
  }
  return level[0];
}

function bubbleState(score, rules) {
  if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error(`fill score must be an integer 0-100, got ${score}`);
  if (score > rules.markedAbove) return "marked";
  if (score < rules.emptyBelow) return "empty";
  return "unclear";
}

function formatResult(choices) {
  const sorted = [...choices].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return `V:${sorted.join("+")}`;
}

function deriveQuestion(scores, maxMarks, rules) {
  const marked = [];
  let unclear = 0;
  for (const [choiceId, score] of Object.entries(scores)) {
    const st = bubbleState(score, rules);
    if (st === "marked") marked.push(choiceId);
    else if (st === "unclear") unclear++;
  }
  if (marked.length > maxMarks) return "O";
  if (unclear > 0) return "U";
  if (marked.length === 0) return "B";
  return formatResult(marked);
}

function passOf(election, fillScores, rules) {
  const results = {};
  for (const q of election.questions) {
    const scores = fillScores[q.id];
    if (!scores) throw new Error(`fill scores missing question ${q.id}`);
    results[q.id] = deriveQuestion(scores, q.maxMarks, rules);
  }
  return { results, resultsString: election.questions.map((q) => results[q.id]).join("|") };
}

function flagFor(election, row, thresholds) {
  const questions = [];
  const ovals = [];
  for (const q of election.questions) {
    const tight = row.byPass.tight.results[q.id];
    const standard = row.byPass.standard.results[q.id];
    const loose = row.byPass.loose.results[q.id];
    if (tight !== standard || standard !== loose) questions.push({ id: q.id, tight, standard, loose });
    const scores = row.fillScores[q.id] ?? {};
    for (const c of q.choices) {
      const fillScore = scores[c.id];
      const states = {
        tight: bubbleState(fillScore, thresholds.tight),
        standard: bubbleState(fillScore, thresholds.standard),
        loose: bubbleState(fillScore, thresholds.loose),
      };
      if (states.tight !== states.standard || states.standard !== states.loose) {
        ovals.push({ question: q.id, choice: c.id, fillScore, ...states });
      }
    }
  }
  if (!questions.length && !ovals.length) return null;
  return {
    ballotKey: row.key,
    ...(row.imageSha256 ? { imageSha256: row.imageSha256 } : {}),
    ...(row.page !== undefined ? { page: row.page } : {}),
    review: "human",
    questions,
    ovals,
  };
}

export function consensusReport(election, ballots) {
  if (!election?.questions?.length) throw new Error("consensus needs the election questions");
  const thresholds = resolveConsensusThresholds(election);
  const codes = ballots.map((b) => b.ballotCode).filter((c) => typeof c === "string" && c.length > 0);
  const coded = ballots.filter((b) => b.ballotCode);
  if (coded.length && coded.length !== ballots.length) throw new Error("consensus ballots must all use a ballot key, or all use an image hash");
  const keyMode = coded.length ? "ballotKey" : "imageSha256";
  const rows = ballots.map((b) => {
    const key = keyMode === "ballotKey" ? ballotKeyOf(b.ballotCode) : imageKey(b.imageSha256 ?? "");
    const byPass = {};
    for (const pass of ["tight", "standard", "loose"]) byPass[pass] = passOf(election, b.fillScores, thresholds[pass]);
    const imageSha256 = b.imageSha256 ? imageKey(b.imageSha256).slice(2) : undefined;
    return { key, ...(imageSha256 ? { imageSha256 } : {}), ...(b.page !== undefined ? { page: b.page } : {}), fillScores: b.fillScores, byPass };
  });
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.key)) throw new Error("duplicate ballot key in consensus");
    seen.add(row.key);
  }
  const roots = {};
  for (const pass of ["tight", "standard", "loose"]) {
    const leaves = rows.map((row) => consensusLeaf(row.key, row.byPass[pass].resultsString));
    roots[pass] = leaves.length ? merkleRoot(leaves) : ZERO_ROOT;
  }
  const passed = roots.tight === roots.standard && roots.standard === roots.loose;
  const flags = passed ? [] : rows.map((row) => flagFor(election, row, thresholds)).filter(Boolean);
  const report = {
    kind: CONSENSUS_KIND,
    passed,
    needsHumanReview: !passed,
    keyMode,
    leafOrder: CONSENSUS_LEAF_ORDER,
    thresholds,
    roots,
    ballots: rows.length,
    flags,
  };
  const text = JSON.stringify(report);
  for (const code of codes) if (text.includes(JSON.stringify(code))) throw new Error("consensus report would include a ballot code");
  return report;
}

export function formatConsensusSummary(report) {
  const t = report.thresholds;
  const band = (p) => `${p} ${t[p].emptyBelow}/${t[p].markedAbove}`;
  const sheets = (n) => `${n} ${n === 1 ? "ballot" : "ballots"}`;
  const lines = [
    report.passed
      ? `Consensus: the three readings of these same scans agree (${sheets(report.ballots)}).`
      : `Consensus: the three readings do not agree. ${sheets(report.flags.length)} flagged for a human look.`,
    `Thresholds: ${band("tight")} (pass A), ${band("standard")} (pass B), ${band("loose")} (pass C).`,
    `Roots: tight ${report.roots.tight}`,
    `       standard ${report.roots.standard}`,
    `       loose ${report.roots.loose}`,
  ];
  if (report.passed) lines.push("Nothing in this check was signed.");
  for (const f of report.flags) {
    const who = [f.page !== undefined ? `page ${f.page}` : "", f.imageSha256 ? `image ${f.imageSha256.slice(0, 12)}` : "", `key ${f.ballotKey.slice(0, 10)}`].filter(Boolean).join(", ");
    lines.push(`  ${who}`);
    for (const q of f.questions) lines.push(`    ${q.id}: tight ${q.tight}, standard ${q.standard}, loose ${q.loose}`);
    for (const o of f.ovals) lines.push(`    ${o.question}/${o.choice} fill ${o.fillScore}: tight ${o.tight}, standard ${o.standard}, loose ${o.loose}`);
  }
  if (!report.passed) lines.push("A person should look at the flagged sheets before anything is signed.");
  return lines.join("\n");
}
