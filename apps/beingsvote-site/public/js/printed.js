// Use ballots that are already printed. The file's codes and fingerprints stay as they are.
// Changing the opening or closing time rewrites those two fields and the fingerprint together.
// Each ballot is signed and sent on its own, from the connected wallet. Nothing is sent when a file is chosen.
import { labelWithHelp, headingWithHelp } from "./help.js";
import { fill, h, icon, badge, callout, toast } from "./ui.js";
import { state, ensureCoston2, onCoston2 } from "./roles.js";
import { CONFIG } from "./config.js";
import { getElection, getBallotEntry, getWalletFacts, getEthers, readStaffRoster, registrySupportsBallotPool } from "./chain.js";
import { canonicalize, sha256Hex, shortHash } from "./format.js";
import {
  unwrapElectionImport, withSchedule, importProblems, ballotListRootOf, chainAgrees, utf8, walletProduced,
  publicElectionCopy, ballotPoolProof, ballotPoolsFromFile, createElectionCall, creationElectionFile,
  assessReadings, readingTally, readingTypedData, submissionGate, ballotRecord, submitRecordArgs, resultWord, unixFromIso,
} from "./logic.js";
import { sendTx, signWithCard } from "./tx.js";
import { downloadBlob, hashText, kvList, busy } from "./staff.js";

let hashFn = null;
async function keccak() {
  if (!hashFn) {
    const ethers = await getEthers();
    hashFn = (bytes) => ethers.keccak256(bytes);
  }
  return hashFn;
}

function readJsonFile(file) {
  return file.text().then((text) => JSON.parse(text));
}

function maskCode(code) {
  return `••••-••••-${code.slice(8)}`;
}

async function fingerprint(file) {
  return "0x" + (await sha256Hex(utf8(canonicalize(file))));
}

