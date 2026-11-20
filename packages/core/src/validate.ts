import * as Ajv2020Module from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { Ajv2020 as Ajv2020Class, ValidateFunction } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { BeingsError, SchemaValidationError, type SchemaIssue } from "./errors.js";
import { SCHEMAS, type SchemaName } from "./schemas.generated.js";
import { SCHEMA_VERSION } from "./types.js";
import { ELECTION_CODE_RE } from "./codes.js";
import { parseResult } from "./results.js";
import type {
  BallotRecord,
  Correction,
  ElectionFile,
  LedgerEntry,
  TallyFile,
  VerifierReport,
} from "./types.js";

// ajv and ajv-formats are CommonJS: depending on the loader (Node ESM, vitest, a bundler) the class or plugin
// is the module itself, `.default`, or `.default.default`. Unwrap whichever is a function.
function unwrap<T>(mod: unknown, named?: string): T {
  let m = mod as Record<string, unknown>;
  for (let i = 0; i < 3; i++) {
    if (typeof m === "function") return m as unknown as T;
    if (named && typeof m[named] === "function") return m[named] as T;
    m = m["default"] as Record<string, unknown>;
  }
  throw new BeingsError("BAD_INPUT", "could not load ajv");
}
const Ajv2020 = unwrap<typeof Ajv2020Class>(Ajv2020Module, "Ajv2020");
const addFormats = unwrap<FormatsPlugin>(addFormatsModule);

export type { SchemaName };
export const SCHEMA_NAMES = Object.keys(SCHEMAS) as SchemaName[];

/** Maps each schema name to the TypeScript type it describes. */
export interface SchemaTypes {
  electionFile: ElectionFile;
  ballotRecord: BallotRecord;
  ledgerEntry: LedgerEntry;
  correction: Correction;
  tally: TallyFile;
  verifierReport: VerifierReport;
}

let ajv: Ajv2020Class | undefined;
const compiled = new Map<SchemaName, ValidateFunction>();

function getValidator(name: SchemaName): ValidateFunction {
  const schema = SCHEMAS[name];
  if (!schema) throw new BeingsError("BAD_INPUT", `unknown schema "${String(name)}"`);
  let fn = compiled.get(name);
  if (fn === undefined) {
    if (!ajv) {
      // strictRequired is off ONLY because the spec's `checks` object lists required keys but defines them via
      // additionalProperties; the schemas are used verbatim from the spec. Every other strict check stays on.
      ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
      addFormats(ajv);
    }
    fn = ajv.compile(schema as object);
    compiled.set(name, fn);
  }
  return fn;
}

function issuesOf(fn: ValidateFunction): SchemaIssue[] {
  return (fn.errors ?? []).map((e) => ({
    path: e.instancePath,
    message: e.message ?? "invalid",
    keyword: e.keyword,
  }));
}

/** Non-throwing check. Returns the schema issues (empty array = valid). */
export function schemaIssues(name: SchemaName, json: unknown): SchemaIssue[] {
  const fn = getValidator(name);
  return fn(json) ? [] : issuesOf(fn);
}

export function isValid<N extends SchemaName>(name: N, json: unknown): json is SchemaTypes[N] {
  return schemaIssues(name, json).length === 0;
}

/**
 * Validate `json` against a spec schema and THROW if it does not match (fail closed).
 * A `schemaVersion` other than "0.1" is a hard error (SCHEMA_VERSION), reported before other issues.
 */
export function validate<N extends SchemaName>(name: N, json: unknown): asserts json is SchemaTypes[N] {
  if (json !== null && typeof json === "object" && !Array.isArray(json) && "schemaVersion" in json) {
    const v = (json as { schemaVersion: unknown }).schemaVersion;
    if (v !== SCHEMA_VERSION) {
      throw new SchemaValidationError(
        name,
        [{ path: "/schemaVersion", keyword: "const", message: `unsupported schemaVersion ${JSON.stringify(v)}; this library speaks "${SCHEMA_VERSION}"` }],
        "SCHEMA_VERSION",
      );
    }
  }
  const issues = schemaIssues(name, json);
  if (issues.length > 0) throw new SchemaValidationError(name, issues);
}

