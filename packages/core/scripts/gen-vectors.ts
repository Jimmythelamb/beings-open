import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVectors } from "./vectors.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test-vectors");
mkdirSync(dir, { recursive: true });
const vectors = await buildVectors();
for (const [name, value] of Object.entries(vectors)) {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
  console.log(`wrote test-vectors/${name}.json`);
}
