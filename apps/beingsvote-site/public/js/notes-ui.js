// Admin: sign an official note about a tallied election (for example, the organizer's explanation of a failed check)
// and, once the ElectionNotes contract is configured, post its fingerprint or the record's fingerprint to the ledger.
// Signing is EIP-712 in the connected wallet (free, changes nothing). Posting goes through sendTx (confirmation card,
// dry run, wallet prompt). No secret file is needed or read here.
import { fill, h, icon, callout, badge, toast } from "./ui.js";
import { state } from "./roles.js";
import { getEthers, getTally, registryRoleOf, notesConfigured } from "./chain.js";
import { shortAddress } from "./format.js";
import { contractAddress } from "./config.js";
import { headingWithHelp, labelWithHelp, helpToggle } from "./help.js";
import { sendTx, signWithCard } from "./tx.js";
import { hashText, downloadBlob, busy, kvList } from "./staff.js";
import { draftNote, validateNote, noteTypedData, attachSignature, noteFileSha256, manifestSha256, failedCheckIds, CHECK_IDS, ROLE_LABEL, NAME_WARNING, MAX_DISPLAY_NAME_BYTES, MAX_TEXT_CHARS, MAX_CID_BYTES, RECORD_SCHEMA } from "./record.js";

const utf8Len = (s) => new TextEncoder().encode(s).length;

