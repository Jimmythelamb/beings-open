import { h, icon, setTitle, term } from "./ui.js";

/** Static PDF published with the site. Same path in the home page and the footer. */
export const WHITEPAPER_HREF = "/whitepaper/BEINGS-Technical-Whitepaper-v0.10.pdf";
export const WHITEPAPER_LABEL = "Technical Whitepaper (v0.10, PDF)";

export function renderHome(ctx) {
  setTitle("");
  const action = (href, ic, title, text, primary) =>
    h("a", { class: `card card-link action ${primary ? "action-primary" : ""}`, href }, h("span", { class: "action-icon" }, icon(ic, { size: 26 })), h("h2", null, title), h("p", null, text), h("span", { class: "link-cta" }, "Open", icon("arrow", { size: 16 })));
  ctx.root.replaceChildren(
    h(
      "section",
      { class: "hero" },
      h("p", { class: "eyebrow" }, "Public election ledger"),
      h("h1", null, "Elections you can check for yourself."),
      h("p", { class: "lead" }, "Paper ballots, counted in the open. Every result is published on a ", term("public ledger", "A record book kept by thousands of computers at once. Anyone can read it, and old entries can't be quietly changed."), " that anyone can read, so you don't have to take anyone's word for the count."),
      h(
        "div",
        { class: "actions" },
        h("a", { class: "btn btn-primary btn-lg", href: "#/results" }, icon("chart", { size: 18 }), "See the results"),
        h("a", { class: "btn btn-lg", href: "#/check" }, icon("ticket", { size: 18 }), "Check my ballot"),
        h(
          "a",
          { class: "btn btn-lg whitepaper-link", href: WHITEPAPER_HREF, target: "_blank", rel: "noopener noreferrer" },
          icon("book", { size: 18 }),
          h("span", null, WHITEPAPER_LABEL),
          h("span", { class: "sr-only" }, " (opens in a new tab)"),
        ),
      ),
    ),
    h("div", { class: "grid" }, action("#/results", "chart", "Read the results", "Totals for every election, with plain-language charts and live checks that the numbers add up.", false), action("#/check", "ticket", "Check my own ballot", "Enter the code on your receipt to see how your ballot was recorded, and the picture of it.", true), action("#/how", "book", "How it works", "A short, jargon-free explanation of what's on the ledger, and what isn't.", false)),
    h(
      "section",
      { class: "card soft" },
      h("h2", null, "New to blockchain? You're in the right place."),
      h("p", null, "Think of a blockchain as a shared notebook kept in thousands of places at once. Anyone can read it. New lines can be added, but nobody can quietly rub out an old one, because everyone else's copy would disagree."),
      h("p", null, "B.E.I.N.G.S. uses that notebook to record the count from paper ballots. It never holds your name, and you don't need a crypto wallet, an account or any money to use this site."),
    ),
    h("p", { class: "muted small center" }, "This site reads the Flare Coston2 test network. Nothing here decides a real election yet."),
  );
}

/** The friendly "start here" button for organizers. Mounted in the site header, under the nav. */
export const CREATE_ELECTION_HREF = "#/admin?new=1";
export function createBanner() {
  return h(
    "section",
    { class: "create-banner", "aria-labelledby": "create-banner-h" },
    h("div", { class: "create-copy" }, h("h2", { id: "create-banner-h" }, "Running an election for your classroom or school?"), h("p", null, "Set up questions, print paper ballots and scan them. Voters can check their own ballot afterwards.")),
    h("a", { class: "btn btn-primary create-btn", href: CREATE_ELECTION_HREF }, icon("ticket", { size: 18 }), "Create Your Election Here"),
  );
}
