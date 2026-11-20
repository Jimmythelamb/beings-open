// Builds ../../public/vendor/walletconnect.js (one self-contained ES module, no network access at runtime other than
// the WalletConnect relay). Run: npm ci && npm run build. Not part of the Netlify build: the output is committed.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../public/vendor/walletconnect.js");

// The provider can lazily import Reown AppKit for its own pop-up modal. We never use it (showQrModal is false and the
// site draws its own QR dialog), and it needs inline styles that the site's CSP forbids, so it is replaced by a stub.
const noModal = {
  name: "no-modal",
  setup(b) {
    b.onResolve({ filter: /^@reown\/appkit(\/.*)?$/ }, () => ({ path: "no-modal", namespace: "no-modal" }));
    b.onLoad({ filter: /.*/, namespace: "no-modal" }, () => ({
      contents: 'export default {}; export const createAppKit = () => { throw new Error("The WalletConnect pop-up is not included in this build."); };',
      loader: "js",
    }));
  },
};

const r = await build({
  entryPoints: [resolve(here, "entry.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  legalComments: "none",
  outfile: out,
  plugins: [noModal],
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  logLevel: "info",
  metafile: true,
});
console.log("wrote", out);
