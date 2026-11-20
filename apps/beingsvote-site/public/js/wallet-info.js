// Wallet box: what the organizer's wallet signs and pays for, in plain words.
// Every statement here was checked against the code (tx.js sendTx/signWithCard, admin.js, delegated.js) and every fee
// is a real Coston2 receipt from packages/ledger/GAS.md (smoke-test election BEINGS-2026-2MJTDK). Plain data + a view.
import { h, icon, extLink } from "./ui.js";
import { headingWithHelp } from "./help.js";
import { WALLET_GUIDE } from "./wallet-guide.js";
import { faucetButton } from "./faucet.js";

/** Where the example fees come from (real Coston2 receipts, gas price 650 gwei at the time). */
export const FEE_SOURCE = "Coston2 receipts of the test election BEINGS-2026-2MJTDK (1 ballot, 1 question), gas price 650 gwei at the time; packages/ledger/GAS.md";

/**
 * The transactions an organizer's wallet sends, in order. `where`: the page/step. `example`: C2FLR from FEE_SOURCE, or
 * null when no real receipt exists. `optional`: only some elections need it. `fromCreatePage`: sent by the final button
 * on the Create Your Election page (that page sends exactly one).
 */
export const ORGANIZER_STEPS = [
  { method: "createElection", name: "Create the election", where: "This page, final button", what: "Puts the election file's fingerprint, the ballot code list's fingerprint, the dates and the ballot count on the ledger, and makes your crypto-wallet the organizer.", example: 0.1141634, fromCreatePage: true },
  { method: "registerDevice", name: "Register Scanner/Printer", where: "Admin page, during Setup", what: "Approves each Local Scanner/Printer station's crypto-wallet to record ballots for this election (one transaction per station).", example: 0.0471367 },
  { method: "registerReviewer", name: "Register a reviewer", where: "Admin page, during Setup", what: "Lets a reviewer's crypto-wallet mark spoiled ballots and sign off a flagged count.", example: null, optional: true },
  { method: "openElection", name: "Open voting", where: "Admin page", what: "Starts the voting period. After this, nothing can be added in Setup.", example: 0.0221689 },
  { method: "closeElection", name: "Close voting", where: "Admin page", what: "Stops recording. (Anyone may close it one day after the scheduled closing time.)", example: 0.0191113 },
  { method: "postTally", name: "Publish the official tally", where: "Admin page, after closing", what: "Posts the totals, the Merkle root of the readings and the balance checks (R1 to R6).", example: 0.17049305 },
  { method: "noticeImagesRetired", name: "Notice that images were retired", where: "Admin page, after the keep-for period", what: "Adds a public note that the stored ballot pictures were deleted. Optional.", example: null, optional: true },
];

export const CREATE_PAGE_TX_COUNT = ORGANIZER_STEPS.filter((s) => s.fromCreatePage).length;

/** Shared heading of the create-form and Election admin wallet boxes. */
export const WALLET_BOX_HEADING = "Election Positions and Transactions are through verified and authorized Crypto Wallet Permissions and Transaction Fees.";

/** Sum of the example fees for the steps that have one (a rough guide only). */
export const exampleTotal = (steps = ORGANIZER_STEPS) => Math.round(steps.reduce((n, s) => n + (s.example ?? 0), 0) * 1000) / 1000;

const fmt = (x) => (x == null ? "no test receipt yet" : `about ${x < 0.1 ? x.toFixed(3) : x.toFixed(2)} C2FLR`);

export { WALLET_GUIDE } from "./wallet-guide.js";

/** "Get your wallet and test coins": wallet recommendation, faucet steps, how much you need. */
export function walletGetReady({ compact = false } = {}) {
  const g = WALLET_GUIDE;
  const wallet = h("li", null, h("strong", null, "Get a crypto-wallet. "), "We recommend ", extLink(g.recommended.url, g.recommended.name), ", a Flare-friendly app for iPhone and Android; connect it here with the Phone wallet (QR code) option. ", `${g.alsoWorks} also works, as a browser crypto-wallet.`);
  const coins = h("li", null, h("strong", null, "Get free test coins. "), "Open the ", extLink(g.faucet.url, `${g.faucet.name} (${g.faucet.host})`), ". ", h("strong", null, `${g.faucet.choose}.`), ` ${g.faucet.notThis}. Then paste your crypto-wallet address and press ${g.faucet.button}. For Coston2 it gives ${g.faucet.perRequest} ${g.faucet.per}. These are test coins with no real value; this site only uses C2FLR.`);
  const need = h("li", null, h("strong", null, "How much you need: "), `${g.typicalNeed} for a typical classroom election. That is an example from our test elections, not a promise, because fees vary; one faucet request is plenty.`);
  return h("div", { class: "wallet-ready" }, h("h4", null, "Get your crypto-wallet and test coins"), h("ol", { class: "plain-list small" }, compact ? [coins, need] : [wallet, coins, need]), h("p", { class: "faucet-row" }, faucetButton()));
}

