import { readFileSync } from "node:fs";
import * as Ajv2020Module from "ajv/dist/2020.js";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { BeingsError } from "@beings/core";
import type { BallotLayout } from "./plan.js";

const schema = JSON.parse(readFileSync(new URL("../schemas/ballot-layout.schema.json", import.meta.url), "utf8")) as object;
// ajv is CommonJS: the class may be the module, a named export, or under `.default` depending on the loader.
function unwrap(mod: unknown): typeof Ajv2020Class {
  let m = mod as Record<string, unknown>;
  for (let i = 0; i < 3; i++) {
    if (typeof m === "function") return m as unknown as typeof Ajv2020Class;
    if (typeof m["Ajv2020"] === "function") return m["Ajv2020"] as typeof Ajv2020Class;
    m = m["default"] as Record<string, unknown>;
  }
  throw new BeingsError("BAD_INPUT", "could not load ajv");
}
const ajv = new (unwrap(Ajv2020Module))({ allErrors: true, strict: true });
const check = ajv.compile<BallotLayout>(schema);

/** Throws BeingsError (SCHEMA_MISMATCH) when `json` is not a valid ballot layout (IC2, PROPOSED). */
export function validateLayout(json: unknown): asserts json is BallotLayout {
  if (!check(json)) {
    const first = (check.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).slice(0, 5);
    throw new BeingsError("SCHEMA_MISMATCH", `ballot layout does not match its schema: ${first.join("; ")}`);
  }
}

export function isValidLayout(json: unknown): json is BallotLayout {
  return check(json) as boolean;
}
