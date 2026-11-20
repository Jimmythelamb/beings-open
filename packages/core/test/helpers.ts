import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function readJson<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(join(root, rel), "utf8")) as T;
}
export const spec = <T = unknown>(name: string) => readJson<T>(`test-vectors/spec-examples/${name}.json`);
export const vector = <T = unknown>(name: string) => readJson<T>(`test-vectors/${name}.json`);
export const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
