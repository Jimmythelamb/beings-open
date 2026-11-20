// Small "?" help buttons that open a plain-language note beside a field or heading.
// The text lives in HELP_TEXT (plain data, tested). The button is a disclosure: it toggles a panel with
// aria-expanded / aria-controls, works with tap, click, Enter/Space and Escape, and never relies on hover.
import { h, icon } from "./ui.js";

export const HELP_TEXT = {
  // ---------- create an election
  "create.name": "The name voters will see on results and on the ballot, for example \"Room 1209 class president\". You can't change it after the election is created.",
  "create.code": "A short code made for you, like BEINGS-2026-ABC123. People type it to find the election. It is printed on every ballot, so keep the one you were given.",
  "create.opens": "When scanners may start recording ballots. Use your own local time. Phones or scanners must be registered before this moment.",
  "create.closes": "When recording stops. After this, nobody can add ballots, and you can publish the count.",
  "create.registered": "How many people are allowed to vote. Use 0 if there is no voter list. This is only used to check the count adds up; no names are ever stored.",
  "create.spare": "Extra ballots for mistakes or spoiled papers, set while you design the ballot. It starts at 0% (one ballot per registered voter); an empty box also means 0. For a class of 30 with 10%, 33 ballots are printed. Every printed ballot gets its own secret code.",
  "create.quorum": "How many Local Scanner/Printer stations must be registered before voting can open. In a classroom this is one scanner/printer station run through a signing crypto-wallet, so use 1. Phones are not used here.",
  "create.findScanner": "This page cannot see a scanner or printer by itself. On the Windows computer with the printer, press Connect printer & scanner (Windows PC). The helper runs in the background. This check is optional: you can still create the election, because ballots are accounted for by hash. A phone or tablet cannot do this check.",
  "create.testPrintScan": "Optional. Windows built-in printing sends a labelled synthetic test page (not a real ballot) to the printer, then the scan is checked. Preview only opens the page and does not print. Nothing is recorded or uploaded. You can skip it; creating the election is never blocked. A phone or tablet cannot run it.",
  "create.days": "How long the pictures of the ballots are kept. They are deleted automatically afterwards. When pictures are public, this must be 30 to 60 days (30 is the default). When they are not public, 1 to 365 days. Shorter is more private.",
  "create.publicImages": "When on, anyone with the election code and a ballot's fingerprint can view that picture without signing in. The scan can show the printed ballot code, so it could be used as proof of a vote or to pressure someone. Pictures stay public for 30 to 60 days, then are removed. Fingerprints and readings stay on the chain. Starts off.",
  "create.layout": "Only for ballots designed with another tool. Normally leave this empty: the ballot designer on this page makes the layout fingerprint (SHA-256 of the ballot design) and puts it in for you.",
  "create.apps": "Only if this election should trust a scanner build that isn't ticked above. Paste its fingerprint, one per line, 64 hex characters; 0x at the start is optional.",
  "create.design": "Pressing Design the ballot lays out your questions on a Letter page the scanner can read. The layout fingerprint is filled in for you, and you choose how many spare ballots to print. Design again if you change the questions.",
  "create.scannerBuild": "The scanner software this election trusts, filled in from this site's approved list. You don't type it. Use Advanced only if your school or club runs a different approved build.",
  "create.wallet": "Your crypto-wallet signs and pays for each change you approve. We recommend Bifrost (MetaMask also works). Get free test C2FLR at faucet.flare.network: choose C2FLR in the drop-down (not CFLR), paste your address and press Request C2FLR. About 1 to 2 C2FLR covers a typical classroom election in our tests; fees vary.",
  "create.questions": "Each question becomes one box on the paper ballot. Type each choice on its own line. Blank lines and extra spaces are removed.",
  "create.maxMarks": "How many choices a voter may fill in for this question. If they mark more, the ballot is recorded as an overvote (O) for that question, not thrown away.",
  "create.cid": "Optional. A link (such as ipfs://…) where you published the public copy of the election file. Leave empty to keep the file with you; the ledger will note it as unpublished.",
  "create.files": "The secret full file holds every ballot code. Keep it private and safe; you need it to print ballots and publish the count. The public copy has the codes removed and is safe to share or put on the website.",
  "create.print": "The PDF has one ballot per page, in a random order, with a secret code and QR. Preview opens it and does not print. The helper prints with Windows built-in printing: actual size, single-sided, on Letter paper. The layout file tells the scanner where every bubble is.",
  // ---------- running an election
  "admin.device": "The Local Scanner/Printer: the station that reads the paper ballots, identified by its signing crypto-wallet. The ledger accepts ballot readings only from crypto-wallets registered here, and only during Setup, before voting opens.",
  "admin.findScanner": "Connect the station this computer can see. The helper reports the scanner and printer Windows knows; it never holds a key. This check is optional: you can still register, because ballots are accounted for by hash. You still choose the public signing address below. A phone or tablet cannot do this check.",
  "admin.testPrintScan": "Optional. Windows built-in printing sends a labelled synthetic test page (not a real ballot) to the printer, then the scan is checked. Preview opens the page and does not print. Nothing is recorded. You can skip it; registration is never blocked. A phone or tablet cannot run it.",
  "admin.appFingerprint": "The scanner build this station runs, picked for you from the builds this election approved. The ledger stores it next to the station's crypto-wallet, so anyone can check later which software read the ballots.",
  "admin.wallet": "Open, close and publish the tally are each a transaction from the organizer's crypto-wallet; it shows the fee before you approve. Low on test C2FLR? At faucet.flare.network choose C2FLR in the drop-down (not CFLR, which is the older Coston network); it gives 100 C2FLR per address every 24 hours.",
  "admin.reviewer": "A person who may mark a ballot spoiled or sign off a flagged count. Reviewers can't change recorded ballots.",
  "admin.roster": "A line with no name is covered by the Election Administrator's sign-in. Once you enter a name, that person links their own crypto-wallet with a Bifrost QR code and you approve them before the position is active. Names stay on this computer. Crypto-wallets and a fingerprint of the roster can be recorded on the chain.",
  "admin.rosterReview": "Before voting opens, read every staff line and sign the attestation. The signature and roster fingerprint are locked on the chain. A standard election needs every position filled, plus the System admin's close-out sign-off, before it can be certified. A test or classroom sign-off is optional and is disclosed.",
  "admin.openClose": "Opening lets scanners record ballots. Closing stops recording. Both are one-way: you can't go back to setup after opening. When the roster contract is in use, a new election locks its roster fingerprint first.",
  "admin.fullFile": "The secret full election file you saved when you created the election. It is read in your browser only and never uploaded.",
  "admin.paperCounts": "Count these on paper: ballots handed out to voters, and blank ballots returned unused. The site checks they agree with the ledger (rules R1 to R6).",
  "admin.notes": "A signed note lets an official explain something about the result, for example why a balance check failed. It is shown under the results, clearly marked as an explanation. It can't change the counts and doesn't clear a flag; only a reviewer can sign off a flagged count.",
  "admin.noteDraft": "If a note was prepared for you as a file, load it here to fill in the words. You still read it and sign it with your own crypto-wallet; nothing is signed until you press Sign.",
  "admin.noteText": "Say what happened in plain words, as you would to a voter. Facts only. Never include a ballot code, a voter's name or anything private.",
  "admin.noteName": "Optional. If you type a name, it is public and permanent: once the note's fingerprint is on the chain, the chain cannot forget it, and copies of the note keep it. Leave it empty to be shown as your role and crypto-wallet.",
  "admin.notePost": "Posting puts the note's fingerprint, your crypto-wallet and your role on the ledger, so anyone can prove later that this exact note was published by you. The words stay in the signed file on the website. It costs a small network fee.",
  "admin.recordPost": "The record is the public set of files for this election: the questions, the official results file and the signed notes. Its fingerprint on the ledger lets anyone check years later that none of those files were changed.",
  "admin.recordManifest": "The manifest.json made by the record builder. It lists every public file in the record with its fingerprint. A manifest that still lists an unsigned draft note is refused.",
  "admin.retire": "After the keep-for period, ballot pictures are deleted. This posts a public note that it happened. It does not delete anything itself.",
  "recorded.panel": "Each value here is a fingerprint or address the ledger keeps for this election. None reveals a ballot code or a vote. Check it yourself recomputes a value from a file on your own computer and compares; nothing is uploaded.",
  "staff.wallets": "These are public addresses that already act on the ledger, listed so anyone can see who runs what. A name here is only a label on this website. Permissions come from the ledger, election by election, not from this list.",
  // ---------- printed ballots
  "printed.fullVsPublic": "Use the secret full file here (the one with \"SECRET\" in its name). The public copy has the ballot codes removed, so it is refused.",
  "printed.manifest": "The manifest is a small file made when ballots were printed or scanned. It lists fingerprints so we can check nothing was swapped. Optional here.",
  "printed.schedule": "The opening and closing times for ballots you already printed. Changing them changes the file fingerprint, so only apply a schedule before the election is created.",
  "printed.readings": "A readings file is what the mark reader produced from the scans: one entry per ballot with the filled-in bubbles. Load it only once; loading it again would try to record the same ballots twice.",
  "printed.batch": "A batch approval file lists exactly which readings the signing service may submit. It submits those and nothing else.",
  // ---------- public pages
  "check.election": "The election code is printed on your ballot and on the receipt. It looks like BEINGS-2026-ABC123. The square on the receipt opens this page with that code filled in. You still type the ballot code yourself.",
  "check.ballot": "Your ballot code is the 12 letters and numbers on the tear-off receipt. Only you have it, so only you can look up your ballot. Dashes and capitals don't matter.",
  "check.results": "B means you left that question blank, O means more choices were marked than allowed, U means a mark was unclear. These are kept exactly as read so you can check them against the picture.",
"check.publicImages": "For this election, a picture can also be opened with the election code and its fingerprint, without a ballot code. The scan can show the printed ballot code. Pictures stay public for 30 to 60 days, then are removed. Fingerprints and readings stay on the chain.",
  "results.lookup": "Type an election code to jump straight to its results. Totals come straight from the public ledger, not from this website.",
"results.publicImages": "When this election turned Public ballot images on, anyone with the election code and a picture's fingerprint can open that one picture. The scan can show the printed ballot code. Pictures stay public for 30 to 60 days, then are removed. Fingerprints and readings stay on the chain.",
  "results.record": "Officials can sign a note explaining something about the result, such as a failed check. The note is the official's explanation, not a fact from the ledger, and it can't change the counts. This page checks the signature and the file fingerprints in your browser; no wallet is needed.",
  "results.counts": "Valid votes are counted per choice. Blank (B), overvote (O) and unclear (U) are counted separately so every ballot is accounted for.",
  "scans.panel": "A private view of every stored ballot picture. It is not on the public results page, because a scan can show the printed ballot code. Only the organizer and registered verifiers can load the pictures, by signing in. Each picture is fingerprinted in your browser and compared with the ledger. No AI is used.",
};


