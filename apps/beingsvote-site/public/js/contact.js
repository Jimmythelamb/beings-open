// Contact page. The message is posted to the site host's private form inbox (Netlify Forms).
// It is not stored with public comments and it is not written on the ledger.
import { h, setTitle, copyText } from "./ui.js";
import { CONFIG } from "./config.js";

export const CONTACT_MESSAGE_MAX = 1000;
export const CONTACT_NAME_MAX = 80;
export const CONTACT_EMAIL_MAX = 254;
export const CONTACT_FORM_NAME = "contact";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function oneLine(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function messageText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

/** Field checks for the contact form. A message over the limit is refused, not chopped. */
export function validateContact(fields) {
  const name = oneLine(fields?.name, CONTACT_NAME_MAX);
  const email = oneLine(fields?.email, CONTACT_EMAIL_MAX);
  const message = messageText(fields?.message);
  const errors = {};
  if (!name) errors.name = "Enter your name.";
  else if (oneLine(fields?.name, 10_000).length > CONTACT_NAME_MAX) errors.name = `Keep your name to ${CONTACT_NAME_MAX} characters.`;
  if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  if (!message) errors.message = "Enter a message.";
  else if (message.length > CONTACT_MESSAGE_MAX) errors.message = `Keep the message to ${CONTACT_MESSAGE_MAX} characters.`;
  return { name, email, message: message.slice(0, CONTACT_MESSAGE_MAX), errors, ok: Object.keys(errors).length === 0 };
}

/** application/x-www-form-urlencoded body for the private site form. bot-field stays empty. */
export function contactFormBody(fields) {
  const body = new URLSearchParams();
  body.set("form-name", CONTACT_FORM_NAME);
  body.set("name", fields.name);
  body.set("email", fields.email);
  body.set("message", fields.message);
  body.set("bot-field", "");
  return body.toString();
}

/** mailto fallback. The address must look like an email, and the body is the visitor's own message. */
export function mailtoLink(email, fields) {
  const to = oneLine(email, CONTACT_EMAIL_MAX);
  if (!EMAIL_RE.test(to)) return "";
  const subject = "Message from the B.E.I.N.G.S. site";
  const body = `Name: ${fields.name}\nEmail: ${fields.email}\n\n${fields.message}\n`;
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Hand the message to the site host. A honeypot hit is ignored.
 * When the host does not accept the form, the caller can offer a mailto link instead.
 * This never posts to the comments API.
 * @returns {Promise<{ ok: true, via: "form" | "ignored" } | { ok: false, via: "mailto", href: string }>}
 */
export async function deliverContact(fields, { fetchImpl = fetch, endpoint = "/", reportEmail = "" } = {}) {
  if (String(fields?.botField ?? "").trim()) return { ok: true, via: "ignored" };
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json, text/html;q=0.9" },
      body: contactFormBody(fields),
    });
    if (res.ok) return { ok: true, via: "form" };
  } catch {
    /* the host is not this browser's origin, or the network failed */
  }
  return { ok: false, via: "mailto", href: mailtoLink(reportEmail, fields) };
}

function paintCount(el, value) {
  el.textContent = `${value.length} / ${CONTACT_MESSAGE_MAX}`;
  el.classList.toggle("at-limit", value.length >= CONTACT_MESSAGE_MAX);
}

export function renderContact(ctx, { config = CONFIG, fetchImpl = fetch, endpoint = "/" } = {}) {
  setTitle("Contact");
  const name = h("input", { id: "contact-name", name: "name", type: "text", autocomplete: "name", maxlength: String(CONTACT_NAME_MAX), required: true });
  const email = h("input", { id: "contact-email", name: "email", type: "email", autocomplete: "email", maxlength: String(CONTACT_EMAIL_MAX), required: true });
  const message = h("textarea", { id: "contact-message", name: "message", rows: "8", maxlength: String(CONTACT_MESSAGE_MAX), required: true });
  const bot = h("input", { name: "bot-field", tabindex: "-1", autocomplete: "off" });
  const nameErr = h("p", { class: "field-error", id: "contact-name-err" });
  const emailErr = h("p", { class: "field-error", id: "contact-email-err" });
  const messageErr = h("p", { class: "field-error", id: "contact-message-err" });
  const count = h("p", { class: "char-count", id: "contact-count", "aria-live": "polite" });
  const note = h("div", { id: "contact-note", role: "status" });
  const send = h("button", { class: "btn btn-primary", type: "submit" }, "Send message");
  paintCount(count, "");
  message.addEventListener("input", () => paintCount(count, message.value));
  const destination = config.reportEmail || "the site owner";
  const form = h(
    "form",
    { class: "form", novalidate: true },
    h("div", { class: "field" }, h("label", { for: "contact-name" }, "Your name"), name, nameErr),
    h("div", { class: "field" }, h("label", { for: "contact-email" }, "Email"), email, emailErr),
    h("div", { class: "field" }, h("label", { for: "contact-message" }, "Message"), message, count, messageErr),
    h("p", { class: "hp", "aria-hidden": "true" }, h("label", null, "Leave this field empty", bot)),
    note,
    h("div", { class: "actions" }, send),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const checked = validateContact({ name: name.value, email: email.value, message: message.value });
    nameErr.textContent = checked.errors.name || "";
    emailErr.textContent = checked.errors.email || "";
    messageErr.textContent = checked.errors.message || "";
    note.replaceChildren();
    if (!checked.ok) return;
    send.disabled = true;
    const result = await deliverContact({ ...checked, botField: bot.value }, { fetchImpl, endpoint, reportEmail: config.reportEmail || "" });
    send.disabled = false;
    if (result.ok) {
      name.value = "";
      email.value = "";
      message.value = "";
      bot.value = "";
      paintCount(count, "");
      note.replaceChildren(h("p", null, "Your message was sent. It is not published on this site."));
      return;
    }
    const fallback = [h("p", null, "This page couldn't hand the message to the site host. Nothing was published here.")];
    if (result.href) {
      fallback.push(h("p", null, h("a", { class: "btn", href: result.href }, "Email this message")));
      fallback.push(h("p", { class: "hint" }, "The link opens your email app with the message filled in, addressed to ", destination, "."));
    } else {
      fallback.push(h("p", null, "No delivery address is set on this site yet."));
    }
    fallback.push(h("button", { class: "btn", type: "button", onClick: () => copyText(`Name: ${checked.name}\nEmail: ${checked.email}\n\n${checked.message}`, "Message copied") }, "Copy the message"));
    note.replaceChildren(...fallback);
  });
  ctx.root.replaceChildren(
    h("header", { class: "page-head" }, h("h1", null, "Contact"), h("p", { class: "lead" }, "Send a note to the people who run this site. It is not posted on the site, and it is not a public comment.")),
    h("section", { class: "card" }, h("p", null, "Messages go to ", h("strong", null, destination), ". Please don't include a ballot code or anyone's vote.")),
    h("section", { class: "card" }, form),
  );
}
