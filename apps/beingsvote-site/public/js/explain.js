// The plain-language "how this is verified" explainer. Optionally shows live checks for one election.
import { h, icon, badge, term } from "./ui.js";
import { CONFIG } from "./config.js";
import { extLink, explorerAddress } from "./ui.js";

const steps = [
  ["1", "Paper ballots are scanned", "Each ballot has a unique identifier. Its scan is read three times, and each reading becomes a Merkle tree. When the Merkle trees match, the data receives a reading consensus; otherwise the mismatched readings are flagged for review."],
  ["2", "Ballot data is recorded on a public blockchain ledger", ["Each unique ballot is compiled into a short line of text, like ", h("code", null, "V:c1|V:c3|V:c3+c4"), ", along with a fingerprint of its scanned image. This ledger entry made on the ", term("blockchain", "A shared record book kept by many computers at once. New lines can be added, but old lines can't be quietly changed or removed."), " is now permanent and transparent."]],
  ["3", "Verifiable/Certifiable Election Results", "The ledger automatically rejects totals that don't match its recorded lines. Officials must then reach a deliberate, signed consensus of the data compilation, confirming the totals match the number of ballots and any reconciled flagged results."],
  ["4", "Anyone can check", "Everything on this page reads straight from the public ledger and re-counts every ballot line live. Voters look up their own ballot and can verify the data, and independent verifiers re-count and publish their findings."],
];

const checkIcon = { pass: "check", fail: "x", pending: "info", na: "info" };
const checkLabel = { pass: "Passed", fail: "Problem", pending: "Waiting", na: "Not available" };

/** checks: [{ state: "pass"|"fail"|"pending"|"na", title, detail }] */
export function renderChecks(checks) {
  return h(
    "ul",
    { class: "checks", "aria-label": "Live checks for this election" },
    checks.map((c) =>
      h(
        "li",
        { class: `check check-${c.state}` },
        h("span", { class: "check-icon" }, icon(checkIcon[c.state], { size: 18 })),
        h("div", null, h("strong", null, c.title, h("span", { class: "sr-only" }, ` — ${checkLabel[c.state]}`)), h("p", null, c.detail)),
      ),
    ),
  );
}

export function renderExplainer({ checks, open = false } = {}) {
  const items = h(
    "ol",
    { class: "steps" },
    steps.map(([n, title, body]) => h("li", null, h("span", { class: "step-n", "aria-hidden": "true" }, n), h("div", null, h("h4", null, title), h("p", null, body)))),
  );
  const links = h(
    "p",
    { class: "muted small" },
    "Prefer to look at the raw records? These are the four public contracts on the Flare Coston2 test network: ",
    extLink(explorerAddress(CONFIG.contracts.registry), "elections"),
    ", ",
    extLink(explorerAddress(CONFIG.contracts.ledger), "ballot entries"),
    ", ",
    extLink(explorerAddress(CONFIG.contracts.tally), "totals"),
    ", ",
    extLink(explorerAddress(CONFIG.contracts.verifiers), "verifiers"),
    ".",
  );
  const limits = h(
    "div",
    { class: "callout callout-info" },
    icon("info", { size: 22 }),
    h("div", null, h("strong", null, "Good to know"), h("p", null, "This is a test network designed to provide results for any election. Blockchain ledger entries are permanent and cannot be altered. Any comments or suggestions are highly appreciated: ", h("a", { href: `mailto:${CONFIG.reportEmail}` }, CONFIG.reportEmail))),
  );
  return h(
    "section",
    { class: "card explainer", "aria-labelledby": "how-h" },
    h("h2", { id: "how-h" }, icon("shield", { size: 22 }), "How this is verified"),
    h("p", { class: "lead" }, "Every ballot gets its own blockchain identifier the moment it's scanned. That creates a permanent, transparent record each voter can check for their own ballot, and anyone can verify the results publicly."),
    checks ? h("div", { class: "live-checks" }, h("h3", null, "Checks we just ran for this election"), renderChecks(checks)) : null,
    items,
    limits,
    links,
  );
}
