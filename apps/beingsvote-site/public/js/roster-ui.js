// Election staff roster card. Shown at the top of an election on the admin page, and on the create flow once
// the election file exists. Names and wallets are visible. Ballot codes are not.
// Linking a staff wallet uses a second WalletConnect session (staff-link.js). Approving uses the
// administrator wallet already connected on this computer.
import { fill, h, icon, badge, copyText, callout } from "./ui.js";
import { ROLE_INFO } from "./roles.js";
import { roleMark, downloadBlob } from "./staff.js";
import { headingWithHelp } from "./help.js";
import { shortAddress } from "./format.js";
import { sameAddress } from "./logic.js";
import { signWithCard } from "./tx.js";
import { startAdminRegistration } from "./admin-register.js";
import { linkStaffWallet, STAFF_LINK_BUTTON } from "./staff-link.js";
import {
  ADDABLE_ROLES,
  REGISTER_ADMIN_LABEL,
  NAME_SALT_NOTE,
  ROSTER_NOTE,
  SYSTEM_ADMIN_DUTY,
  addSeat,
  applyEdits,
  approvalMessage,
  buildApprovalMessage,
  claimIsCurrent,
  cleanName,
  lineView,
  electionKindOf,
  executiveStaffRecord,
  loadRoster,
  orderedSeats,
  recordApproval,
  recordChainClaim,
  recordLinkedClaim,
  registrationIsCurrent,
  setElectionKind,
  removeSeat,
  roleMeta,
  rosterProblems,
  readNameSalt,
  saveRoster,
  signatureMatches,
  unlinkSeat,
  verifyRosterSignatures,
  withNameSalts,
} from "./roster.js";
import { ADULT_ATTESTATION, ADULT_NOTE, CHAIN_WORD, KIND_CHOICES, chainLineStatus, claimTypedData, freshNonce, kindLabel, personNameHash, positionId } from "./staff-roster.js";

const STATUS = {
  covered: ["Covered by Election Administrator", "ok"],
  incomplete: ["Enter a first and last name", "warn"],
  named: ["Named, waiting for wallet", "warn"],
  unverified: ["Not verified", "warn"],
  linked: ["Wallet linked (staff signed)", "info"],
  approved: ["Approved by admin (both signed)", "ok"],
  registered: ["Registered", "ok"],
};

const VERIFY_LABEL = "I have verified this person's identity and that they hold this wallet.";

async function walletSign({ title, lines, facts, confirmText, message }) {
  const r = await signWithCard({
    title,
    lines,
    facts,
    confirmText,
    sign: (signer) => signer.signMessage(message),
  });
  if (r.status !== "signed") return r;
  return { status: "signed", signature: r.signature };
}

