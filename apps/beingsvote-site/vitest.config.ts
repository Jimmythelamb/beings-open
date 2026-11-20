import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The site ships alone. In the monorepo, verifier tests import the package name @beings/core.
// Alias that name to the real hash/code modules (not the schema entrypoint, which needs ajv).
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const coreHash = fileURLToPath(new URL("../../packages/core/src/hash.ts", import.meta.url));
const coreShim = fileURLToPath(new URL("./test/shims/beings-core.ts", import.meta.url));

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
  resolve: { alias: existsSync(coreHash) ? [{ find: /^@beings\/core$/, replacement: coreShim }] : [] },
  server: { fs: { allow: [repoRoot] } },
});