/** The "Notes and the election record" card for one election (el from loadElectionContext). */
export function notesCard(el) {
  const code = el.code;
  const section = h("section", { class: "card", "aria-labelledby": "a-notes" });
  const head = headingWithHelp("h2", { id: "a-notes" }, [icon("book", { size: 22 }), "Notes and the election record"], "admin.notes");
  if (el.status < 4) {
    fill(section, head, h("p", { class: "muted" }, "Available once the official tally is published."));
    return section;
  }
  const configured = notesConfigured();
  const textIn = h("textarea", { id: "n-text", rows: 6, maxlength: String(MAX_TEXT_CHARS), placeholder: "Explain what happened in plain words. Never include a ballot code." });
  const verIn = h("input", { id: "n-ver", inputmode: "numeric", value: String(el.resultCount || 1), "aria-label": "Tally version this note is about" });
  const nameIn = h("input", { id: "n-name", maxlength: "64", autocomplete: "off", placeholder: "Optional. Leave empty to be shown by role and wallet only." });
  const consent = h("input", { id: "n-consent", type: "checkbox" });
  const checksBox = h("div", { class: "row", role: "group", "aria-label": "Checks this note explains" });
  const draftIn = h("input", { id: "n-draft", type: "file", accept: "application/json,.json" });
  const cidIn = h("input", { id: "n-cid", autocomplete: "off", class: "plain-mono", value: `https://beingsvote.live/data/records/${code}/notes/organizer-note-1.json`, "aria-label": "Where the signed note is kept" });
  const manIn = h("input", { id: "n-manifest", type: "file", accept: "application/json,.json" });
  const manCidIn = h("input", { id: "n-mcid", autocomplete: "off", class: "plain-mono", value: `https://beingsvote.live/data/records/${code}/manifest.json`, "aria-label": "Where the record manifest is kept" });
  const out = h("div", { role: "status" });
  const manOut = h("div", { role: "status" });
  let loadedDraft = null;
  let signed = null; // { note, sha }
  let manifest = null; // { sha }

  const checkBoxes = CHECK_IDS.map((id) => h("input", { type: "checkbox", id: `n-chk-${id}`, value: id }));
  fill(checksBox, CHECK_IDS.map((id, i) => h("label", { class: "check-pill", for: `n-chk-${id}` }, checkBoxes[i], ` ${id}`)));
  getTally(el, 0)
    .then((t) => {
      const failed = failedCheckIds(t?.failedChecks ?? 0);
      checkBoxes.forEach((b) => (b.checked = failed.includes(b.value)));
    })
    .catch(() => {});

  const signBtn = h("button", { class: "btn btn-primary", type: "button" }, icon("check", { size: 18 }), "Sign the note");
  const postBtn = h("button", { class: "btn", type: "button", disabled: true }, "Post the note's fingerprint");
  const postManBtn = h("button", { class: "btn", type: "button", disabled: true }, "Post the record fingerprint");

  draftIn.addEventListener("change", async () => {
    try {
      const f = draftIn.files?.[0];
      if (!f) return;
      const n = JSON.parse(await f.text());
      const errs = validateNote(n);
      if (errs.length) throw new Error(errs.join(" "));
      if (n.electionCode !== code) throw new Error(`This draft is for ${n.electionCode}, not ${code}.`);
      loadedDraft = n;
      textIn.value = n.text;
      verIn.value = String(n.tallyVersion);
      nameIn.value = n.displayName;
      checkBoxes.forEach((b) => (b.checked = n.checks.includes(b.value)));
      fill(out, callout("info", "Draft loaded", `Written for ${shortAddress(n.author)} as ${ROLE_LABEL[n.role] ?? n.role}. Read it once more, then sign with that wallet.`));
    } catch (e) {
      loadedDraft = null;
      fill(out, callout("warn", "That draft can't be used", String(e?.message ?? e)));
    }
  });

  signBtn.addEventListener("click", () =>
    busy(signBtn, "Working…", async () => {
      signed = null;
      postBtn.disabled = true;
      try {
        if (!state.address) throw new Error("Connect the organizer's (or a registered reviewer's or scanner's) wallet first, top right.");
        const role = await registryRoleOf(el, state.address);
        if (role === "none") throw new Error(`This wallet (${shortAddress(state.address)}) has no role in ${code}. Only the organizer, a registered reviewer or a registered scanner wallet can sign a note.`);
        const name = nameIn.value.trim();
        if (name && !consent.checked) throw new Error("Tick the box that says you understand a display name is public and permanent, or leave the name empty.");
        if (utf8Len(name) > MAX_DISPLAY_NAME_BYTES) throw new Error(`The display name is longer than ${MAX_DISPLAY_NAME_BYTES} bytes.`);
        const ethers = await getEthers();
        const author = ethers.getAddress(state.address);
        const note = draftNote({
          electionCode: code,
          electionKey: el.key,
          tallyVersion: Number(verIn.value),
          author,
          role,
          checks: checkBoxes.filter((b) => b.checked).map((b) => b.value),
          displayName: name,
          text: textIn.value,
          kind: loadedDraft?.kind ?? "explanation",
          createdAt: loadedDraft && loadedDraft.author.toLowerCase() === author.toLowerCase() && loadedDraft.text === textIn.value.trim() ? loadedDraft.createdAt : new Date().toISOString(),
        });
        const td = noteTypedData(note, ethers.keccak256);
        const r = await signWithCard({
          title: "Sign this note",
          lines: [`You are signing as the ${ROLE_LABEL[role].toLowerCase()} of ${code}. The note explains; it can't change counts or clear a flag.`, name ? `Your display name "${name}" will be public and permanent.` : "No display name: you'll be shown by role and wallet only."],
          facts: [["Election", code], ["Tally version", String(note.tallyVersion)], ["Checks", note.checks.join(", ") || "none"], ["Text", note.text.length > 160 ? note.text.slice(0, 157) + "…" : note.text]],
          confirmText: "Sign",
          sign: (signer) => signer.signTypedData(td.domain, td.types, td.message),
        });
        if (r.status !== "signed") {
          if (r.status === "failed") throw new Error(r.message);
          return;
        }
        const s = attachSignature(note, r.signature, { keccak256: ethers.keccak256, verifyTypedData: ethers.verifyTypedData });
        signed = { note: s, sha: await noteFileSha256(s) };
        postBtn.disabled = !configured;
        fill(
          out,
          callout("ok", "Signed", "The signature was checked here: it is from this wallet. Download the signed note and keep it; it goes into the election record on the website.", "check"),
          kvList([["Note fingerprint (SHA-256)", hashText(signed.sha, 14, 10)], ["Signed by", hashText(author, 10, 6)], ["Role", ROLE_LABEL[role]]]),
          h(
            "div",
            { class: "actions" },
            h("button", { class: "btn btn-sm", type: "button", onClick: () => downloadBlob(`${code}-${role}-note.signed.json`, JSON.stringify(s, null, 2) + "\n", "application/json") }, "Download the signed note"),
            h("button", { class: "btn btn-sm", type: "button", onClick: () => downloadBlob(`${code}-${role}-note.eip712.json`, JSON.stringify(td, null, 2) + "\n", "application/json") }, "Download what was signed"),
          ),
        );
      } catch (e) {
        fill(out, callout("warn", "Not signed", String(e?.message ?? e)));
      }
    }),
  );

  const cidOk = (v) => v && utf8Len(v) <= MAX_CID_BYTES;
  postBtn.addEventListener("click", () =>
    busy(postBtn, "Working…", async () => {
      if (!signed) return;
      const cid = cidIn.value.trim();
      if (!cidOk(cid)) return toast(`Add where the signed note is kept (${MAX_CID_BYTES} bytes at most).`);
      const n = signed.note;
      const r = await sendTx({
        contract: "notes",
        method: n.displayName ? "postNoteWithName" : "postNote",
        args: n.displayName ? [el.key, n.tallyVersion, signed.sha, cid, n.displayName] : [el.key, n.tallyVersion, signed.sha, cid],
        title: "Post the note's fingerprint",
        lines: ["This puts the note's fingerprint, your wallet and your role on the public ledger, permanently. The words stay in the signed file. It does not change counts or clear any flag.", n.displayName ? `Your display name "${n.displayName}" goes on the ledger too, and the chain cannot forget it.` : "No display name goes on the ledger."],
        facts: [["Election", code], ["Tally version", String(n.tallyVersion)], ["Note fingerprint", signed.sha], ["Kept at", cid]],
        confirmText: "Post fingerprint",
      });
      if (r.status === "failed") toast(r.message);
      if (r.status === "sent") toast("Note fingerprint posted.");
    }),
  );

  manIn.addEventListener("change", async () => {
    manifest = null;
    postManBtn.disabled = true;
    try {
      const f = manIn.files?.[0];
      if (!f) return;
      const m = JSON.parse(await f.text());
      if (m.schema !== RECORD_SCHEMA) throw new Error(`This isn't a record manifest (schema ${RECORD_SCHEMA}).`);
      if (m.electionCode !== code) throw new Error(`This manifest is for ${m.electionCode}, not ${code}.`);
      const unsigned = (m.files ?? []).filter((x) => x.role === "official-note" && !x.signed);
      if (unsigned.length) throw new Error("This manifest lists an unsigned draft note. Sign the note, rebuild the record, then post the new fingerprint.");
      manifest = { sha: await manifestSha256(m), m };
      postManBtn.disabled = !configured;
      fill(manOut, kvList([["Record fingerprint (SHA-256)", hashText(manifest.sha, 14, 10)], ["Files", String(m.files.length)], ["Tally version", String(m.tallyVersion)]]));
    } catch (e) {
      fill(manOut, callout("warn", "That manifest can't be used", String(e?.message ?? e)));
    }
  });
  postManBtn.addEventListener("click", () =>
    busy(postManBtn, "Working…", async () => {
      if (!manifest) return;
      const cid = manCidIn.value.trim();
      if (!cidOk(cid)) return toast(`Add where the manifest is kept (${MAX_CID_BYTES} bytes at most).`);
      const r = await sendTx({
        contract: "notes",
        method: "postNote",
        args: [el.key, manifest.m.tallyVersion, manifest.sha, cid],
        title: "Post the record fingerprint",
        lines: ["This puts the fingerprint of the whole public record (questions, results file and signed notes) on the ledger, so anyone can later prove the files weren't changed. It does not change counts or clear any flag."],
        facts: [["Election", code], ["Record fingerprint", manifest.sha], ["Kept at", cid]],
        confirmText: "Post fingerprint",
      });
      if (r.status === "failed") toast(r.message);
      if (r.status === "sent") toast("Record fingerprint posted.");
    }),
  );

  const nameHelp = helpToggle("admin.noteName", { label: "display name" });
  fill(
    section,
    head,
    h("p", null, "The organizer, a registered reviewer or a registered scanner wallet can sign a short note about this election, for example to explain a failed check. A note is an explanation shown under the results. It never changes the counts and it does not clear a flag."),
    configured ? null : callout("info", "Signing works; posting to the ledger isn't set up yet", "The notes contract hasn't been deployed on Coston2, so fingerprints can't be posted yet. You can sign the note and download it now. It is published with the election record on the website, and its fingerprint can be posted later."),
    h("div", { class: "field" }, labelWithHelp("n-draft", "Optional: load a prepared draft note", "admin.noteDraft"), draftIn),
    h("div", { class: "field" }, labelWithHelp("n-text", "The note", "admin.noteText"), textIn, h("p", { class: "hint" }, `Plain words, ${MAX_TEXT_CHARS} characters at most. Never a ballot code.`)),
    h("div", { class: "field" }, h("p", { class: "label-like" }, "Checks it explains"), checksBox),
    h("div", { class: "row" }, h("div", { class: "field" }, h("label", { for: "n-ver" }, "Tally version"), verIn)),
    h("div", { class: "field" }, h("div", { class: "label-row" }, h("label", { for: "n-name" }, "Display name (optional)"), nameHelp.button), nameHelp.panel, nameIn),
    callout("warn", "The chain cannot forget", NAME_WARNING),
    h("label", { class: "check-line", for: "n-consent" }, consent, " I understand a display name is public and permanent."),
    h("div", { class: "actions" }, signBtn),
    out,
    headingWithHelp("h3", null, "Post to the ledger", "admin.notePost"),
    h("div", { class: "field" }, h("label", { for: "n-cid" }, "Where the signed note is kept"), cidIn),
    h("div", { class: "actions" }, postBtn),
    headingWithHelp("h3", null, "Record fingerprint", "admin.recordPost"),
    h("div", { class: "field" }, labelWithHelp("n-manifest", "Record manifest (manifest.json)", "admin.recordManifest"), manIn),
    h("div", { class: "field" }, h("label", { for: "n-mcid" }, "Where the manifest is kept"), manCidIn),
    h("div", { class: "actions" }, postManBtn),
    manOut,
    !configured ? h("p", { class: "hint" }, "Posting buttons stay off until the notes contract address is set in the site settings.") : badge(`Notes contract ${shortAddress(contractAddress("notes"))}`, "neutral"),
  );
  return section;
}
