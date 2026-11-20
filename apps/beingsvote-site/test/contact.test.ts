// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG, resolveCommentsUrl, safeServiceOrigin, turnstileSiteKey } from "../public/js/config.js";
import { CONTACT_MESSAGE_MAX, contactFormBody, deliverContact, mailtoLink, renderContact, validateContact } from "../public/js/contact.js";

const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("contact fields", () => {
  it("accepts a normal note and refuses an empty or oversized message", () => {
    const ok = validateContact({ name: "Ada Lovelace", email: "ada@example.com", message: "Hello from the lab." });
    expect(ok.ok).toBe(true);
    expect(ok.errors).toEqual({});
    expect(validateContact({ name: "", email: "ada@example.com", message: "Hello" }).ok).toBe(false);
    expect(validateContact({ name: "Ada", email: "not-an-email", message: "Hello" }).errors.email).toMatch(/valid email/);
    const huge = validateContact({ name: "Ada", email: "ada@example.com", message: "x".repeat(CONTACT_MESSAGE_MAX + 1) });
    expect(huge.ok).toBe(false);
    expect(huge.errors.message).toMatch(/1000/);
  });

  it("strips control characters from the name so a mailto line cannot be injected", () => {
    const checked = validateContact({ name: "Ada\rBcc: eve@evil.test", email: "ada@example.com", message: "Hello" });
    expect(checked.name).toBe("AdaBcc: eve@evil.test");
    expect(checked.name).not.toMatch(/[\r\n]/);
  });

  it("posts a private form body and never a comments payload", () => {
    const body = contactFormBody({ name: "Ada", email: "ada@example.com", message: "Hello <b>there</b>" });
    const params = new URLSearchParams(body);
    expect(params.get("form-name")).toBe("contact");
    expect(params.get("name")).toBe("Ada");
    expect(params.get("message")).toBe("Hello <b>there</b>");
    expect(params.get("bot-field")).toBe("");
    expect(body).not.toMatch(/api\/comments|turnstile|ballot/i);
  });

  it("uses mailto only as a fallback, addressed to reportEmail", () => {
    const href = mailtoLink(CONFIG.reportEmail, { name: "Ada", email: "ada@example.com", message: "Hello" });
    expect(href.startsWith(`mailto:${CONFIG.reportEmail}?`)).toBe(true);
    expect(decodeURIComponent(href)).toContain("Hello");
    expect(mailtoLink("", { name: "Ada", email: "ada@example.com", message: "Hello" })).toBe("");
    expect(mailtoLink("not an email", { name: "Ada", email: "ada@example.com", message: "Hello" })).toBe("");
  });

  it("delivers to the site host, and falls back without publishing when the host refuses", async () => {
    const fields = validateContact({ name: "Ada", email: "ada@example.com", message: "Please write back." });
    let posted = "";
    const sent = await deliverContact(fields, {
      reportEmail: CONFIG.reportEmail,
      fetchImpl: async (_url, init) => {
        posted = String(init?.body ?? "");
        expect(String(init?.method)).toBe("POST");
        expect(String(_url)).toBe("/");
        return new Response("ok", { status: 200 });
      },
    });
    expect(sent).toEqual({ ok: true, via: "form" });
    expect(posted).toContain("form-name=contact");
    expect(posted).not.toContain("/api/comments");

    const refused = await deliverContact(fields, {
      reportEmail: CONFIG.reportEmail,
      fetchImpl: async () => new Response("missing", { status: 404 }),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.via).toBe("mailto");
      expect(refused.href).toContain(CONFIG.reportEmail);
      expect(decodeURIComponent(refused.href)).toContain("Please write back.");
    }

    let called = 0;
    const bot = await deliverContact({ ...fields, botField: "filled by a bot" }, { fetchImpl: async () => (called++, new Response("ok")) });
    expect(bot).toEqual({ ok: true, via: "ignored" });
    expect(called).toBe(0);
  });
});

