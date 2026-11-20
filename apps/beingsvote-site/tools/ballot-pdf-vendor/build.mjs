// Builds ../../public/vendor/ballot-gen.js: one self-contained ES module (pdf-lib + qrcode + ballot-gen's plan/render).
// Run from the repo root after `npm ci`: node apps/beingsvote-site/tools/ballot-pdf-vendor/build.mjs
// Not part of the Netlify build: the output is committed, like vendor/walletconnect.js.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../public/vendor/ballot-gen.js");
// plan.ts and render.ts only need BeingsError from @beings/core; point at that file so ajv and the schemas stay out.
const coreErrors = resolve(here, "../../../../packages/core/src/errors.ts");

await build({
  entryPoints: [resolve(here, "entry.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  legalComments: "none",
  outfile: out,
  alias: { "@beings/core": coreErrors },
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  logLevel: "info",
});
console.log("wrote", out);
