// Review and approve the staff roster. This is the lock step before voting opens.
import { fill, h, icon, badge, callout } from "./ui.js";
import { headingWithHelp } from "./help.js";
import {
  ADULT_NOTE,
  CLASSROOM_LABEL,
  LOCK_ATTESTATION,
  SYSTEM_SIGNOFF_STATEMENT,
  TEST_STATEMENT,
  assessRosterReview,
  kindLabel,
  lockAllowed,
  lockTypedData,
  systemSignOffTypedData,
  testTypedData,
} from "./staff-roster.js";
import { sameAddress } from "./logic.js";

/**
 * The administrator reviews every line, ticks the attestation, and signs it.
 * The signature and the roster fingerprint are what get locked.
 * `hashRoster(roster)` returns the fingerprint. `signTyped(typed)` returns { status, signature }.
 */
export function rosterReviewCard({
  roster,
  organizerAddress = "",
  chain = null,
  canEdit = false,
  verifyMessage,
  hashSignature,
  hashRoster,
  signTyped,
  onLock,
  onRecordAdmin,
} = {}) {
  const section = h("section", { class: "card roster-review", "aria-labelledby": "roster-review-h" });
  const status = h("div", { role: "status" });
  const review = assessRosterReview(roster, { organizerAddress, chain, verifyMessage, hashSignature });
  let reviewTicked = false;
  let testTicked = false;

  function paint() {
    const adminRecorded = !chain?.configured || !!chain?.known;
    const allowed = canEdit && lockAllowed({ kind: review.kind, problems: review.problems, reviewTicked, testTicked, adminRecorded });
    const rows = review.lines.map((line) =>
      h("tr", null,
        h("th", { scope: "row" }, line.position),
        h("td", null, line.name),
        h("td", null, h("code", { class: "code" }, line.wallet)),
        h("td", null, line.approval),
        h("td", null, line.chain),
      ),
    );
    const reviewBox = h("input", { type: "checkbox", id: "roster-lock-attest" });
    reviewBox.checked = reviewTicked;
    reviewBox.addEventListener("change", () => {
      reviewTicked = reviewBox.checked;
      paint();
    });
    const testBox = review.kind === "test" ? h("input", { type: "checkbox", id: "roster-test-attest" }) : null;
    if (testBox) {
      testBox.checked = testTicked;
      testBox.addEventListener("change", () => {
        testTicked = testBox.checked;
        paint();
      });
    }
    const lockBtn = h("button", {
      class: "btn btn-primary",
      type: "button",
      id: "roster-lock-btn",
      disabled: allowed ? null : true,
    }, "Lock the roster");
    lockBtn.addEventListener("click", () => lock());
    const recordAdmin = chain?.configured && !chain.known && canEdit
      ? h("button", { class: "btn btn-primary", type: "button", id: "roster-record-admin" }, "Record the Election Administrator on the chain")
      : null;
    recordAdmin?.addEventListener("click", () => onRecordAdmin?.());

    const tone = review.problems.some((p) => p.blocking) ? "warn" : review.problems.length ? "info" : "ok";
    const problemList = review.problems.length
      ? h("ul", { class: "plain-list roster-problems" }, review.problems.map((p) => h("li", null, p.text)))
      : h("p", null, "Nothing on this roster is blocking the lock.");

    fill(section,
      headingWithHelp("h2", { id: "roster-review-h" }, [icon("users", { size: 22 }), "Review and approve staff roster"], "admin.rosterReview"),
      h("p", null, "Read every line before voting opens. Names stay on this computer. The chain keeps the wallets, the positions, and a fingerprint of this roster."),
      review.label ? h("p", null, badge(review.label, review.kind === "standard" ? "ok" : "info")) : null,
      review.kind === "classroom" ? callout("info", CLASSROOM_LABEL, `${ADULT_NOTE} Certified is not available. A System admin close-out sign-off is optional and, if it is signed, it is disclosed.`) : null,
      review.kind === "test" ? callout("info", "Test", "This election is always labelled Test. It cannot be certified. If a line is still covered, tick the test statement. That signature is recorded publicly. A System admin close-out sign-off is optional and, if it is signed, it is disclosed.") : null,
      review.kind === "standard" ? callout("info", "Standard", "Only a standard election can be certified. Every position needs its own approved adult wallet, and two Election officers must handle the paper ballots. At close-out the System admin must sign that the roles and wallets were set up correctly and that each position's duties were verified complete. Without that signature the election is not certification-ready. The Verifier, an Election officer, and the Election Administrator still sign the close-out later, as three different people.") : null,
      h("table", { class: "roster-review-table" },
        h("thead", null, h("tr", null, h("th", { scope: "col" }, "Position"), h("th", { scope: "col" }, "Name"), h("th", { scope: "col" }, "Wallet"), h("th", { scope: "col" }, "Approval"), h("th", { scope: "col" }, "On chain"))),
        h("tbody", null, rows),
      ),
      callout(tone, review.problems.length ? "Check these before you lock" : "Roster check", review.problems.length ? "The list under this note is what still needs attention." : "Every required line is ready for this election type."),
      problemList,
      review.kind === "classroom" || review.kind === "standard" ? h("p", { class: "muted small" }, ADULT_NOTE) : null,
      recordAdmin,
      canEdit ? h("label", { class: "check-row" }, reviewBox, LOCK_ATTESTATION) : h("p", { class: "hint" }, "Only the Election Administrator can lock the roster."),
      testBox ? h("label", { class: "check-row" }, testBox, TEST_STATEMENT) : null,
      canEdit ? h("div", { class: "actions" }, lockBtn) : null,
      !canEdit ? null : !reviewTicked ? h("p", { class: "hint" }, "Tick the attestation to unlock the lock button.") : null,
      status,
    );
  }

  async function lock() {
    const adminRecorded = !chain?.configured || !!chain?.known;
    if (!lockAllowed({ kind: review.kind, problems: review.problems, reviewTicked, testTicked, adminRecorded })) return;
    if (!hashRoster || !signTyped || !onLock) {
      fill(status, h("p", { class: "hint" }, "The roster contract is not available on this page yet."));
      return;
    }
    let rosterHash = "";
    try {
      rosterHash = await hashRoster(roster);
    } catch (e) {
      fill(status, h("p", { class: "hint" }, String(e?.message ?? e)));
      return;
    }
    const contract = chain?.address;
    if (!contract) {
      fill(status, h("p", { class: "hint" }, "The roster contract is not on this site yet, so nothing was signed."));
      return;
    }
    const electionId = chain.electionId;
    const lockTd = lockTypedData({ verifyingContract: contract, electionId, rosterHash });
    const signed = await signTyped(lockTd, "Sign the roster review");
    if (signed?.status !== "signed") {
      if (signed?.message) fill(status, h("p", { class: "hint" }, signed.message));
      return;
    }
    let testStatement = "";
    let testSig = "0x";
    if (review.kind === "test" && testTicked) {
      const testTd = testTypedData({ verifyingContract: contract, electionId });
      const testSigned = await signTyped(testTd, "Sign the test-election statement");
      if (testSigned?.status !== "signed") {
        if (testSigned?.message) fill(status, h("p", { class: "hint" }, testSigned.message));
        return;
      }
      testStatement = TEST_STATEMENT;
      testSig = testSigned.signature;
    }
    await onLock({
      rosterHash,
      attestation: LOCK_ATTESTATION,
      attestationSig: signed.signature,
      testStatement,
      testSig,
      kind: review.kind,
      label: kindLabel(review.kind),
    });
  }

  paint();
  return section;
}