describe("contact page", () => {
  it("shows the form, and a sent message is not left on the page as a public comment", async () => {
    document.body.replaceChildren(document.createElement("div"));
    const root = document.body.firstElementChild as HTMLElement;
    renderContact(
      { root },
      {
        fetchImpl: async () => new Response("ok", { status: 200 }),
      },
    );
    expect(document.body.textContent).toContain("Contact");
    expect(document.body.textContent).toContain(CONFIG.reportEmail);
    expect(document.body.textContent).toMatch(/not posted on the site/i);
    const message = document.getElementById("contact-message") as HTMLTextAreaElement;
    expect(message.maxLength).toBe(CONTACT_MESSAGE_MAX);
    (document.getElementById("contact-name") as HTMLInputElement).value = "Ada";
    (document.getElementById("contact-email") as HTMLInputElement).value = "ada@example.com";
    message.value = "Hello <script>alert(1)</script>";
    message.dispatchEvent(new Event("input"));
    expect(document.getElementById("contact-count")?.textContent).toBe(`${message.value.length} / ${CONTACT_MESSAGE_MAX}`);
    const form = root.querySelector("form");
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.getElementById("contact-note")?.textContent).toMatch(/not published on this site/);
    expect(root.querySelector("script")).toBeNull();
    expect(message.value).toBe("");
  });

  it("offers a mailto link when the form host is down", async () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    renderContact({ root }, { fetchImpl: async () => { throw new Error("offline"); } });
    (document.getElementById("contact-name") as HTMLInputElement).value = "Ada";
    (document.getElementById("contact-email") as HTMLInputElement).value = "ada@example.com";
    (document.getElementById("contact-message") as HTMLTextAreaElement).value = "Still private";
    root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const link = root.querySelector("a");
    expect(link?.textContent).toMatch(/Email this message/);
    expect(link?.getAttribute("href")).toContain(`mailto:${CONFIG.reportEmail}`);
    expect(decodeURIComponent(link?.getAttribute("href") ?? "")).toContain("Still private");
    expect(root.textContent).toMatch(/Nothing was published/);
  });
});

describe("contact wiring", () => {
  it("puts Contact in the nav and Contact us in the footer of the shell", () => {
    const app = src("../public/js/app.js");
    const index = src("../public/index.html");
    const check = src("../public/check.html");
    expect(app).toContain('["#/contact", "Contact", "contact"]');
    expect(app).toContain('h("a", { href: contactHref }, "Contact us")');
    expect(app).toContain('path === "/contact"');
    expect(index).toContain('name="contact"');
    expect(index).toContain('data-netlify="true"');
    expect(index).toContain('netlify-honeypot="bot-field"');
    expect(index).toContain('name="message"');
    expect(index).not.toContain("<form name=\"contact\" method=\"POST\" action=\"/\" data-netlify=\"true\" netlify-honeypot=\"bot-field\" hidden>");
    // One static form is enough for Netlify to register it. A second copy on check.html is not detected.
    expect(check).not.toContain("data-netlify");
    for (const html of [index, check]) {
      const commentsAt = html.indexOf('id="page-comments"');
      expect(commentsAt).toBeGreaterThan(html.indexOf("</main>"));
      expect(commentsAt).toBeLessThan(html.indexOf("<footer"));
    }
  });

  it("ignores an unsafe comments origin and an empty Turnstile site key", () => {
    expect(resolveCommentsUrl("/api/comments")).toBe("https://beings-ballot-images.beingsvote-test.workers.dev/api/comments");
    expect(safeServiceOrigin("javascript:alert(1)")).toBe("");
    expect(resolveCommentsUrl("/api/comments", { ...CONFIG, commentsServiceBase: "http://comments.example" })).toBe("");
    expect(resolveCommentsUrl("/api/comments", { ...CONFIG, commentsServiceBase: "https://user:pass@comments.example" })).toBe("");
    expect(turnstileSiteKey()).toBe("");
    expect(turnstileSiteKey({ ...CONFIG, turnstileSiteKey: "0x4AAAAAAAAAAAAAAA" })).toBe("0x4AAAAAAAAAAAAAAA");
    expect(src("../public/js/contact.js")).not.toMatch(/eth_sendTransaction|from "\.\/chain/);
  });
});
