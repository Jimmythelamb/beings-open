// Help notes ("?" buttons): every key used in the pages has text, every text is used, the toggle is accessible,
// and the app fingerprint field accepts values with or without 0x. No network, no wallet.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeAppFingerprint, normHash } from "../public/js/logic.js";

const jsDir = fileURLToPath(new URL("../public/js/", import.meta.url));
const sources = Object.fromEntries(readdirSync(jsDir).filter((f) => f.endsWith(".js")).map((f) => [f, readFileSync(jsDir + f, "utf8")]));

// A very small stand-in for the DOM, enough for ui.h/icon and help.js.
class FakeEl {
  tagName: string;
  attrs: Record<string, string> = {};
  children: any[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  className = "";
  hidden = false;
  style: any = {};
  dataset: any = {};
  focused = false;
  textContent = "";
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    if (k === "hidden") this.hidden = true;
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  append(...c: any[]) {
    this.children.push(...c);
  }
  appendChild(c: any) {
    this.children.push(c);
    return c;
  }
  addEventListener(t: string, fn: (e: any) => void) {
    (this.listeners[t] ??= []).push(fn);
  }
  fire(t: string, e: any = {}) {
    for (const fn of this.listeners[t] ?? []) fn({ stopPropagation() {}, ...e });
  }
  focus() {
    this.focused = true;
  }
  querySelector(sel: string): any {
    const cls = sel.replace(/^\./, "");
    for (const c of this.children) {
      if (c instanceof FakeEl) {
        if (c.className.split(" ").includes(cls)) return c;
        const deep = c.querySelector(sel);
        if (deep) return deep;
      }
    }
    return null;
  }
}
let help: typeof import("../public/js/help.js");
beforeAll(async () => {
  (globalThis as any).Node = FakeEl;
  (globalThis as any).document = { createElement: (t: string) => new FakeEl(t), createElementNS: (_: string, t: string) => new FakeEl(t), createTextNode: (s: string) => Object.assign(new FakeEl("#text"), { textContent: s }) };
  help = await import("../public/js/help.js");
});
afterAll(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).Node;
});