async function ethersCheckers() {
  const { loadEthers } = await import("./chain.js");
  const ethers = await loadEthers();
  return {
    verifyMessage: (message, signature) => ethers.verifyMessage(message, signature),
    hashSignature: (signature) => ethers.keccak256(signature),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.electionCode
 * @param {string} opts.organizerAddress wallet that created the election (or will)
 * @param {Storage} opts.storage
 * @param {() => boolean} [opts.canEdit] administrator may edit names, link wallets and approve
 * @param {() => string|null} [opts.connectedAddress]
 * @param {(fn: () => void) => void} [opts.watch] called when the administrator wallet changes
 * @param {typeof walletSign} [opts.sign] test hook for the administrator's signature
 * @param {typeof linkStaffWallet} [opts.linkStaff] test hook for the separate staff session
 * @param {Function} [opts.verifyMessage] (message, signature) => address
 * @param {Function} [opts.hashSignature] (signature) => 0x keccak256
 */
export function rosterCard({
  electionCode,
  organizerAddress,
  storage,
  canEdit = () => false,
  connectedAddress = () => null,
  watch,
  sign = walletSign,
  linkStaff = linkStaffWallet,
  verifyMessage,
  hashSignature,
  checkSignatures = true,
  onSaved,
  chain = null,
  staffContract = "",
  electionId = "",
  onRecordChain,
} = {}) {
  const liveChain = () => (typeof chain === "function" ? chain() : chain) || null;
  const section = h("section", { class: "card roster-card", "aria-labelledby": "roster-h" });
  const status = h("div", { role: "status" });
  let draft = null;
  let checkers = verifyMessage ? { verifyMessage, hashSignature: hashSignature ?? null } : null;
  let loadingCheck = false;
  const inTest = typeof process !== "undefined" && !!process.env?.VITEST;

  const stored = () => loadRoster(storage, electionCode, { organizerAddress });
  const viewOpts = () => ({ electionCode, organizerAddress, verifyMessage: checkers?.verifyMessage, hashSignature: checkers?.hashSignature });

  function readEdits() {
    const edits = [];
    for (const input of section.querySelectorAll("input[data-seat]")) {
      if (input.getAttribute("data-field") === "verified") continue;
      const id = input.getAttribute("data-seat");
      let row = edits.find((e) => e.id === id);
      if (!row) {
        row = { id, firstName: "", lastName: "", address: "" };
        edits.push(row);
      }
      const field = input.getAttribute("data-field");
      if (field === "firstName" || field === "lastName" || field === "address") row[field] = input.value;
    }
    return edits;
  }

  function viewRoster() {
    const base = stored();
    if (!draft) return base;
    return applyEdits(base, draft, { organizerAddress });
  }

  function persist(next) {
    const problems = rosterProblems(next);
    if (problems.length) {
      fill(status, h("p", { class: "hint" }, problems.join(" ")));
      return false;
    }
    saveRoster(storage, next);
    draft = null;
    onSaved?.(next);
    return true;
  }

  function showWarnings(slot, warnings) {
    fill(slot, warnings?.length ? callout("warn", "A signature did not check out", warnings.join(" ")) : null);
  }

  function paint() {
    const roster = viewRoster();
    const edit = !!canEdit();
    const connected = connectedAddress() || "";
    const lines = orderedSeats(roster).map((seat) => seatRow(roster, seat, { edit, connected }));
    const addRole = h(
      "select",
      { id: "roster-add-role", "aria-label": "Role to add" },
      ADDABLE_ROLES.map((id) => h("option", { value: id }, roleMeta(id).line)),
    );
    const addBtn = h("button", { class: "btn btn-sm", type: "button" }, "Add a line");
    addBtn.addEventListener("click", () => {
      draft = readEdits();
      const next = addSeat(applyEdits(stored(), draft, { organizerAddress }), addRole.value);
      if (!persist(next)) return;
      paint();
    });
    const saveBtn = h("button", { class: "btn btn-primary btn-sm", type: "button" }, "Save roster");
    saveBtn.addEventListener("click", () => {
      const next = applyEdits(stored(), readEdits(), { organizerAddress });
      if (!persist(next)) return;
      fill(status, h("p", { class: "hint" }, "Roster saved on this computer."));
      paint();
    });
    const warnings = h("div", { class: "roster-warnings" });
    fill(
      section,
      headingWithHelp("h2", { id: "roster-h" }, [icon("users", { size: 22 }), "Election staff"], "admin.roster"),
      h("p", null, "The crypto-wallet at the top right is the Election Administrator. A staff line with no name is covered by that sign-in. As soon as you enter a name, that coverage stops: that person links their own crypto-wallet and you approve them before the position is active."),
      kindControl(roster, edit),
      h("p", { class: "muted small" }, ADULT_NOTE),
      h("ul", { class: "roster-list" }, lines),
      edit
        ? h("div", { class: "row" }, addRole, addBtn, saveBtn, recordButton(roster, edit))
        : h("p", { class: "hint" }, "Only the Election Administrator can link a staff crypto-wallet or approve one."),
      h("p", { class: "muted small roster-note" }, ROSTER_NOTE),
      h("p", { class: "muted small" }, NAME_SALT_NOTE),
      edit ? h("div", { class: "actions" }, confidentialButton()) : null,
      warnings,
      status,
    );
    if (checkers?.verifyMessage) showWarnings(warnings, verifyRosterSignatures(roster, { ...checkers, organizerAddress }));
    else queueVerify(roster, warnings);
  }

  function queueVerify(roster, warnings) {
    if (!checkSignatures || inTest) return;
    if (loadingCheck) return;
    loadingCheck = true;
    ethersCheckers()
      .then((c) => {
        checkers = c;
        loadingCheck = false;
        paint();
      })
      .catch(() => {
        loadingCheck = false;
      });
  }

  function seatRow(roster, seat, { edit, connected }) {
    const line = lineView(seat, viewOpts());
    const info = ROLE_INFO[seat.role];
    const bits = [
      line.showElectionId ? h("span", { class: "roster-id" }, "Election ID ", h("code", { class: "code" }, electionCode)) : null,
      h("strong", { title: line.duty || info?.blurb || line.line }, line.line),
      line.name ? h("span", { class: line.open && line.name === "Open" ? "roster-open" : "roster-name" }, line.name) : null,
    ];
    if (line.covered && line.coveringWallet) {
      bits.push(
        h(
          "span",
          { class: "roster-addr", "data-covering": seat.id },
          h("code", { class: "code", title: line.coveringWallet }, shortAddress(line.coveringWallet)),
          h(
            "button",
            {
              class: "icon-btn",
              type: "button",
              "aria-label": `Copy the Election Administrator sign-in that covers ${line.line}`,
              title: line.coveringWallet,
              onClick: () => copyText(line.coveringWallet, "Wallet address copied"),
            },
            icon("copy", { size: 16 }),
          ),
        ),
      );
    } else if (line.address) {
      bits.push(
        h(
          "span",
          { class: "roster-addr" },
          h("code", { class: "code", title: line.address }, shortAddress(line.address)),
          h(
            "button",
            { class: "icon-btn", type: "button", "aria-label": `Copy the ${line.line} wallet address`, title: line.address, onClick: () => copyText(line.address, "Wallet address copied") },
            icon("copy", { size: 16 }),
          ),
        ),
      );
    }
    if (line.status !== "open" && STATUS[line.status]) {
      const [label, tone] = STATUS[line.status];
      bits.push(h("span", { "data-seat-status": seat.id }, badge(label, tone)));
    }
    if (!line.active && line.status !== "open" && line.status !== "covered" && line.status !== "registered") {
      bits.push(h("span", { class: "roster-wait" }, "Not active yet"));
    }
    const chainNow = liveChain();
    if (chainNow?.configured) {
      const chainStatus = chainLineStatus(seat, chainNow);
      bits.push(badge(CHAIN_WORD[chainStatus] || chainStatus, chainStatus === "locked" ? "ok" : chainStatus === "recorded" ? "info" : "warn"));
    }
    if (line.claimSignedAt) bits.push(h("time", { class: "roster-time", datetime: line.claimSignedAt }, `Staff signed ${line.claimSignedAt}`));
    if (line.grantSignedAt) bits.push(h("time", { class: "roster-time", datetime: line.grantSignedAt }, `Approved ${line.grantSignedAt}`));
    const registered = seat.id === "admin" && registrationIsCurrent(seat, electionCode);
    const fields = registered ? readOnlyAdmin(seat) : edit ? editFields(roster, seat, line) : null;
    const actions = actionButtons(roster, seat, line, { edit, connected });
    const register = registered
      ? null
      : seat.id === "admin"
        ? h(
            "button",
            {
              class: "btn btn-primary register-admin-btn",
              type: "button",
              onClick: () =>
                startAdminRegistration({
                  electionCode,
                  organizerAddress,
                  storage,
                  readNames: () => ({
                    first: section.querySelector("#roster-admin-first")?.value ?? "",
                    last: section.querySelector("#roster-admin-last")?.value ?? "",
                  }),
                  onDone: () => paint(),
                }),
            },
            REGISTER_ADMIN_LABEL,
          )
        : null;
    return h(
      "li",
      {
        class: `roster-line${line.open ? " is-open" : ""}${line.covered ? " is-covered" : ""}${registered ? " is-registered" : ""}`,
        "data-roster-status": line.status,
        "data-roster-active": line.active ? "true" : "false",
      },
      roleMark(info, { px: 40 }),
      h(
        "div",
        { class: "roster-body" },
        register,
        h("div", { class: "roster-main" }, bits),
        line.duty ? h("p", { class: "roster-duty muted small", title: line.duty }, line.duty) : null,
        fields,
        actions,
      ),
    );
  }

  function readOnlyAdmin(seat) {
    const fixed = (label, value, extra = {}) => h("label", { class: "roster-field" }, label, h("input", { value, readonly: true, class: extra.mono ? "plain-mono" : null, "aria-label": `Election Administrator ${label.toLowerCase()}` }));
    return h("div", { class: "roster-fields" }, fixed("First name", seat.firstName), fixed("Last name", seat.lastName), fixed("Wallet", seat.address, { mono: true }));
  }

  function editFields(roster, seat, line) {
    const first = h("input", { id: `roster-${seat.id}-first`, "data-seat": seat.id, "data-field": "firstName", value: seat.firstName, autocomplete: "given-name", placeholder: "First name", "aria-label": `${line.line} first name` });
    const last = h("input", { id: `roster-${seat.id}-last`, "data-seat": seat.id, "data-field": "lastName", value: seat.lastName, autocomplete: "family-name", placeholder: "Last name", "aria-label": `${line.line} last name` });
    const kids = [h("label", { class: "roster-field" }, "First name", first), h("label", { class: "roster-field" }, "Last name", last)];
    let addr = null;
    if (seat.id !== "admin") {
      const linked = claimIsCurrent(seat, electionCode, checkers?.verifyMessage);
      addr = h("input", {
        id: `roster-${seat.id}-addr`,
        "data-seat": seat.id,
        "data-field": "address",
        value: seat.address,
        autocomplete: "off",
        spellcheck: "false",
        class: "plain-mono",
        placeholder: "Wallet 0x… (optional, not verified)",
        "aria-label": `${line.line} wallet address`,
        readonly: linked ? true : null,
      });
      if (linked) addr.readOnly = true;
      const started = !!(seat.firstName || seat.lastName);
      const walletLabel = h("label", { class: "roster-field", hidden: started ? null : true }, linked ? "Wallet (linked)" : "Wallet", addr);
      kids.push(walletLabel);
    }
    const linkBtn = h("button", { class: "btn btn-sm", type: "button", id: `roster-${seat.id}-link` }, STAFF_LINK_BUTTON);
    linkBtn.addEventListener("click", () => linkSeat(seat));
    const sync = () => {
      if (seat.id === "admin") return;
      const namesReady = !!(cleanName(first.value) && cleanName(last.value));
      const started = !!(cleanName(first.value) || cleanName(last.value));
      const nameSame = cleanName(first.value) === seat.firstName && cleanName(last.value) === seat.lastName;
      const typed = addr ? addr.value.trim() : "";
      const addrSame = typed.toLowerCase() === String(seat.address || "").toLowerCase();
      const linked = claimIsCurrent(seat, electionCode, checkers?.verifyMessage) && nameSame && addrSame && namesReady;
      linkBtn.hidden = !namesReady || linked;
      const walletLabel = addr?.closest("label");
      if (walletLabel) walletLabel.hidden = !started;
      const cover = section.querySelector(`[data-covering="${seat.id}"]`);
      if (cover) cover.hidden = started;
      const badgeHost = section.querySelector(`[data-seat-status="${seat.id}"]`);
      if (badgeHost && !linked) {
        const label = !started ? "Covered by Election Administrator" : !namesReady ? "Enter a first and last name" : typed ? "Not verified" : "Named, waiting for wallet";
        const tone = started ? "warn" : "ok";
        fill(badgeHost, badge(label, tone));
      }
      const row = first.closest("li");
      const waiting = started && !linked;
      let wait = row?.querySelector(".roster-wait");
      if (waiting && row && !wait) {
        wait = h("span", { class: "roster-wait" }, "Not active yet");
        row.querySelector(".roster-main")?.append(wait);
      } else if (!waiting && wait) wait.remove();
      if (!linked) {
        const approve = section.querySelector(`#roster-${seat.id}-approve`);
        const box = section.querySelector(`#roster-${seat.id}-verified`);
        if (approve) approve.disabled = true;
        if (box) box.checked = false;
      }
    };
    first.addEventListener("input", sync);
    last.addEventListener("input", sync);
    addr?.addEventListener("input", sync);
    sync();
    if (seat.id !== "admin") kids.push(linkBtn);
    if (String(seat.id).includes("-")) {
      const remove = h("button", { class: "btn btn-sm", type: "button" }, "Remove");
      remove.addEventListener("click", () => {
        draft = readEdits().filter((e) => e.id !== seat.id);
        const next = removeSeat(applyEdits(stored(), draft, { organizerAddress }), seat.id);
        if (!persist(next)) return;
        paint();
      });
      kids.push(remove);
    }
    return h("div", { class: "roster-fields" }, kids);
  }

  function actionButtons(roster, seat, line, { edit }) {
    if (seat.id === "admin" || !edit || line.status === "registered") return null;
    const buttons = [];
    const hasWallet = !!(seat.address || seat.claim);
    if (hasWallet) {
      const unlink = h("button", { class: "btn btn-sm", type: "button", id: `roster-${seat.id}-unlink` }, "Unlink");
      unlink.addEventListener("click", () => {
        const edited = applyEdits(stored(), readEdits(), { organizerAddress });
        try {
          if (!persist(unlinkSeat(edited, seat.id))) return;
        } catch (e) {
          fill(status, h("p", { class: "hint" }, String(e?.message ?? e)));
          return;
        }
        paint();
      });
      buttons.push(unlink);
    }
    if (line.status === "linked") {
      const kind = electionKindOf(roster);
      const needsAdult = kind === "standard" || kind === "test";
      const box = h("input", { type: "checkbox", id: `roster-${seat.id}-verified`, "data-seat": seat.id, "data-field": "verified" });
      const adult = needsAdult ? h("input", { type: "checkbox", id: `roster-${seat.id}-adult`, "data-seat": seat.id, "data-field": "adult" }) : null;
      const approve = h("button", { class: "btn btn-sm btn-primary", type: "button", id: `roster-${seat.id}-approve`, disabled: true }, "Approve with my wallet");
      const syncApprove = () => {
        approve.disabled = !box.checked || (adult ? !adult.checked : false);
      };
      box.addEventListener("change", syncApprove);
      adult?.addEventListener("change", syncApprove);
      approve.addEventListener("click", () => approveSeat(seat));
      buttons.push(h("label", { class: "check-row roster-verify" }, box, VERIFY_LABEL));
      if (adult) buttons.push(h("label", { class: "check-row roster-verify" }, adult, ADULT_ATTESTATION));
      buttons.push(approve);
    }
    if (line.status === "approved" && staffContract && !seat.chainClaim) {
      const chainBtn = h("button", { class: "btn btn-sm", type: "button", id: `roster-${seat.id}-chain` }, "Sign for the chain");
      chainBtn.addEventListener("click", () => linkSeat(seat, { chainOnly: true }));
      buttons.push(chainBtn);
    }
    return buttons.length ? h("div", { class: "roster-actions" }, buttons) : null;
  }

  function kindControl(roster, edit) {
    const chainNow = liveChain();
    const current = chainNow?.known ? chainNow.kind : electionKindOf(roster);
    if (chainNow?.known) return h("p", null, badge(kindLabel(current), current === "standard" ? "ok" : "info"), h("span", { class: "muted small" }, " Recorded on the chain. This cannot be changed."));
    if (!edit) return current ? h("p", null, badge(kindLabel(current), "info")) : null;
    return h("fieldset", { class: "roster-kind" },
      h("legend", null, "Election type"),
      h("p", { class: "muted small" }, "Choose this before the Election Administrator is recorded on the chain. It cannot be changed afterwards."),
      ...KIND_CHOICES.map((choice) => {
        const input = h("input", { type: "radio", name: "roster-kind", value: choice.id, checked: electionKindOf(roster) === choice.id ? true : null });
        input.addEventListener("change", () => {
          if (!input.checked) return;
          try {
            const next = setElectionKind(applyEdits(stored(), readEdits(), { organizerAddress }), choice.id);
            if (!persist(next)) return;
          } catch (e) {
            fill(status, h("p", { class: "hint" }, String(e?.message ?? e)));
            return;
          }
          paint();
        });
        return h("label", { class: "roster-kind-choice" }, input, h("span", null, h("strong", null, choice.label), " — ", choice.detail));
      }),
    );
  }

  function confidentialButton() {
    const button = h("button", { class: "btn btn-sm", type: "button", id: "roster-confidential-download" }, "Download the confidential staff record");
    button.addEventListener("click", () => {
      const next = withNameSalts(applyEdits(stored(), readEdits(), { organizerAddress }));
      if (!persist(next)) return;
      try {
        const record = executiveStaffRecord(stored());
        downloadBlob(`${electionCode}-CONFIDENTIAL-staff-record.json`, JSON.stringify(record, null, 2), "application/json");
        fill(status, h("p", { class: "hint" }, "The confidential staff record downloaded. Keep it with the administrator. It is not the public copy."));
      } catch (e) {
        fill(status, h("p", { class: "hint" }, String(e?.message ?? e)));
      }
    });
    return button;
  }

  function recordButton(roster) {
    const chainNow = liveChain();
    if (!onRecordChain || !chainNow?.configured || !chainNow?.known || chainNow.locked) return null;
    if ((chainNow.kind || electionKindOf(roster)) === "classroom") return null;
    const btn = h("button", { class: "btn btn-sm", type: "button", id: "roster-record-chain" }, "Record roster on-chain");
    btn.addEventListener("click", () => onRecordChain(stored()));
    return btn;
  }

  async function linkSeat(seat, { chainOnly = false } = {}) {
    const edited = withNameSalts(applyEdits(stored(), readEdits(), { organizerAddress }));
    if (!persist(edited)) return;
    const live = stored().seats.find((s) => s.id === seat.id);
    if (!live?.firstName || !live?.lastName) return;
    if (!readNameSalt(live.nameSalt)) return;
    const meta = roleMeta(live.role);
    const r = await linkStaff({
      firstName: live.firstName,
      lastName: live.lastName,
      position: meta.line,
      electionCode,
      chainOnly,
      chainTypedDataFor: staffContract && electionId
        ? async (address) => {
            const { loadEthers } = await import("./chain.js");
            const ethers = await loadEthers();
            const nonce = freshNonce();
            const nameHash = personNameHash(ethers, live.firstName, live.lastName, live.nameSalt);
            const pid = positionId(ethers, live.role, live.id);
            const typed = claimTypedData({ verifyingContract: staffContract, electionId, positionId: pid, wallet: address, nameHash, nonce });
            return { ...typed, nonce, nameHash };
          }
        : undefined,
    });
    if (r.status !== "signed") {
      if (r.status === "failed") fill(status, h("p", { class: "hint" }, r.message));
      paint();
      return;
    }
    try {
      const checker = checkers?.verifyMessage ?? (await ethersCheckers()).verifyMessage;
      if (!chainOnly && !signatureMatches(r.message, r.signature, r.address, checker)) throw new Error("The signature did not match the crypto-wallet that scanned the code.");
      if (chainOnly && !sameAddress(r.address, live.address)) throw new Error("Sign for the chain with the crypto-wallet already linked to this line.");
      let next = chainOnly ? stored() : recordLinkedClaim(stored(), live.id, r);
      if (r.chainSignature) next = recordChainClaim(next, live.id, { signature: r.chainSignature, nonce: r.chainNonce, nameHash: r.chainNameHash });
      if (!persist(next)) return;
    } catch (e) {
      fill(status, h("p", { class: "hint" }, String(e?.message ?? e)));
      paint();
      return;
    }
    fill(status, h("p", { class: "hint" }, `${live.firstName} ${live.lastName}'s wallet is linked. Approve it after you have checked their identity.`));
    paint();
  }

  async function approveSeat(seat) {
    const box = section.querySelector(`#roster-${seat.id}-verified`);
    if (!box?.checked) {
      fill(status, h("p", { class: "hint" }, VERIFY_LABEL));
      return;
    }
    const edited = applyEdits(stored(), readEdits(), { organizerAddress });
    if (!persist(edited)) return;
    const current = stored();
    const live = current.seats.find((s) => s.id === seat.id);
    const admin = current.seats.find((s) => s.id === "admin");
    if (!live || !claimIsCurrent(live, electionCode, checkers?.verifyMessage)) {
      fill(status, h("p", { class: "hint" }, "The name or crypto-wallet changed, so the previous signature was cleared. Link the crypto-wallet again."));
      paint();
      return;
    }
    if (!admin?.firstName || !admin?.lastName) {
      fill(status, h("p", { class: "hint" }, "Enter the Election Administrator's first and last name before approving."));
      paint();
      return;
    }
    if (!sameAddress(connectedAddress(), organizerAddress)) {
      fill(status, h("p", { class: "hint" }, "Connect the Election Administrator wallet at the top right to approve. It stays connected while a staff member scans."));
      paint();
      return;
    }
    let hash = "";
    try {
      const hashFn = checkers?.hashSignature ?? (await ethersCheckers()).hashSignature;
      if (!checkers?.hashSignature) checkers = { ...(checkers ?? {}), hashSignature: hashFn, verifyMessage: checkers?.verifyMessage };
      hash = hashFn(live.claim.signature);
    } catch (e) {
      fill(status, h("p", { class: "hint" }, String(e?.message ?? e)));
      return;
    }
    const signedAt = new Date().toISOString();
    const adminName = `${admin.firstName} ${admin.lastName}`;
    const meta = roleMeta(live.role);
    let message = "";
    try {
      message = buildApprovalMessage({
        adminName,
        adminWallet: organizerAddress,
        firstName: live.firstName,
        lastName: live.lastName,
        staffWallet: live.address,
        position: meta.line,
        electionCode,
        claimHash: hash,
        signedAt,
      });
    } catch (e) {
      fill(status, h("p", { class: "hint" }, String(e?.message ?? e)));
      return;
    }
    const r = await sign({
      title: `Approve ${meta.line}`,
      lines: [
        `You are approving ${live.firstName} ${live.lastName} as ${meta.line} for ${electionCode}.`,
        VERIFY_LABEL,
        live.role === "system" ? SYSTEM_ADMIN_DUTY : "This signature stays on this computer and in the election download.",
        "This readable approval stays on this computer. Recording the crypto-wallet on the chain is the next step, and you pay that network fee.",
      ],
      facts: [
        ["Election", electionCode],
        ["Position", meta.line],
        ["Staff wallet", live.address],
        ["Time", signedAt],
      ],
      confirmText: "Sign the approval",
      message,
    });
    if (r.status !== "signed") {
      if (r.status === "failed") fill(status, h("p", { class: "hint" }, r.message));
      paint();
      return;
    }
    try {
      const checker = checkers?.verifyMessage ?? (await ethersCheckers()).verifyMessage;
      if (!signatureMatches(message, r.signature, organizerAddress, checker)) throw new Error("The signature was not from the Election Administrator wallet.");
      if (approvalMessage({ ...live, grant: { adminName, claimHash: hash, signedAt, grantor: organizerAddress, signature: r.signature, message } }, electionCode, organizerAddress) !== message) {
        throw new Error("The approval text did not match this line.");
      }
      const adult = section.querySelector(`#roster-${live.id}-adult`);
      if (adult && !adult.checked) throw new Error(ADULT_ATTESTATION);
      const adultAttested = !!adult?.checked;
      if (!persist(recordApproval(current, live.id, { signature: r.signature, signedAt, grantor: organizerAddress, adminName, claimHash: hash, adultAttested }))) return;
    } catch (e) {
      fill(status, h("p", { class: "hint" }, String(e?.message ?? e)));
      paint();
      return;
    }
    fill(status, h("p", { class: "hint" }, `${live.firstName} ${live.lastName} is approved for this election on this computer.`));
    paint();
  }

  if (watch) {
    watch(() => {
      const edits = readEdits();
      if (edits.length) draft = edits;
      paint();
    });
  }
  paint();
  return section;
}
