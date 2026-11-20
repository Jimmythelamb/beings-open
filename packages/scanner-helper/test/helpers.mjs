import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A real, tiny greyscale PNG. `seed` changes the pixels so each page has different bytes. */
export function makePng(width, height, seed = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width + 1) * height, 255);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  raw[1 + (seed % width)] = seed % 256;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
export const sha = (b) => createHash("sha256").update(b).digest("hex");

export const CODE = "BEINGS-2026-TSTAAA";
export function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "beings-batch-test-"));
}
/**
 * Write a batch folder like Scan-BeingsBatch.ps1 does.
 * pages: number saved; expected; state; seeds: per-page seeds (to force duplicates); size [w,h]
 */
export function writeBatch(electionDir, batchId, { pages = 3, expected = pages, state = "CAPTURED", seeds, size = [85, 140], sizes, dpi = 10, pageSize = "Legal", electionCode = CODE, imageSource } = {}) {
  const dir = join(electionDir, batchId);
  mkdirSync(dir, { recursive: true });
  const list = [];
  for (let i = 1; i <= pages; i++) {
    const [w, h] = sizes?.[i - 1] ?? size;
    const buf = imageSource ? imageSource(i) : makePng(w, h, seeds?.[i - 1] ?? i + batchId.length * 7 + Number(batchId.slice(-6)));
    const file = `page-${String(i).padStart(2, "0")}.png`;
    writeFileSync(join(dir, file), buf);
    list.push({ index: i, file, bytes: buf.length, sha256: sha(buf), width: w, height: h, savedAt: "2026-11-09T20:30:00-08:00" });
  }
  const manifest = { schema: "beings-scan-batch/1", electionCode, batchId, expectedPages: expected, operatorCountConfirmed: true, dpi, colorMode: "Color", pageSize, device: { name: "Test scanner", deviceId: "x", connection: "network" }, startedAt: "2026-11-09T20:29:54-08:00", endedAt: "2026-11-09T20:31:00-08:00", state, stateReason: null, pages: list };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}
