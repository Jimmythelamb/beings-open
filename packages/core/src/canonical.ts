import { BeingsError } from "./errors.js";

/**
 * RFC 8785 (JSON Canonicalization Scheme, JCS).
 *
 * - Object keys sorted by UTF-16 code units (the default JS string order, as RFC 8785 requires).
 * - Numbers serialized with the ECMAScript Number-to-String algorithm (what JSON.stringify uses),
 *   which is exactly what RFC 8785 section 3.2.2.3 mandates. -0 becomes "0".
 * - Strings escaped as JSON.stringify does (RFC 8785 section 3.2.2.2).
 * - No insignificant whitespace.
 *
 * Fail closed: NaN, Infinity, undefined, bigint, functions, symbols, class instances (Date, Map...),
 * cyclic structures and lone UTF-16 surrogates all THROW instead of being dropped or coerced.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new Set<object>());
}

const encoder = new TextEncoder();

/** UTF-8 bytes of the canonical form: the exact bytes that get hashed or signed. */
export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value));
}

/**
 * Parse JSON text and require that the text IS already in canonical form.
 * Throws INVALID_JSON for unparseable text and NON_CANONICAL for any other difference.
 * (JSON.parse cannot detect duplicate object keys; they would be caught as NON_CANONICAL only if
 * the surviving key order/values differ from the text. Callers needing duplicate-key rejection
 * must use a strict parser upstream. TODO.)
 */
export function parseCanonical(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BeingsError("INVALID_JSON", `invalid JSON: ${(e as Error).message}`);
  }
  if (canonicalize(parsed) !== text) {
    throw new BeingsError("NON_CANONICAL", "JSON text is not in RFC 8785 canonical form");
  }
  return parsed;
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function serializeString(s: string): string {
  if (hasLoneSurrogate(s)) {
    throw new BeingsError("BAD_INPUT", "string contains a lone UTF-16 surrogate (invalid Unicode)");
  }
  return JSON.stringify(s);
}

function serialize(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new BeingsError("BAD_INPUT", "NaN and Infinity cannot be represented in JSON");
      }
      return JSON.stringify(value);
    case "string":
      return serializeString(value);
    case "object":
      break;
    default:
      throw new BeingsError("BAD_INPUT", `cannot canonicalize a value of type ${typeof value}`);
  }

  const obj = value as object;
  if (stack.has(obj)) throw new BeingsError("BAD_INPUT", "cyclic structure cannot be canonicalized");
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) throw new BeingsError("BAD_INPUT", "sparse array cannot be canonicalized");
        parts.push(serialize(obj[i], stack));
      }
      return `[${parts.join(",")}]`;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new BeingsError("BAD_INPUT", "only plain objects, arrays and JSON primitives can be canonicalized");
    }
    const keys = Object.keys(obj).sort(); // default sort = UTF-16 code unit order, as RFC 8785 requires
    const parts: string[] = [];
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (v === undefined) {
        throw new BeingsError("BAD_INPUT", `property "${k}" is undefined; remove it explicitly`);
      }
      parts.push(`${serializeString(k)}:${serialize(v, stack)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(obj);
  }
}
