import { describe, expect, it } from "vitest";
import { BeingsError, canonicalBytes, canonicalize, parseCanonical } from "../src/index.js";

describe("canonicalize (RFC 8785 JCS)", () => {
  it("sorts object keys and keeps array order", () => {
    expect(canonicalize({ b: 2, a: 1, c: [3, 1, 2] })).toBe('{"a":1,"b":2,"c":[3,1,2]}');
  });

  it("sorts keys by UTF-16 code units (RFC 8785 section 3.2.3 example)", () => {
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    // JSON.parse would move integer-like keys first, so compare the canonical text itself
    const expected = [
      ["\r", "Carriage Return"],
      ["1", "One"],
      ["\u0080", "Control"],
      ["\u00f6", "Latin Small Letter O With Diaeresis"],
      ["\u20ac", "Euro Sign"],
      ["\ud83d\ude00", "Emoji: Grinning Face"],
      ["\ufb33", "Hebrew Letter Dalet With Dagesh"],
    ];
    const text = "{" + expected.map(([k, v]) => `${canonicalize(k)}:${canonicalize(v)}`).join(",") + "}";
    expect(canonicalize(input)).toBe(text);
  });

  it("serializes numbers per ECMAScript (RFC 8785 appendix B samples)", () => {
    const cases: [number, string][] = [
      [0, "0"],
      [-0, "0"],
      [1, "1"],
      [-1.5, "-1.5"],
      [1e21, "1e+21"],
      [1e-7, "1e-7"],
      [0.000001, "0.000001"],
      [123456789012345680000, "123456789012345680000"],
      [9007199254740991, "9007199254740991"],
      [5e-324, "5e-324"],
      [1.7976931348623157e308, "1.7976931348623157e+308"],
      [333333333.3333333, "333333333.3333333"],
      [1424953923781206.2, "1424953923781206.2"],
    ];
    for (const [n, s] of cases) expect(canonicalize(n)).toBe(s);
  });

  it("escapes strings the JCS way", () => {
    expect(canonicalize("a\nb\t\"\\")).toBe('"a\\nb\\t\\"\\\\"');
    expect(canonicalize("\u0007\u001f")).toBe('"\\u0007\\u001f"');
    expect(canonicalize("\b\f\r")).toBe('"\\b\\f\\r"');
    expect(canonicalize("\u007f</script>\u2028")).toBe('"\u007f</script>\u2028"'); // not escaped
  });

  it("handles literals and nesting", () => {
    expect(canonicalize({ z: null, y: true, x: false, w: [], v: {} })).toBe('{"v":{},"w":[],"x":false,"y":true,"z":null}');
  });

  it("ignores insertion order", () => {
    expect(canonicalize({ a: { y: 1, x: 2 }, b: 1 })).toBe(canonicalize({ b: 1, a: { x: 2, y: 1 } }));
  });

  it("encodes to UTF-8 bytes", () => {
    expect(Array.from(canonicalBytes("\u20ac"))).toEqual([0x22, 0xe2, 0x82, 0xac, 0x22]);
  });

  it("fails closed on values JSON cannot represent", () => {
    const bad: unknown[] = [NaN, Infinity, -Infinity, undefined, 10n, () => 1, Symbol("x"), { a: undefined }, [undefined], new Date(0), new Map(), "\ud800", { "\udc00": 1 }, [1, , 3]];
    for (const v of bad) expect(() => canonicalize(v), String(v)).toThrow(BeingsError);
  });

  it("rejects cycles", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => canonicalize(a)).toThrow(/cycl/i);
  });

  it("accepts a shared (non-circular) reference twice", () => {
    const shared = { k: 1 };
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});

describe("parseCanonical", () => {
  it("accepts text that is already canonical", () => {
    expect(parseCanonical('{"a":1,"b":[true,null]}')).toEqual({ a: 1, b: [true, null] });
  });
  it("rejects valid JSON that is not canonical", () => {
    for (const t of ['{"b":1,"a":2}', '{"a": 1}', "[1.0]", '{"a":1}\n']) {
      expect(() => parseCanonical(t), t).toThrowError(expect.objectContaining({ code: "NON_CANONICAL" }));
    }
  });
  it("rejects invalid JSON", () => {
    expect(() => parseCanonical("{")).toThrowError(expect.objectContaining({ code: "INVALID_JSON" }));
  });
});
