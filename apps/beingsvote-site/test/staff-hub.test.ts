// Staff hub cards: order, app tiles, and the scanner operator page. No network, no wallet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROLE_INFO, STAFF_HUB_ORDER } from "../public/js/roles.js";

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const bytes = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)));

describe("staff hub", () => {
  it("orders the cards and points each election role at its own tile", () => {
    expect(STAFF_HUB_ORDER).toEqual(["admin", "officer", "verifier", "scanner", "system"]);
    expect(STAFF_HUB_ORDER.map((id) => ROLE_INFO[id].label)).toEqual(["Election Administrator", "Election officer", "Verifier", "Scanner operator", "System admin"]);
    expect(ROLE_INFO.admin.route).toBe("#/admin");
    expect(ROLE_INFO.admin.mark.src).toBe("/brand/staff/election-admin-256.webp");
    expect(ROLE_INFO.admin.mark.alt).toMatch(/key, a ballot box and a crypto-wallet/);
    expect(ROLE_INFO.officer.mark.src).toBe("/brand/staff/election-officer-256.webp");
    expect(ROLE_INFO.officer.mark.alt).toMatch(/magnifying glass/);
    expect(ROLE_INFO.verifier.mark.src).toBe("/brand/staff/verifier-256.webp");
    expect(ROLE_INFO.verifier.mark.alt).toMatch(/shield in a hexagon network/);
    expect(ROLE_INFO.scanner.mark.src).toBe("/brand/staff/scanner-operator-256.webp");
    expect(ROLE_INFO.scanner.blurb).toBe("Runs the scanner helper, feeds ballot batches through the scanner and signs each batch for the ledger. Never changes a ballot.");
    expect(ROLE_INFO.scanner.route).toBe("#/scanner");
    expect(ROLE_INFO.system.mark).toBeUndefined();
    expect(ROLE_INFO.system.icon).toBe("gear");
    expect(ROLE_INFO.system.blurb).toBe("Sets up and monitors local resources and connections: scanner computers and helpers, printers, and the network and image-service connections. Has no authority over ballot choices or certification.");
  });

  it("keeps System admin on the outline icon and serves a small WebP tile for the others", () => {
    const hub = src("../public/js/staff.js");
    expect(hub).toMatch(/STAFF_HUB_ORDER\.map/);
    expect(hub).toMatch(/title: info\.blurb/);
    expect(hub).toMatch(/class: "staff-grid"/);
    expect(hub).not.toMatch(/\["verifier", "officer", "admin", "system"\]/);
    for (const file of ["election-admin", "election-officer", "verifier", "scanner-operator"]) {
      for (const size of [128, 256]) {
        const buf = bytes(`../public/brand/staff/${file}-${size}.webp`);
        expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(buf.subarray(8, 12).toString("ascii")).toBe("WEBP");
        expect(buf.length).toBeLessThan(20_000);
      }
    }
    expect(src("../public/js/app.js")).toMatch(/"\/scanner": renderScanner/);
    expect(src("../public/css/app.css")).toMatch(/\.staff-grid \{[^}]*grid-template-columns: 1fr/);
    expect(src("../public/css/app.css")).toMatch(/min-width: 700px\) \{ \.staff-grid \{ grid-template-columns: repeat\(3/);
  });
});