/**
 * Parse JSON text and validate it. Throws INVALID_JSON for unparseable text.
 */
export function parseAndValidate<N extends SchemaName>(name: N, text: string): SchemaTypes[N] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BeingsError("INVALID_JSON", `invalid JSON: ${(e as Error).message}`);
  }
  validate(name, parsed);
  return parsed;
}

const CHOICE_ID_RE = /^c[1-9][0-9]{0,2}$/;
const QUESTION_ID_RE = /^q[1-9][0-9]{0,2}$/;

/**
 * Checks the election file rules that JSON Schema cannot express. Returns a list of problems (empty = ok).
 * [PROPOSED] additions beyond the schema (each resolves an ambiguity, see README "Spec notes"):
 *  - question and choice IDs unique, and canonical (`q1`.. / `c1`.., no zero or leading zeros);
 *  - maxMarks <= number of choices;
 *  - emptyBelow <= markedAbove + 1 (the empty and marked bands must not overlap), including each
 *    optional consensusThresholds pair;
 *  - closesAt later than opensAt;
 *  - quorum <= number of listed deviceAddresses when that list is present;
 *  - every ballot code is a valid ballot code (already in the schema) and the election code's year is plausible.
 * Call after `validate("electionFile", file)`.
 */
export function electionFileProblems(e: ElectionFile, options: { requireLayoutHash?: boolean } = {}): string[] {
  const problems: string[] = [];
  if (options.requireLayoutHash && e.layoutHash === undefined) problems.push("layoutHash is missing (required for files made by the ballot generator)");
  const qids = new Set<string>();
  for (const q of e.questions) {
    if (!QUESTION_ID_RE.test(q.id)) problems.push(`question id "${q.id}" is not canonical (q1, q2, ...)`);
    if (qids.has(q.id)) problems.push(`duplicate question id ${q.id}`);
    qids.add(q.id);
    const cids = new Set<string>();
    for (const c of q.choices) {
      if (!CHOICE_ID_RE.test(c.id)) problems.push(`${q.id}: choice id "${c.id}" is not canonical (c1, c2, ...)`);
      if (cids.has(c.id)) problems.push(`${q.id}: duplicate choice id ${c.id}`);
      cids.add(c.id);
    }
    if (q.maxMarks > q.choices.length) problems.push(`${q.id}: maxMarks ${q.maxMarks} exceeds the number of choices`);
  }
  if (e.resultRules.emptyBelow > e.resultRules.markedAbove + 1) {
    problems.push("resultRules: emptyBelow must be <= markedAbove + 1 (empty and marked bands overlap)");
  }
  const bands = e.consensusThresholds;
  if (bands) {
    for (const name of ["tight", "standard", "loose"] as const) {
      const pair = bands[name];
      if (!pair) continue;
      if (pair.emptyBelow > pair.markedAbove + 1) {
        problems.push(`consensusThresholds.${name}: emptyBelow must be <= markedAbove + 1 (empty and marked bands overlap)`);
      }
    }
  }
  if (!(Date.parse(e.closesAt) > Date.parse(e.opensAt))) problems.push("closesAt must be later than opensAt");
  if (e.deviceAddresses && e.quorum > e.deviceAddresses.length) {
    problems.push("quorum is larger than the number of deviceAddresses");
  }
  return problems;
}

/**
 * Extra checks for a correction entry that the spec's correction schema leaves open (it types `electionCode`, `from`
 * and `to` as plain strings): election code format, and `from` / `to` must be valid result strings and differ.
 * [PROPOSED] Call after `validate("correction", c)`; `applyCorrections` enforces the same on `to`.
 */
export function correctionProblems(c: Correction): string[] {
  const problems: string[] = [];
  if (!ELECTION_CODE_RE.test(c.electionCode)) problems.push("electionCode is not a valid election code");
  for (const k of ["from", "to"] as const) {
    try {
      parseResult(c[k]);
    } catch {
      problems.push(`${k} is not a valid result string`);
    }
  }
  if (c.from === c.to) problems.push("from and to are identical");
  return problems;
}
