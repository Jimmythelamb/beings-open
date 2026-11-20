// Tiny shared flag parser for the verifier CLIs.
export function parseFlags(argv: string[]): Record<string, string | true> {
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

export const intFlag = (a: Record<string, string | true>, k: string): number | undefined => {
  const v = a[k];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isSafeInteger(n) || n < 0) throw new Error(`--${k} must be a whole number`);
  return n;
};
