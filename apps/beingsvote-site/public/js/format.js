// Pure helpers (no DOM, no network): code handling, ledger result strings, plain-language text, counting, JCS.
// Unit-tested in test/ui-format.test.ts. Must agree with @beings/core (codes.ts, results.ts, canonical.ts).

export const BALLOT_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
export const ELECTION_CODE_RE = /^BEINGS-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{6}$/;
const RESULT_RE = /^(?:V:(c[1-9][0-9]{0,2}(?:\+c[1-9][0-9]{0,2})*)|B|O|U)$/;

/** What a voter types to the strict 12-character form (same rules as core `normalizeBallotCode`); null if invalid. */
export function normalizeBallotCode(input) {
  const s = String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return BALLOT_CODE_RE.test(s) ? s : null;
}

export function normalizeElectionCode(input) {
  const s = String(input ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return ELECTION_CODE_RE.test(s) ? s : null;
}

/** "4F9Q7M2XHT8B" -> "4F9Q-7M2X-HT8B" */
export function formatBallotCode(code) {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

const choiceNumber = (id) => Number(id.slice(1));

/** Parse ONE result segment: V:c2, V:c1+c3, B, O or U. Returns null for anything else (never guesses). */
export function parseResult(seg) {
  const m = typeof seg === "string" ? RESULT_RE.exec(seg) : null;
  if (!m) return null;
  if (m[1] === undefined) return { kind: seg };
  const choices = m[1].split("+");
  for (let i = 1; i < choices.length; i++) if (choiceNumber(choices[i]) <= choiceNumber(choices[i - 1])) return null;
  return { kind: "V", choices };
}

/** A ledger entry is the question results joined by "|", in election-file question order. */
export function splitLedgerResults(results) {
  return String(results ?? "").split("|");
}

function joinNames(names) {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Look up a choice's text in a question (falls back to the raw id so nothing is hidden). */
export function choiceLabel(question, id) {
  const c = question?.choices?.find((x) => x.id === id);
  return c ? c.text : id;
}

/**
 * Plain-language translation of one result segment.
 * `question` is optional ({ id, text, maxMarks, choices }); without it the ids are shown as they are.
 * Returns { tone: "ok" | "info" | "warn", title, detail, raw }.
 */
export function describeResult(seg, question) {
  const p = parseResult(seg);
  const raw = seg;
  if (!p) return { tone: "warn", title: "We couldn't read this entry", detail: `The ledger holds "${seg}", which isn't in a form this page understands. The raw text is shown so you can check it yourself.`, raw };
  if (p.kind === "V") {
    const names = p.choices.map((id) => choiceLabel(question, id));
    return {
      tone: "ok",
      title: names.length === 1 ? `You marked: ${names[0]}` : `You marked ${names.length} choices: ${joinNames(names)}`,
      detail: "A clear mark was read for this question and it was counted for the choice" + (names.length > 1 ? "s" : "") + " above.",
      raw,
    };
  }
  if (p.kind === "B") return { tone: "info", title: "No mark found (blank)", detail: "No mark was found for this question, so it counts as 'no answer'. It is not added to any choice. Your other questions still count.", raw };
  if (p.kind === "O") {
    const max = question?.maxMarks;
    return { tone: "warn", title: "Too many marks (overvote)", detail: `${max ? `More than ${max} mark${max === 1 ? " was" : "s were"}` : "More marks than allowed were"} found for this question. When that happens the question isn't counted for any choice, because nobody can tell which one you meant. Your other questions still count.`, raw };
  }
  return { tone: "warn", title: "Mark unclear, flagged for review", detail: "A mark on this question was too faint or smudged for the scanner to be sure. It is flagged for a person to look at and, if needed, a public correction is posted on the ledger.", raw };
}

/**
 * Count results the same way @beings/core `tallyQuestions` does: per question, `valid` = ballots with a V result,
 * `byChoice[c]` = marks for choice c (a two-mark ballot adds 1 to each), `blank`, `overvote`, `unclear`.
 * `resultStrings` = one ledger string per ballot (corrections already applied by the caller).
 */
export function tallyFromResults(resultStrings, questions) {
  const out = questions.map((q) => ({
    id: q.id,
    valid: 0,
    blank: 0,
    overvote: 0,
    unclear: 0,
    unreadable: 0,
    byChoice: Object.fromEntries(q.choices.map((c) => [c.id, 0])),
  }));
  for (const s of resultStrings) {
    const segs = splitLedgerResults(s);
    out.forEach((t, i) => {
      const p = parseResult(segs[i]);
      if (!p) t.unreadable++;
      else if (p.kind === "V") {
        t.valid++;
        for (const id of p.choices) t.byChoice[id] = (t.byChoice[id] ?? 0) + 1;
      } else if (p.kind === "B") t.blank++;
      else if (p.kind === "O") t.overvote++;
      else t.unclear++;
    });
  }
  return out;
}

/** Apply the latest correction per (ballot, question) to the original ledger strings. Returns { ballotKey -> string }. */
export function applyCorrections(records, corrections) {
  const latest = new Map(); // `${ballotKey}:${q}` -> {index, toResult}
  for (const c of corrections) {
    const k = `${c.ballotKey}:${c.questionIndex}`;
    const prev = latest.get(k);
    if (!prev || c.index > prev.index) latest.set(k, c);
  }
  const out = {};
  for (const [ballotKey, results] of Object.entries(records)) {
    const segs = splitLedgerResults(results);
    segs.forEach((_, i) => {
      const c = latest.get(`${ballotKey}:${i}`);
      if (c) segs[i] = c.toResult;
    });
    out[ballotKey] = segs.join("|");
  }
  return out;
}

/** RFC 8785 (JCS) canonical JSON, the form the election-file fingerprint is computed over. Throws on unsupported values. */
export function canonicalize(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v)) throw new Error("cannot canonicalize a non-finite number");
    return JSON.stringify(Object.is(v, -0) ? 0 : v);
  }
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (t === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
  throw new Error(`cannot canonicalize a value of type ${t}`);
}

export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function shortHash(h, lead = 8, tail = 6) {
  const s = String(h ?? "");
  return s.length <= lead + tail + 1 ? s : `${s.slice(0, lead)}…${s.slice(-tail)}`;
}

export function shortAddress(a) {
  return shortHash(a, 6, 4);
}

/** Plain-language election status. Matches the on-chain enum: None, Setup, Open, Closed, Tallied. */
export const STATUS_TEXT = [
  { key: "none", label: "Unknown", blurb: "No election with this code was found on the ledger." },
  { key: "setup", label: "Getting ready", blurb: "The election is registered but voting hasn't started." },
  { key: "open", label: "Voting open", blurb: "Ballots are being counted and recorded as they are scanned." },
  { key: "closed", label: "Voting closed", blurb: "Voting is over. The official count hasn't been published yet." },
  { key: "tallied", label: "Results published", blurb: "The official count is on the ledger and anyone can check it." },
];
