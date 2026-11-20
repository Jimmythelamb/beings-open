// Builds ../../public/vendor/appkit.js (one self-contained ES module). Run: npm ci && npm run build.
// Not part of the Netlify build: the output is committed. ethers stays outside the bundle.
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../public/vendor/appkit.js");

// Desktop AppKit shows the QR on its own screen and the wallet list on another. The site needs both at once:
// the QR immediately, with Bifrost and MetaMask (featuredWalletIds) beside it, and All wallets one step away.
const BASIC = "w3m-connecting-wc-basic-view/index.js";
const DESKTOP_QR = `return html \`<wui-flex flexDirection="column" .padding=\${['0', '0', '4', '0']}>
        <w3m-connecting-wc-view ?basic=\${true} .displayBranding=\${false}></w3m-connecting-wc-view>
        <wui-flex flexDirection="column" .padding=\${['0', '3', '0', '3']}>
          <w3m-all-wallets-widget></w3m-all-wallets-widget>
        </wui-flex>
      </wui-flex>`;
const DESKTOP_BESIDE = `return html \`<wui-flex class="beings-wc" flexDirection="row" alignItems="stretch" .padding=\${['2', '3', '3', '3']} gap="4">
        <w3m-connecting-wc-view ?basic=\${true} .displayBranding=\${false}></w3m-connecting-wc-view>
        <wui-flex class="beings-wc-list" flexDirection="column" gap="2">
          <w3m-connector-list></w3m-connector-list>
          <w3m-all-wallets-widget></w3m-all-wallets-widget>
        </wui-flex>
      </wui-flex>`;
// Room for the QR and the wallet names plus their tags (QR CODE, the search count).
// Below 900px the list stacks under the QR so an iPad portrait does not clip those tags.
const BESIDE_STYLES = `W3mConnectingWcBasicView.styles = css\`
  .beings-wc {
    width: 100% !important;
    max-width: 100%;
    box-sizing: border-box;
    align-items: stretch !important;
    justify-content: flex-start !important;
    flex-direction: row !important;
  }
  .beings-wc > w3m-connecting-wc-view {
    flex: 0 0 300px !important;
    width: 300px;
    max-width: 100%;
  }
  .beings-wc > .beings-wc-list {
    flex: 1 1 420px !important;
    min-width: 360px;
    width: auto;
  }
  @media (max-width: 900px) {
    .beings-wc { flex-direction: column !important; }
    .beings-wc > w3m-connecting-wc-view,
    .beings-wc > .beings-wc-list {
      flex: 1 1 auto !important;
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100%;
    }
  }
\`;`;

// Coinbase, Base Account and AppKit Pay are not used (email, social, swaps and onramp are off).
// Their dynamic imports otherwise pull viem's entire chain list into this file.
const stub = (name) => `export default {}; export function createBaseAccountSDK(){ throw new Error(${JSON.stringify(name + " is not included in this build.")}); } export class CoinbaseWalletSDK { constructor(){ throw new Error(${JSON.stringify(name + " is not included in this build.")}); } }`;

const qrBesideWallets = {
  name: "qr-beside-wallets",
  setup(b) {
    b.onResolve({ filter: /^viem$/ }, () => ({ path: resolve(here, "viem-slim.js") }));
    b.onResolve({ filter: /^@coinbase\/wallet-sdk$/ }, () => ({ path: "coinbase-stub", namespace: "beings-stub" }));
    b.onResolve({ filter: /^@base-org\/account$/ }, () => ({ path: "base-stub", namespace: "beings-stub" }));
    b.onLoad({ filter: /.*/, namespace: "beings-stub" }, (args) => ({ contents: stub(args.path), loader: "js" }));
    b.onLoad({ filter: /appkit-ui\/dist\/esm\/src\/utils\/ThemeUtil\.js$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      const needle = "--apkt-modal-width: 370px;";
      if (!src.includes(needle)) throw new Error("AppKit modal width changed. Update the width patch in tools/appkit-vendor/build.mjs.");
      return { contents: src.replace(needle, "--apkt-modal-width: min(960px, calc(100vw - 2rem));"), loader: "js" };
    });
    // A wallet's own connecting screen (Bifrost, WalletConnect "QR CODE", and the rest) uses the
    // same QR component as the first screen, but it is no longer inside the 300px column. Cap the
    // box only. The modal stays wide so the wallet list is not clipped.
    b.onLoad({ filter: /w3m-connecting-wc-qrcode\/styles\.js$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      const needle = "export default css `";
      if (!src.includes(needle)) throw new Error("AppKit QR styles changed. Update the QR cap in tools/appkit-vendor/build.mjs.");
      const cap = `${needle}
  wui-shimmer,
  wui-qr-code {
    box-sizing: border-box !important;
    width: min(300px, 45vh) !important;
    height: min(300px, 45vh) !important;
    max-width: min(300px, 45vh) !important;
    max-height: min(300px, 45vh) !important;
    flex: none !important;
  }
`;
      return { contents: src.replace(needle, cap), loader: "js" };
    });
    b.onLoad({ filter: /w3m-modal\/styles\.js$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      const needle = "export default css `";
      if (!src.includes(needle)) throw new Error("AppKit modal styles changed. Update the scroll patch in tools/appkit-vendor/build.mjs.");
      const scroll = `${needle}
  wui-card {
    max-height: calc(100dvh - 2rem);
    overflow-y: auto;
  }
`;
      return { contents: src.replace(needle, scroll), loader: "js" };
    });
    b.onLoad({ filter: /w3m-connecting-wc-basic-view\/index\.js$/ }, async (args) => {
      let src = await readFile(args.path, "utf8");
      if (!src.includes(DESKTOP_QR)) {
        throw new Error(`AppKit ${BASIC} layout changed. Update the desktop QR patch in tools/appkit-vendor/build.mjs.`);
      }
      if (!src.includes('import { LitElement, html } from \'lit\';')) {
        throw new Error("AppKit basic view import changed. Update the style patch in tools/appkit-vendor/build.mjs.");
      }
      src = src.replace("import { LitElement, html } from 'lit';", "import { LitElement, html, css } from 'lit';");
      src = src.replace(DESKTOP_QR, DESKTOP_BESIDE);
      const define = "W3mConnectingWcBasicView = __decorate([\n    customElement('w3m-connecting-wc-basic-view')";
      if (!src.includes(define)) throw new Error("AppKit basic view registration changed. Update the style patch in tools/appkit-vendor/build.mjs.");
      src = src.replace(define, `${BESIDE_STYLES}\n${define}`);
      return { contents: src, loader: "js" };
    });
  },
};

const r = await build({
  entryPoints: [resolve(here, "entry.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  outfile: out,
  plugins: [qrBesideWallets],
  alias: { ethers: resolve(here, "ethers-shim.js") },
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  logLevel: "info",
  metafile: true,
});
const bytes = r.metafile.outputs[Object.keys(r.metafile.outputs)[0]]?.bytes ?? 0;
console.log("wrote", out, `${Math.round(bytes / 1024)} KiB`);