/** Short "No wallet yet?" line for the wallet dialog when nothing is connected. */
export const noWalletYet = () =>
  h("p", { class: "small no-wallet-yet" }, h("strong", null, "No wallet yet? "), "Get ", extLink(WALLET_GUIDE.recommended.url, "Bifrost"), ` (${WALLET_GUIDE.alsoWorks} also works), then free test coins from the `, extLink(WALLET_GUIDE.faucet.url, "Flare Faucet"), ": choose C2FLR in the drop-down (not CFLR).");

/** The reminder next to the final create button. */
export function createReminderText(n = CREATE_PAGE_TX_COUNT) {
  return `Your crypto-wallet will ask you to approve ${n} transaction${n === 1 ? "" : "s"} and pay the network fee (test C2FLR). Check the fee your crypto-wallet shows before you approve.`;
}

/**
 * The information box. variant: "full" (top of the Create page), "confirm" (just before the create button) or
 * "admin" (near open/close/tally). open: start expanded.
 */
export function walletInfoBox({ variant = "full", open = variant === "full", id = `wallet-info-${variant}`, administratorName = "" } = {}) {
  const steps = h(
    "ol",
    { class: "wallet-steps" },
    ORGANIZER_STEPS.map((s) => h("li", null, h("strong", null, s.name), s.optional ? h("span", { class: "muted small" }, " (optional)") : null, h("span", { class: "muted small" }, ` · ${s.where}`), h("br"), s.what, " ", h("span", { class: "muted small" }, `Example fee: ${fmt(s.example)}.`))),
  );
  const intro = h("p", null, "You, the organizer, sign every change with your own crypto-wallet (for example Bifrost or MetaMask) and pay its small network fee. Your crypto-wallet gives permission and authorization from your Election Staffmember position. Sometimes it will ask you for gas fees that will be used to pay for ledger entries to the blockchain.");
  const whichName = administratorName ? `, ${administratorName}` : "";
  const which = h("p", { class: "small" }, h("strong", null, "Which crypto-wallet? "), `The address at the top right is the one that creates this election, followed by the Election Administrator's name${whichName}.`);
  const how = h("p", { class: "small" }, "For each step, this page first shows a card saying what will happen and checks it against the live ledger without sending anything. Then your crypto-wallet asks you to approve; that is where you see the fee. Cancel at either point and nothing is sent.");
  const cost = h(
    "p",
    { class: "small" },
    h("strong", null, "What it costs. "),
    `Fees go up and down with the network's gas price, so treat these as rough examples from a test election, not a quote. In ${FEE_SOURCE.split(";")[0]}, the organizer's steps above came to about ${exampleTotal()} C2FLR together. Your crypto-wallet's own estimate, shown before you approve, is the figure that counts.`,
  );
  const need = h(
    "ul",
    { class: "plain-list small" },
    h("li", null, h("strong", null, "Before you start: "), "a crypto-wallet switched to the Flare Coston2 test network (chain 114). The site offers to switch it for you."),
    h("li", null, "Some test C2FLR in that crypto-wallet (see \"Get your crypto-wallet and test coins\" above). This is a test network: C2FLR has no money value."),
  );
  const permanent = h(
    "ul",
    { class: "plain-list small" },
    h("li", null, h("strong", null, "What can't be undone: "), "once a step is on the ledger it is public and permanent. It can't be edited or deleted."),
    h("li", null, "Registering the Scanner/Printer and any reviewer only works during Setup. Do it before you open voting."),
  );
  const station = h(
    "p",
    { class: "small" },
    h("strong", null, "The Scanner/Printer has its own crypto-wallet. "),
    "That station crypto-wallet signs the ballot readings, and the transaction that records them is paid by the crypto-wallet that sends it, not by yours. When readings are sent as a batch, your crypto-wallet first signs an approval of that exact batch: a signature, which costs nothing. The station can only record ballots for this election, and only after you register it.",
  );
  const body =
    variant === "confirm"
      ? [h("p", { class: "small" }, "Signing and paying crypto-wallet: the one connected at the top right of the page, which becomes this election's organizer."), h("p", null, `Pressing "Create it on the ledger" sends ${CREATE_PAGE_TX_COUNT} transaction from your crypto-wallet: `, h("strong", null, ORGANIZER_STEPS[0].name), `. ${ORGANIZER_STEPS[0].what} Example fee: ${fmt(ORGANIZER_STEPS[0].example)}.`), how, permanent, h("details", { class: "fp-why" }, h("summary", null, "Every step your crypto-wallet will be asked for, in order"), steps, cost)]
      : variant === "admin"
        ? [intro, which, how, steps, cost, walletGetReady({ compact: true }), permanent, station]
        : [intro, which, walletGetReady(), how, h("h4", null, "The steps, in order"), steps, cost, need, permanent, station];
  return h(
    "details",
    { class: "wallet-info", id, open: open ? true : null },
    h("summary", null, icon("wallet", { size: 20 }), h("span", { class: "wallet-info-title" }, WALLET_BOX_HEADING)),
    variant === "admin" ? headingWithHelp("h4", null, "In short", "admin.wallet") : headingWithHelp("h4", null, "In short", "create.wallet"),
    ...body,
  );
}

/** One-line reminder next to the final button. */
export const createReminder = () => h("p", { class: "wallet-reminder small" }, icon("wallet", { size: 16 }), createReminderText());

