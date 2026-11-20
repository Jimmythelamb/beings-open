import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { csprng, type ElectionFile, type RandomBytes } from "@beings/core";

export const SAMPLE_PATH = new URL("../sample/classroom-election.json", import.meta.url);
export const sampleElection = (): Record<string, unknown> => JSON.parse(readFileSync(SAMPLE_PATH, "utf8")) as Record<string, unknown>;

export const hasPoppler = ((): boolean => {
  const a = spawnSync("pdftoppm", ["-v"]);
  const b = spawnSync("pdftotext", ["-v"]);
  return a.error === undefined && b.error === undefined;
})();

/** A deterministic (NOT secure) byte source, for tests only. */
export function seededRng(seed: number): RandomBytes {
  let s = seed >>> 0 || 1;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      out[i] = s & 255;
    }
    return out;
  };
}
export const realRng = csprng;

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "beings-ballot-test-"));
}

export function writePdf(bytes: Uint8Array): string {
  const f = join(tmpDir(), "b.pdf");
  writeFileSync(f, bytes);
  return f;
}

export function renderPage(pdf: string, page: number, dpi: number): PNG {
  const base = join(tmpDir(), "p");
  execFileSync("pdftoppm", ["-png", "-r", String(dpi), "-f", String(page), "-l", String(page), "-singlefile", pdf, base]);
  return PNG.sync.read(readFileSync(base + ".png"));
}

export function pdfText(pdf: string, page: number): string {
  return execFileSync("pdftotext", ["-f", String(page), "-l", String(page), "-layout", pdf, "-"], { encoding: "utf8" });
}

/** Text below page y `fromPt` (PDF points from the top). */
export function pdfTextCrop(pdf: string, page: number, fromPt: number): string {
  return execFileSync("pdftotext", ["-f", String(page), "-l", String(page), "-y", String(fromPt), "-x", "0", "-W", "612", "-H", String(792 - fromPt), "-layout", pdf, "-"], { encoding: "utf8" });
}

/** Grey value (0 black .. 255 white) at a pixel. */
export function grey(png: PNG, x: number, y: number): number {
  const i = (png.width * y + x) * 4;
  return Math.round(((png.data[i] as number) + (png.data[i + 1] as number) + (png.data[i + 2] as number)) / 3);
}

/** Bounding box in mm of pixels darker than `threshold` inside a window given in mm. */
export function darkBoxMm(png: PNG, dpi: number, win: { x0: number; y0: number; x1: number; y1: number }, threshold: number): { x0: number; y0: number; x1: number; y1: number } | null {
  const px = dpi / 25.4;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = Math.floor(win.y0 * px); y < Math.ceil(win.y1 * px); y++) {
    for (let x = Math.floor(win.x0 * px); x < Math.ceil(win.x1 * px); x++) {
      if (grey(png, x, y) < threshold) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
      }
    }
  }
  return x1 < 0 ? null : { x0: x0 / px, y0: y0 / px, x1: x1 / px, y1: y1 / px };
}

export type Election = ElectionFile;
