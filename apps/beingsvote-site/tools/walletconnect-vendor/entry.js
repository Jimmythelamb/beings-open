// Entry point for the vendored WalletConnect bundle (public/vendor/walletconnect.js). See README.md in this folder.
// Exports only what the site uses: the WalletConnect EIP-1193 provider (with its own modal switched off, the site draws
// its own QR dialog that fits the strict CSP) and a QR-code matrix generator.
import { EthereumProvider } from "@walletconnect/ethereum-provider";
import qrcode from "qrcode-generator";

export { EthereumProvider };

/** QR code for `text` as an array of rows of booleans (true = dark module). Error correction "M" is plenty for a pairing link. */
export function qrMatrix(text) {
  const qr = qrcode(0, "M"); // type 0 = pick the smallest version that fits
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}