export function importCard(ctx) {
  const out = h("div", { class: "stack" });
  const fileIn = h("input", { id: "p-file", type: "file", accept: "application/json,.json" });
  const manIn = h("input", { id: "p-man", type: "file", accept: "application/json,.json" });
  const opens = h("input", { id: "p-open", class: "plain-mono", spellcheck: "false", autocomplete: "off", "aria-label": "Voting opens" });
  const closes = h("input", { id: "p-close", class: "plain-mono", spellcheck: "false", autocomplete: "off", "aria-label": "Voting closes" });
  const readIn = h("input", { id: "p-read", type: "file", accept: "application/json,.json" });
  const pick = h("select", { id: "p-pick", "aria-label": "Which ballot" }, h("option", { value: "" }, "Choose one ballot"));
  const review = h("div");
  const status = h("div", { role: "status" });
  let original = null;
  let current = null;
  let manifest = null;
  let datesChanged = false;
  let readings = [];
  const signed = new Map();

  const paintFile = async () => {
    if (!current) return fill(status, callout("info", "No election file yet", "Choose the full file that was saved with the printed ballots. Nothing is sent."));
    const fileSha = await fingerprint(current);
    const root = ballotListRootOf(current.ballotCodes, await keccak());
    const baselineSha = await fingerprint(original ?? current);
    const problems = importProblems({ file: current, manifest, fileSha256: fileSha, ballotListRoot: root, datesChanged, baselineSha256: baselineSha });
    const tallyNote = `${current.questions.length} questions, ${current.ballotCodes.length} printed ballots, ${current.registeredVoters} registered voters, quorum ${current.quorum}.`;
    fill(status,
      problems.length
        ? callout("warn", "This file can't be registered yet", "Fix the file, or undo the schedule change. Nothing was sent.")
        : callout("ok", datesChanged ? "Schedule updated, fingerprint updated with it" : "This file matches its ballot list", datesChanged ? "The opening and closing times in the file changed, so the fingerprint changed too. The ballot codes did not. Download the updated secret file and keep that one. The old fingerprint is no longer the one that will be registered." : "The codes, questions and fingerprints below are what will be registered. Nothing has been sent.", "check"),
      problems.length ? h("ul", { class: "plain-list" }, problems.map((p) => h("li", null, p.message))) : null,
      kvList([
        ["Election", `${current.name} (${current.electionCode})`],
        ["File fingerprint", hashText(fileSha, 14, 10)],
        ["Ballot list fingerprint", hashText(root, 14, 10)],
        ["Opens", current.opensAt],
        ["Closes", current.closesAt],
        ["Printed ballots", String(current.ballotCodes.length)],
      ]),
      h("p", { class: "muted small" }, tallyNote, " Ballot codes stay in this browser. They are not written to the site."),
    );
    opens.value = current.opensAt;
    closes.value = current.closesAt;
  };

  fileIn.addEventListener("change", () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    readJsonFile(f).then((json) => {
      const got = unwrapElectionImport(json);
      if (got.error) {
        original = current = null;
        return fill(status, callout("warn", "That file can't be used", got.error));
      }
      original = got.file;
      current = got.file;
      datesChanged = false;
      signed.clear();
      return paintFile();
    }).catch(() => fill(status, callout("warn", "That file isn't JSON", "Nothing was read from it.")));
  });

  manIn.addEventListener("change", () => {
    const f = manIn.files?.[0];
    if (!f) return;
    readJsonFile(f).then((json) => {
      manifest = json;
      return paintFile();
    }).catch(() => fill(status, callout("warn", "That manifest isn't JSON", "Nothing was read from it.")));
  });

  const applyTimes = () => {
    if (!original) return toast("Choose the election file first.");
    const o = opens.value.trim();
    const c = closes.value.trim();
    if (unixFromIso(o) == null || unixFromIso(c) == null) return toast("Opening and closing times need to look like 2026-11-16T16:00:00Z.");
    if (unixFromIso(c) <= unixFromIso(o)) return toast("Voting has to close after it opens.");
    datesChanged = o !== original.opensAt || c !== original.closesAt;
    current = datesChanged ? withSchedule(original, o, c) : original;
    signed.clear();
    paintFile();
  };

  const createBtn = h("button", { class: "btn btn-primary", type: "button" }, "Register this election");
  createBtn.addEventListener("click", () => busy(createBtn, "Checking…", async () => {
    if (!current) return toast("Choose the election file first.");
    if (!state.address) return toast("Connect the organizer wallet first. Nothing was sent.");
    const fileSha = await fingerprint(current);
    const root = ballotListRootOf(current.ballotCodes, await keccak());
    const baselineSha = await fingerprint(original ?? current);
    const problems = importProblems({ file: current, manifest, fileSha256: fileSha, ballotListRoot: root, datesChanged, baselineSha256: baselineSha });
    if (problems.length) return fill(status, callout("warn", "Not registered", problems[0].message));
    let chain = null;
    try {
      chain = await getElection(current.electionCode);
    } catch (e) {
      return fill(status, callout("warn", "The ledger didn't answer", "Nothing was sent. Try again in a minute."));
    }
    const agree = chainAgrees(current, chain ? { ...chain, fileSha256: chain.version.fileSha256 } : null, { fileSha256: fileSha, ballotListRoot: root });
    if (agree.state === "match") {
      return fill(status, callout("ok", "Already on the ledger", "This code, fingerprint and ballot list are already registered. Nothing was sent. Use the election above to register the scanning wallet and open voting.", "check"));
    }
    if (agree.state === "conflict") {
      return fill(status, callout("warn", "This code is already a different election", "The ledger has this election code with a different fingerprint or ballot list. These printed ballots were not registered over it. Nothing was sent."));
    }
    const cid = `local-unpublished:${current.electionCode}`;
    const poolEnforced = await registrySupportsBallotPool();
    const call = createElectionCall(current, { cid, fileSha256: fileSha, ballotListRoot: root }, poolEnforced);
    const r = await sendTx({
      contract: "registry",
      method: call.method,
      args: call.args,
      title: "Register the printed ballots",
      lines: [
        "This registers the election file you loaded. It does not make new ballot codes.",
        datesChanged ? "You changed the opening and closing times, and the fingerprint above is the hash of that updated file. Keep the downloaded copy." : "The fingerprint is the hash of the file you loaded.",
        "Your wallet becomes the organizer. The ballot codes themselves are not written on the ledger, only their fingerprint.",
        poolEnforced
          ? "This election checks the ballot pool. Only a code in this file, or one you add before opening, can be recorded."
          : "This ledger does not have ballot-pool checks yet, so this election is registered the old way.",
      ],
      facts: [["Election", current.electionCode], ["File fingerprint", fileSha], ["Ballot list fingerprint", root], ["Opens", current.opensAt], ["Closes", current.closesAt], ["Ballots", String(current.ballotCodes.length)]],
      confirmText: "Register election",
    });
    if (r.status === "cancelled") return fill(status, callout("info", "Nothing was sent", "You cancelled. The file is still only in this browser."));
    if (r.status === "failed") return fill(status, callout("warn", "Not registered", r.message));
    fill(status, callout("ok", "Registered", "Next, open this election on the admin page, register the scanning wallet, then come back here to record one ballot.", "check"), h("p", null, h("a", { href: `#/admin?e=${current.electionCode}` }, "Open this election")));
  }));

  const downloadFull = h("button", { class: "btn", type: "button" }, "Download the updated secret file");
  downloadFull.addEventListener("click", () => {
    if (!current || !datesChanged) return toast("The file is unchanged, so keep the original. Download is for a schedule you edited.");
    downloadBlob(`${current.electionCode}-SECRET-full-file.json`, JSON.stringify(current, null, 2), "application/json");
  });
  const downloadPub = h("button", { class: "btn", type: "button" }, "Download the public questions");
  downloadPub.addEventListener("click", () => {
    if (!current) return toast("Choose the election file first.");
    const pub = publicElectionCopy(current);
    downloadBlob(`${current.electionCode}-public.json`, JSON.stringify({ publicCopy: true, note: "Ballot codes removed. This copy's fingerprint will not match the ledger.", omitted: ["ballotCodes", "addedBallotPools"], omittedCount: current.ballotCodes.length, file: pub }, null, 2), "application/json");
  });

  readIn.addEventListener("change", () => {
    const f = readIn.files?.[0];
    if (!f) return;
    if (!current) return fill(review, callout("warn", "Choose the election file first", "Readings are checked against that file. Nothing was sent."));
    readJsonFile(f).then(async (json) => {
      const checked = assessReadings(json, current, await keccak());
      readings = checked.readings;
      signed.clear();
      pick.replaceChildren(h("option", { value: "" }, "Choose one ballot"));
      if (checked.problems.length) {
        readings = [];
        return fill(review, callout("warn", "These readings can't be used", "Nothing was sent."), h("ul", { class: "plain-list" }, checked.problems.slice(0, 12).map((p) => h("li", null, p))));
      }
      const totals = readingTally(readings);
      readings.forEach((r, i) => {
        const marks = [r.counts.U ? `${r.counts.U} unclear` : null, r.counts.O ? `${r.counts.O} overvote` : null, r.counts.B ? `${r.counts.B} blank` : null].filter(Boolean).join(", ");
        pick.append(h("option", { value: String(i) }, `${r.scan ? `Scan ${r.scan}` : `Ballot ${i + 1}`} · ${maskCode(r.ballotCode)}${marks ? ` · ${marks}` : ""}`));
      });
      fill(review, callout("info", `${readings.length} ballots in this file`, `${totals.U} unclear answers, ${totals.O} overvotes and ${totals.B} blanks stay as the scanner recorded them. This page does not decide a winner. Choose one ballot. Nothing has been signed or sent.`));
    }).catch(() => fill(review, callout("warn", "That file isn't JSON", "Nothing was read from it.")));
  });

  const reviewBtn = h("button", { class: "btn", type: "button" }, "Review this ballot");
  const signBtn = h("button", { class: "btn", type: "button" }, "Sign this reading");
  const sendBtn = h("button", { class: "btn btn-primary", type: "button" }, "Record this ballot");

  const selected = () => readings[Number(pick.value)] ?? null;

  const showOne = async () => {
    const one = selected();
    if (!one || !current) return fill(review, callout("info", "Choose one ballot", "Nothing is signed until you press Sign."));
    const lines = current.questions.map((q) => `${q.id} ${one.results[q.id]} (${resultWord(one.results[q.id])})`);
    let chainNote = "The ledger was not checked yet.";
    let found = false;
    let spoiled = false;
    let role = 0;
    let status = 0;
    try {
      const el = await getElection(current.electionCode);
      if (!el) chainNote = "This election is not on the ledger yet.";
      else {
        status = el.status;
        const entry = await getBallotEntry(el, one.ballotCode, current.questions.length);
        found = entry.found;
        spoiled = entry.spoiled;
        chainNote = found ? "This ballot is already on the ledger." : spoiled ? "This ballot is marked spoiled." : "This ballot is not on the ledger yet.";
        if (state.address) role = (await getWalletFacts(state.address, el)).role;
      }
    } catch {
      chainNote = "The ledger didn't answer. You can still read the scores below.";
    }
    const sig = signed.get(one.ballotCode);
    fill(review,
      callout(found ? "ok" : "info", chainNote, found ? "It will not be sent again." : "Blank, overvote and unclear answers are shown as recorded."),
      h("p", { class: "mono small" }, one.resultsString),
      h("ul", { class: "plain-list" }, lines.map((l) => h("li", null, l))),
      kvList([
        ["Picture fingerprint", hashText(one.imageSha256, 10, 8)],
        ["Scores fingerprint", hashText(one.scoresHash, 10, 8)],
        ["Signed", sig ? "Yes, in this browser only" : "Not yet"],
        ["Scanning wallet", state.address ? (role === 1 ? "Registered" : "Not registered for this election") : "Not connected"],
      ]),
      h("p", { class: "muted small" }, "The picture itself is not uploaded from this page. To store it, use the scanner upload command with the same file. The upload token stays in that command's environment, not in the browser. The fingerprint above has to match the file byte for byte."),
      h("div", { class: "actions" }, signBtn, sendBtn),
    );
    signBtn.disabled = found || spoiled;
    sendBtn.disabled = found || spoiled || !sig;
    one._chain = { found, spoiled, role, status };
  };
  reviewBtn.addEventListener("click", () => showOne());

  signBtn.addEventListener("click", () => busy(signBtn, "Waiting…", async () => {
    const one = selected();
    if (!one) return;
    if (!state.address) return toast("Connect the scanning wallet first. Nothing was signed.");
    if (!onCoston2()) {
      try { await ensureCoston2(); } catch { /* the next check reports it */ }
      if (!onCoston2()) return fill(review, callout("warn", "Wrong network", "Switch the wallet to Coston2 (chain id 114). Nothing was signed."));
    }
    const typed = readingTypedData({
      electionKey: one.electionKey,
      ballotKey: one.ballotKey,
      resultsHash: one.resultsHash,
      imageSha256: `0x${one.imageSha256}`,
      scoresHash: one.scoresHash,
      verifyingContract: CONFIG.contracts.ledger,
    });
    const r = await signWithCard({
      title: "Sign this ballot reading",
      lines: ["Your wallet signs the result string, the score fingerprint and the picture fingerprint. It does not see the ballot code. Signing costs nothing and does not record the ballot."],
      facts: [["Answers", one.resultsString], ["Unclear", String(one.counts.U)], ["Overvote", String(one.counts.O)], ["Blank", String(one.counts.B)]],
      confirmText: "Sign reading",
      sign: (signer) => signer.signTypedData(typed.domain, typed.types, typed.message),
    });
    if (r.status === "cancelled") return fill(review, callout("info", "Nothing was signed", "You cancelled. This ballot is not on the ledger."));
    if (!walletProduced(r, "signature")) return fill(review, callout("warn", "Not signed", r.message ?? "The wallet did not sign."));
    const ethers = await getEthers();
    let who = null;
    try { who = ethers.verifyTypedData(typed.domain, typed.types, typed.message, r.signature); } catch { who = null; }
    if (!who || who.toLowerCase() !== state.address.toLowerCase()) {
      signed.delete(one.ballotCode);
      return fill(review, callout("warn", "The signature is not from this wallet", "It was discarded. Nothing was sent."));
    }
    signed.set(one.ballotCode, { signature: r.signature, device: who, typed });
    toast("Signed in this browser. It is not on the ledger until you record it.");
    return showOne();
  }));

  sendBtn.addEventListener("click", () => busy(sendBtn, "Checking…", async () => {
    const one = selected();
    const sig = one && signed.get(one.ballotCode);
    if (!one || !sig) return toast("Sign this ballot first. Nothing was sent.");
    let found = one._chain?.found ?? false;
    let spoiled = one._chain?.spoiled ?? false;
    let role = one._chain?.role ?? 0;
    let status = one._chain?.status ?? 0;
    try {
      const el = await getElection(current.electionCode);
      if (el) {
        status = el.status;
        const entry = await getBallotEntry(el, one.ballotCode, current.questions.length);
        found = entry.found;
        spoiled = entry.spoiled;
        if (String(el.ballotListRoot).toLowerCase() !== ballotListRootOf(current.ballotCodes, await keccak()).toLowerCase()) {
          return fill(review, callout("warn", "This is not the printed ballot list", "The election on the ledger has a different ballot-list fingerprint. Nothing was sent."));
        }
        const fileSha = await fingerprint(creationElectionFile(current));
        if (String(el.version.fileSha256).toLowerCase() !== fileSha.toLowerCase()) {
          return fill(review, callout("warn", "The ledger has a different election file", "The fingerprint on the ledger does not match the file in this browser. Nothing was sent."));
        }
        if (state.address) role = (await getWalletFacts(state.address, el)).role;
      }
    } catch {
      return fill(review, callout("warn", "The ledger didn't answer", "Nothing was sent."));
    }
    let approvedScanners = null;
    try {
      const staffRoster = await readStaffRoster(el.key);
      if (staffRoster.scannerWallets?.length) approvedScanners = staffRoster.scannerWallets;
    } catch {
      approvedScanners = null;
    }
    const gate = submissionGate({
      chainId: state.chainId,
      verifyingContract: CONFIG.contracts.ledger,
      ledger: CONFIG.contracts.ledger,
      role,
      status,
      found,
      spoiled,
      quorum: current.quorum,
      signer: sig.device,
      device: state.address,
      approvedScanners,
    });
    if (!gate.ok) return fill(review, callout("warn", "Not recorded", gate.reason));
    const record = ballotRecord({
      electionCode: current.electionCode,
      ballotCode: one.ballotCode,
      results: one.results,
      fillScores: one.fillScores,
      imageSha256: one.imageSha256,
      device: sig.device,
      signature: sig.signature,
    });
    const recordSha = "0x" + (await sha256Hex(utf8(canonicalize(record))));
    let pool = null;
    if (status === 2) {
      try {
        const elNow = await getElection(current.electionCode);
        if (elNow?.poolEnforced) {
          pool = ballotPoolProof(ballotPoolsFromFile(current), one.ballotCode, await keccak());
          if (!pool) return fill(review, callout("warn", "Not in the ballot pool", "This ballot is not in the secret file's ballot pool. Nothing was sent."));
        }
      } catch {
        return fill(review, callout("warn", "The ledger didn't answer", "Nothing was sent."));
      }
    }
    const args = submitRecordArgs({
      electionKey: one.electionKey,
      ballotKey: one.ballotKey,
      resultsString: one.resultsString,
      imageSha256: `0x${one.imageSha256}`,
      recordSha256: recordSha,
      scoresHash: one.scoresHash,
      device: sig.device,
      signature: sig.signature,
      ...(pool ? { proof: pool.proof, rootIndex: pool.rootIndex } : {}),
    });
    const r = await sendTx({
      contract: "ledger",
      method: "submitRecord",
      args,
      title: "Record this one ballot",
      lines: [
        "This writes one ballot: the result string below, the picture fingerprint and the score fingerprint.",
        "Blank, overvote and unclear answers are stored as they are. This does not pick a winner and does not send the other ballots.",
      ],
      facts: [["Answers", one.resultsString], ["Unclear", String(one.counts.U)], ["Overvote", String(one.counts.O)], ["Blank", String(one.counts.B)], ["Picture", shortHash(one.imageSha256, 8, 6)]],
      confirmText: "Record this ballot",
    });
    if (r.status === "cancelled") return fill(review, callout("info", "Nothing was sent", "You cancelled. The signature is still only in this browser."));
    if (r.status === "failed") return fill(review, callout("warn", "Not recorded", r.message));
    signed.delete(one.ballotCode);
    fill(review, callout("ok", "This ballot is recorded", "Choose the next one when you are ready. The others were not sent.", "check"));
  }));

  return h(
    "section",
    { class: "card", id: "a-printed" },
    h("h2", null, icon("clipboard", { size: 22 }), "Use ballots you already printed"),
    h("p", null, "Load the full election file that belongs to the paper ballots. This keeps those codes and their fingerprint. It does not make a new list. The form below this one is different: that one generates new codes."),
    h("div", { class: "field" }, labelWithHelp("p-file", "Full election file", "printed.fullVsPublic"), fileIn, h("p", { class: "hint" }, "The secret file, with ballot codes. A public copy will be refused.")),
    h("div", { class: "field" }, labelWithHelp("p-man", "Manifest, if you have one", "printed.manifest"), manIn, h("p", { class: "hint" }, "Optional. Used to check the fingerprint and the ballot-list root. Not required.")),
    headingWithHelp("h3", null, "Opening and closing", "printed.schedule"),
    h("p", { class: "muted small" }, "These times are written into the election file before anything is registered. If you change them, the file fingerprint changes with them. The ballot codes do not. Voting cannot open before the time you register."),
    h("div", { class: "grid" }, h("div", { class: "field" }, h("label", { for: "p-open" }, "Opens"), opens), h("div", { class: "field" }, h("label", { for: "p-close" }, "Closes"), closes)),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: applyTimes }, "Apply this schedule"), downloadFull, downloadPub),
    status,
    h("div", { class: "actions" }, createBtn),
    h("h3", null, "Record one scanned ballot"),
    h("p", { class: "muted small" }, "Load the readings file from the scanner, pick one ballot, sign it with the registered scanning wallet, then record it. There is no button that sends all of them."),
    h("div", { class: "field" }, labelWithHelp("p-read", "Readings file", "printed.readings"), readIn),
    h("div", { class: "field" }, h("label", { for: "p-pick" }, "One ballot"), pick),
    h("div", { class: "actions" }, reviewBtn),
    review,
  );
}