function usedKeys() {
  const keys = new Map<string, string>();
  const patterns = [/help:\s*"([a-zA-Z.]+)"/g, /(?:labelWithHelp|headingWithHelp)\([^;]*?"([a-z]+\.[a-zA-Z]+)"\)/g, /helpToggle\("([a-zA-Z.]+)"/g];
  for (const [file, src] of Object.entries(sources)) {
    if (file === "help.js") continue;
    for (const re of patterns) for (const m of src.matchAll(re)) keys.set(m[1]!, file);
  }
  return keys;
}

describe("help text", () => {
  it("has text for every key a page uses", () => {
    const used = usedKeys();
    expect(used.size).toBeGreaterThan(25);
    for (const [key, file] of used) expect(help.helpText(key), `${key} used in ${file}`).toBeTruthy();
  });

  it("uses every help text somewhere", () => {
    const used = usedKeys();
    for (const key of Object.keys(help.HELP_TEXT)) expect(used.has(key), key).toBe(true);
  });

  it("is short, plain sentences", () => {
    for (const [key, text] of Object.entries(help.HELP_TEXT)) {
      expect(text.length, key).toBeGreaterThan(30);
      expect(text.length, key).toBeLessThan(330);
      expect(text.trim().endsWith(".") || text.trim().endsWith("optional."), key).toBe(true);
      expect(text, key).not.toMatch(/undefined|TODO|<[a-z]/i);
    }
  });

  it("covers every input of the create form", () => {
    const admin = sources["admin.js"];
    for (const id of ["c-code", "c-name", "c-open", "c-close", "c-reg", "c-spare", "c-quorum", "c-days", "c-layout", "c-apps", "c-cid"]) expect(admin, id).toMatch(new RegExp(`field\\(\\{ id: "${id}", help: "create\\.`));
  });

  it("covers the confusing spots named by the organizer", () => {
    const want = ["check.ballot", "check.results", "results.counts", "admin.device", "admin.appFingerprint", "create.layout", "printed.schedule", "printed.fullVsPublic", "printed.manifest", "create.files"];
    const used = usedKeys();
    for (const k of want) expect(used.has(k), k).toBe(true);
  });

  it("returns null for an unknown key and never reads the prototype", () => {
    expect(help.helpText("nope")).toBeNull();
    expect(help.helpText("toString")).toBeNull();
    expect(help.helpToggle("nope").button).toBeNull();
  });
});

describe("help toggle", () => {
  it("is a disclosure button: aria-expanded, aria-controls, hidden panel", () => {
    const { button, panel } = help.helpToggle("create.layout", { label: "layout" }) as any;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
    expect(panel.hidden).toBe(true);
    button.fire("click");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    button.fire("click");
    expect(panel.hidden).toBe(true);
  });

  it("closes on Escape and on 'Got it', returning focus to the button", () => {
    const { button, panel } = help.helpToggle("check.ballot") as any;
    button.fire("click");
    panel.fire("keydown", { key: "Escape" });
    expect(panel.hidden).toBe(true);
    expect(button.focused).toBe(true);
    button.fire("click");
    panel.querySelector(".help-close").fire("click");
    expect(panel.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("gives every toggle a unique panel id", () => {
    const a = help.helpToggle("create.name") as any;
    const b = help.helpToggle("create.name") as any;
    expect(a.panel.getAttribute("id")).not.toBe(b.panel.getAttribute("id"));
  });

  it("labels the button for screen readers", () => {
    const { button } = help.helpToggle("create.days", { label: "Keep ballot images for" }) as any;
    const sr = button.children.find((c: any) => c.className === "sr-only");
    expect(sr.children.map((c: any) => c.textContent).join("")).toContain("Keep ballot images for");
  });
});

describe("home page create button", () => {
  it("links to the admin create form, which opens on new=1", async () => {
    const home = await import("../public/js/home.js");
    expect(home.CREATE_ELECTION_HREF).toBe("#/admin?new=1");
    expect(sources["home.js"]).toContain("Create Your Election Here");
    expect(sources["home.js"]).toContain("Running an election for your classroom or school?");
    expect(sources["home.js"]).not.toContain("Running a vote for your class or group?");
    expect(sources["app.js"]).toMatch(/getElementById\("header-promo"\)\?\.replaceChildren\(createBanner\(\)\)/);
    expect(sources["admin.js"]).toMatch(/query\.get\("new"\) === "1"/);
    const html = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
    expect(html).toContain('aria-label="B.E.I.N.G.S. logo"');
    expect(html).toMatch(/<video[^>]*autoplay[^>]*muted[^>]*loop[^>]*playsinline/);
    expect(html).not.toContain("Nothing here decides a real election yet.");
    expect(sources["home.js"]).toContain("Nothing here decides a real election yet.");
    expect(sources["app.js"]).not.toMatch(/badge\("Public"/);
    expect(sources["app.js"]).not.toMatch(/badge\("Voter"/);
  });
});

describe("app fingerprint with or without 0x", () => {
  const bare = "06694fe1cdf4766e89d713efca9c78dcf82f413b8de2907fff946aa895695527";
  it("accepts bare, 0x, upper case and spaces", () => {
    for (const v of [bare, `0x${bare}`, `0X${bare.toUpperCase()}`, `  ${bare}  `, `0x${bare.toUpperCase()}`]) expect(normalizeAppFingerprint(v)).toBe(`0x${bare}`);
  });
  it("refuses wrong lengths and non-hex", () => {
    for (const v of ["", "0x", bare.slice(1), `${bare}00`, `0x${"g".repeat(64)}`, null, undefined, 12]) expect(normalizeAppFingerprint(v as any)).toBeNull();
  });
  it("the Register Scanner/Printer button uses it, so a bare value is sent with 0x", () => {
    expect(sources["admin.js"]).toMatch(/normalizeAppFingerprint\(appPaste\.value\)/);
    expect(sources["admin.js"]).toMatch(/registerStationPlan\(\{ address: address\(\), appHash: app\(\)/);
    expect(sources["fingerprints.js"]).toMatch(/const app = with0x\(appHash\)/);
  });
  it("layout fingerprint with 0x is stored bare, the same as before (now chosen by resolveCreateFingerprints)", () => {
    expect(normHash(`0x${bare}`)).toBe(bare);
    expect(sources["admin.js"]).toMatch(/resolveCreateFingerprints\(\{ designedLayoutHash: designed\?\.layoutHash, layoutOverride: layoutInput\.value/);
  });
});