function shortHex(value) {
  const text = String(value ?? "");
  if (text.length < 18) return text || "—";
  return `${text.slice(0, 10)}…${text.slice(-6)}`;
}

/**
 * Close-out review for the System admin. They check roles, wallets, duties, and the sheet hashes,
 * then sign. A standard election needs this signature before it can be certified. Test and classroom
 * may sign it; the signature is disclosed and does not certify those elections.
 */
export function systemSignOffCard({
  electionCode = "",
  kind = "",
  status = 0,
  prepared = null,
  recorded = false,
  current = false,
  connectedAddress = "",
  contractReady = false,
  onSign,
} = {}) {
  const section = h("section", { class: "card system-signoff", "aria-labelledby": "system-signoff-h" });
  const statusLine = h("div", { role: "status" });
  let ticked = false;
  const lines = prepared?.lines ?? [];
  const systemWallet = lines.find((line) => line.role === "system")?.wallet || "";
  const closed = status === 3 || status === 4;
  const signerMatches = !!systemWallet && sameAddress(connectedAddress, systemWallet);
  const kindWord = kind === "standard" ? "Standard" : kind === "test" ? "Test" : kind === "classroom" ? "Classroom" : "";

  function disclosure() {
    if (kind === "standard") {
      return current
        ? "The System admin sign-off is recorded for this roster. A standard election requires it before the roster can be treated as certification-ready."
        : "A standard election cannot be certified until the System admin signs this. It attests that the roles and wallets were set up correctly and that each listed position's duties were verified complete.";
    }
    if (kind === "test" || kind === "classroom") {
      return recorded
        ? "This sign-off is recorded and disclosed. A test or classroom election is not certified."
        : "This sign-off is optional. If the System admin signs it, the signature is disclosed. A test or classroom election is not certified.";
    }
    return "The election type is not recorded yet. Standard requires this sign-off. Test and classroom may include it, and it is disclosed either way.";
  }

  function paint() {
    const rows = lines.map((line) =>
      h("tr", null,
        h("th", { scope: "row" }, line.label || line.role),
        h("td", null, line.duty || "—"),
        h("td", null, h("code", { class: "code", title: line.wallet }, shortHex(line.wallet))),
        h("td", null, h("code", { class: "code", title: line.positionId }, shortHex(line.positionId))),
        h("td", null, h("code", { class: "code", title: line.sheetHash }, shortHex(line.sheetHash))),
      ),
    );
    const box = h("input", { type: "checkbox", id: "system-signoff-attest" });
    box.checked = ticked;
    box.addEventListener("change", () => {
      ticked = box.checked;
      paint();
    });
    const allowed = ticked && closed && contractReady && signerMatches && lines.length > 0 && !current;
    const signBtn = h("button", {
      class: "btn btn-primary",
      type: "button",
      id: "system-signoff-btn",
      disabled: allowed ? null : true,
    }, current ? "Sign-off recorded" : "Sign the close-out verification");
    signBtn.addEventListener("click", () => sign());
    const hint = !lines.length
      ? "Nothing is ready to sign. A filled position needs its own wallet."
      : !closed
        ? "Voting has to be closed before this close-out signature."
        : !contractReady
          ? "The roster contract is not connected on this site yet, so this review can be read but the signature cannot be recorded."
          : !systemWallet
            ? "There is no separate System admin wallet on this roster. The sign-off stays unsigned and that fact is disclosed."
            : !signerMatches
              ? "Connect the System admin wallet recorded for this election. That wallet signs. The organizer can send the signature afterwards."
              : !ticked
                ? "Tick the statement to unlock the signature."
                : current
                  ? "This roster already has a current System admin sign-off."
                  : "Signing is free. Recording it on the chain costs a small network fee.";
    fill(section,
      h("h2", { id: "system-signoff-h" }, icon("gear", { size: 22 }), "System admin close-out"),
      electionCode ? h("p", null, "Election ", h("code", { class: "code" }, electionCode), kindWord ? ` · ${kindWord}` : "") : null,
      callout(kind === "standard" && !current ? "warn" : "info", kind === "standard" ? "Required for a standard election" : "Optional and disclosed", disclosure()),
      lines.length
        ? h("table", { class: "roster-review-table" },
            h("thead", null, h("tr", null,
              h("th", { scope: "col" }, "Position"),
              h("th", { scope: "col" }, "Duty"),
              h("th", { scope: "col" }, "Wallet"),
              h("th", { scope: "col" }, "Position id"),
              h("th", { scope: "col" }, "Duty and close-out sheet"),
            )),
            h("tbody", null, rows),
          )
        : h("p", null, "No filled positions are listed yet."),
      prepared?.rosterHash ? h("p", { class: "muted small" }, "Roster fingerprint ", h("code", { class: "code", title: prepared.rosterHash }, shortHex(prepared.rosterHash)), ". Duty sheets ", h("code", { class: "code", title: prepared.dutiesHash }, shortHex(prepared.dutiesHash)), ".") : null,
      h("label", { class: "check-row" }, box, SYSTEM_SIGNOFF_STATEMENT),
      h("div", { class: "actions" }, signBtn),
      h("p", { class: "hint" }, hint),
      statusLine,
    );
  }

  async function sign() {
    if (!ticked || !prepared || !onSign || current) return;
    const typed = systemSignOffTypedData({
      verifyingContract: prepared.contract || "",
      electionId: prepared.electionId,
      rosterHash: prepared.rosterHash,
      dutiesHash: prepared.dutiesHash,
      positionSetHash: prepared.positionSetHash,
    });
    await onSign({
      typed,
      statement: SYSTEM_SIGNOFF_STATEMENT,
      rosterHash: prepared.rosterHash,
      dutiesHash: prepared.dutiesHash,
      positionSetHash: prepared.positionSetHash,
      positionIds: prepared.positionIds,
      sheetHashes: prepared.sheetHashes,
    });
  }

  paint();
  return section;
}
