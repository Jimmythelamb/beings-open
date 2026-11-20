// Scanner operator: a read-only description of the role, plus the helper checks that already live on this site.
// Finding a scanner, the system check, and the test print talk only to the helper on this computer. They do not
// upload ballots and they do not change the ledger.
import { fill, h, setTitle } from "./ui.js";
import { ROLE_INFO } from "./roles.js";
import { pageHead } from "./staff.js";
import { helperConnectCard } from "./helper-connect.js";
import { systemCheckCard } from "./system-check.js";
import { testPrintScanCard } from "./test-print-scan.js";

export async function renderScanner(ctx) {
  const { root } = ctx;
  const info = ROLE_INFO.scanner;
  setTitle(info.label);
  fill(
    root,
    h("a", { class: "back", href: "#/staff" }, "← All staff roles"),
    pageHead("scanner", { lead: info.blurb }),
    h(
      "section",
      { class: "card" },
      h("h2", null, "What this role does"),
      h("p", null, "The scanner operator works at the computer attached to the scanner. A batch of paper ballots goes through the scanner, and the helper signs that batch for the ledger."),
      h("p", null, "Signing a batch records that these pages were scanned. It never changes a ballot."),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", null, "On this computer"),
      h("p", { class: "muted" }, "These checks ask the helper on this machine. They do not upload ballots and they do not change the ledger. The test page is labelled so it cannot be mistaken for a real ballot."),
      helperConnectCard().root,
      systemCheckCard().root,
      h("h3", null, "Test print and scan"),
      testPrintScanCard().root,
    ),
  );
}