/** The help text for a key, or null. */
export const helpText = (key) => (Object.prototype.hasOwnProperty.call(HELP_TEXT, key) ? HELP_TEXT[key] : null);

let seq = 0;
/** A "?" button plus its hidden note. Returns { button, panel }; put the panel right after the button's row. */
export function helpToggle(key, { label } = {}) {
  const text = helpText(key);
  if (!text) return { button: null, panel: null };
  const id = `help-${++seq}`;
  const button = h("button", { type: "button", class: "help-btn", "aria-expanded": "false", "aria-controls": id, title: "What is this?" }, icon("info", { size: 16 }), h("span", { class: "sr-only" }, `Help: ${label ?? "what is this?"}`));
  const panel = h("div", { id, class: "help-panel", role: "note", hidden: true }, h("p", null, text), h("button", { type: "button", class: "help-close btn btn-sm" }, "Got it"));
  const set = (open) => {
    button.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
  };
  button.addEventListener("click", () => set(panel.hidden));
  panel.querySelector(".help-close").addEventListener("click", () => (set(false), button.focus()));
  for (const el of [button, panel])
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) {
        e.stopPropagation();
        set(false);
        button.focus();
      }
    });
  return { button, panel };
}

/** A label with a help button beside it, followed by the (hidden) note. Returns an array of nodes. */
export function labelWithHelp(forId, text, key) {
  const { button, panel } = helpToggle(key, { label: text });
  return [h("div", { class: "label-row" }, h("label", { for: forId }, text), button), panel];
}

/** A heading (h2/h3) with a help button. */
export function headingWithHelp(tag, attrs, text, key) {
  const { button, panel } = helpToggle(key, { label: typeof text === "string" ? text : undefined });
  return [h("div", { class: "heading-row" }, h(tag, attrs, text), button), panel];
}
