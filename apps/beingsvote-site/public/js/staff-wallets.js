// "Staff and official wallets" on the Staff page: a public list from CONFIG.staffWallets, so more staff can be added
// by editing one setting. Shows role, optional display name (website only, never on chain), areas and the address with
// copy and explorer links. It grants nothing: the ledger's own registries decide what each wallet may do.
import { h, icon, badge, extLink, explorerAddress, copyText } from "./ui.js";
import { headingWithHelp } from "./help.js";
import { isAddress } from "./logic.js";

const MAX_NAME = 64;

/** Plain problems with the configured list (empty = fine). */
export function staffWalletProblems(list) {
  const p = [];
  if (!Array.isArray(list)) return ["staffWallets must be a list."];
  const seen = new Set();
  list.forEach((w, i) => {
    const n = i + 1;
    if (!isAddress(w?.address ?? "")) p.push(`Row ${n}: the address isn't a wallet address.`);
    else if (seen.has(w.address.toLowerCase())) p.push(`Row ${n}: this address is listed twice.`);
    else seen.add(w.address.toLowerCase());
    if (!String(w?.role ?? "").trim()) p.push(`Row ${n}: give it a role label.`);
    if (String(w?.name ?? "").length > MAX_NAME) p.push(`Row ${n}: the display name is longer than ${MAX_NAME} characters.`);
    const extra = Object.keys(w ?? {}).filter((k) => !["role", "name", "areas", "address"].includes(k));
    if (extra.length) p.push(`Row ${n}: unknown field ${extra[0]}.`);
  });
  return p;
}

/** The section. `connected`: the wallet connected right now (highlighted as "This is you"). */
export function staffWalletsSection(list = [], { connected = null } = {}) {
  const rows = (list ?? []).filter((w) => isAddress(w?.address ?? ""));
  return h(
    "section",
    { class: "card staff-wallets", "aria-labelledby": "staff-wallets-h" },
    headingWithHelp("h2", { id: "staff-wallets-h" }, [icon("users", { size: 22 }), "Staff and official wallets"], "staff.wallets"),
    h("p", { class: "muted" }, "The public wallet addresses of the people and stations who run elections on this site, and what each one looks after. Names are shown on this website only and are never written to the ledger."),
    rows.length
      ? h(
          "ul",
          { class: "staff-list" },
          rows.map((w) => {
            const me = connected && connected.toLowerCase() === w.address.toLowerCase();
            return h(
              "li",
              { class: `staff-row${me ? " me" : ""}` },
              h("div", { class: "staff-top" }, badge(w.role, "info"), w.name ? h("strong", null, w.name) : null, me ? badge("This is you", "ok", "check") : null),
              w.areas ? h("p", { class: "small" }, w.areas) : null,
              h("p", { class: "staff-addr" }, h("code", { class: "code", title: w.address }, w.address), " ", h("button", { class: "icon-btn", type: "button", "aria-label": `Copy the ${w.role} address`, title: "Copy", onClick: () => copyText(w.address, "Address copied") }, icon("copy", { size: 16 })), " ", extLink(explorerAddress(w.address), "See its activity")),
            );
          }),
        )
      : h("p", { class: "muted" }, "No staff wallets are listed on this site yet."),
    h("p", { class: "muted small" }, "Being on this list doesn't give a wallet any power. What each wallet may do is decided by the ledger, election by election."),
  );
}
