// Create-election landing: header scrolls away, Start here sits at the top. No network.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clearStartHereView, createLinkAlreadyHere, motionReduced, revealStartHere } from "../public/js/start-here.js";

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

function fakeDoc() {
  const classes = new Set();
  const el = {
    style: {} as { scrollMarginTop?: string },
    classList: { add(c: string) { classes.add(c); }, remove(c: string) { classes.delete(c); }, has: (c: string) => classes.has(c) },
    offsetHeight: 10,
    getBoundingClientRect() { return { top: 400 }; },
    querySelector() { return button; },
  };
  const button = { tab: "", focused: false, setAttribute(_k: string, v: string) { this.tab = v; }, focus() { this.focused = true; } };
  const html = { classList: { add(c: string) { classes.add("html:" + c); }, remove(c: string) { classes.delete("html:" + c); }, has: (c: string) => classes.has("html:" + c) } };
  const doc = {
    documentElement: html,
    getElementById(id: string) { return id === "start-here" ? el : null; },
  };
  return { doc, el, button, html };
}

describe("revealStartHere", () => {
  it("unsticks the header and smoothly scrolls Start here to the top", () => {
    const { doc, el, button, html } = fakeDoc();
    const win = { matchMedia: () => ({ matches: false }), setTimeout: () => 0, scrollY: 120, scrolled: null as any, scrollTo(opts: any) { this.scrolled = opts; } };
    const behavior = revealStartHere({ doc: doc as any, win });
    expect(behavior).toBe("smooth");
    expect(html.classList.has("start-here-view")).toBe(true);
    expect(win.scrolled).toEqual({ top: 520, left: 0, behavior: "smooth" });
    expect(el.style.scrollMarginTop).toBe("0px");
    expect(button.focused).toBe(true);
    expect(el.classList.has("start-here-flash")).toBe(true);
  });

  it("jumps when the person prefers reduced motion", () => {
    const { doc } = fakeDoc();
    const win = { matchMedia: () => ({ matches: true }), scrollY: 0, scrolled: null as any, scrollTo(opts: any) { this.scrolled = opts; } };
    expect(motionReduced(win as any)).toBe(true);
    const behavior = revealStartHere({ doc: doc as any, win });
    expect(behavior).toBe("auto");
    expect(win.scrolled.behavior).toBe("auto");
  });

  it("does nothing when the section is missing, and leaving the page restores the header", () => {
    const { doc, html } = fakeDoc();
    doc.getElementById = () => null;
    expect(revealStartHere({ doc: doc as any, win: {} })).toBe(false);
    html.classList.add("start-here-view");
    clearStartHereView(doc as any);
    expect(html.classList.has("start-here-view")).toBe(false);
  });

  it("a second click on the create link, already on that page, scrolls again instead of reloading", () => {
    const button = { closest: () => button };
    const win = { location: { hash: "#/admin?new=1" }, document: { getElementById: () => ({}) } };
    expect(createLinkAlreadyHere({ target: { closest: () => button } }, win as any)).toBe(true);
    expect(createLinkAlreadyHere({ target: { closest: () => null } }, win as any)).toBe(false);
    expect(createLinkAlreadyHere({ target: { closest: () => button } }, { location: { hash: "#/" }, document: win.document } as any)).toBe(false);
  });

  it("the create form is the Start here section, and the sticky header is released for that view", () => {
    const admin = src("../public/js/admin.js");
    const css = src("../public/css/app.css");
    const app = src("../public/js/app.js");
    expect(admin).toMatch(/id: "start-here"/);
    expect(admin).toContain("Start here");
    expect(admin).toContain("Create a new election");
    expect(admin).toMatch(/revealStartHere\(\)/);
    expect(admin).not.toMatch(/scrollIntoView/);
    expect(css).toMatch(/html\.start-here-view \.site-header \{ position: static; \}/);
    expect(css).toMatch(/#start-here \{ scroll-margin-top: 0; \}/);
    expect(app).toMatch(/createLinkAlreadyHere/);
    expect(app).toMatch(/scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\)/);
  });
});
