// System admin screen. Contract addresses, wiring, network health, and the close-out verification.
// The close-out signature is the System admin's own EIP-712 step. Recording it is the one transaction this page sends.
// The verifier registry stays open sign-up and has no remove function.
import { fill, h, icon, badge, callout, spinner, setTitle, fmtDate, extLink, explorerAddress, explorerTx, toast } from "./ui.js";
import { ROLE_INFO, state, onCoston2 } from "./roles.js";
import { CONFIG, contractAddress, fetchImageApi, resolveCommentsUrl, resolveImagePath } from "./config.js";
import { electionKeyOf, getChainHead, getEthers, getWiringFacts, pingService, loadVerifierNodes, discoverElections, getElection, readStaffRoster } from "./chain.js";
import { ELECTION_CODE_RE, shortAddress } from "./format.js";
import { wiringChecks, blockFreshness, ageText, sameAddress } from "./logic.js";
import { pageHead, statGrid, kvList, dataTable, hashText, errorCard } from "./staff.js";
import { electionKindOf, loadRoster, recordSystemSignOffLocal, saveRoster } from "./roster.js";
import { assembleSystemSignOff, rosterFileHash, signOffSeats, SYSTEM_SIGNOFF_STATEMENT } from "./staff-roster.js";
import { systemSignOffCard } from "./roster-review.js";
import { sendTx, signWithCard } from "./tx.js";

const CONTRACT_INFO = {
  registry: ["ElectionRegistry", "Elections, their files, scanning phones, reviewers and open/close."],
  ledger: ["BallotLedger", "Every counted ballot's result and image fingerprint."],
  tally: ["Tally", "The official count, with its reconciliation checks."],
  verifiers: ["VerifierRegistry", "Independent checkers and the reports they publish."],
  staff: ["StaffRegistry", "Election staff rosters, the roster fingerprint, and the System admin close-out sign-off."],
};

export async function renderSystem(ctx) {
  const { root } = ctx;
  setTitle("System admin");
  const signoff = h("div", { id: "system-signoff-slot" });
  const health = h("section", { class: "card", "aria-labelledby": "s-health" }, spinner("Checking the network…"));
  const contracts = h("section", { class: "card", "aria-labelledby": "s-contracts" }, spinner("Reading the contracts…"));
  const services = h("section", { class: "card", "aria-labelledby": "s-services" }, spinner("Checking the site's services…"));
  const nodes = h("section", { class: "card", "aria-labelledby": "s-nodes" }, spinner("Reading the verifier list…"));
  const elections = h("section", { class: "card", "aria-labelledby": "s-elections" }, spinner("Listing elections…"));
  fill(root, 
    h("a", { class: "back", href: "#/staff" }, "← All staff roles"),
    pageHead("system", { lead: ROLE_INFO.system.blurb }),
    signoff,
    health,
    contracts,
    services,
    nodes,
    elections,
    siteConfig(),
  );

  mountSignOff(ctx, signoff);

  const guard = (slot, fn) =>
    fn().catch((e) => {
      console.error(e);
      if (ctx.current()) fill(slot, errorCard(null, () => renderSystem(ctx)));
    });

  await Promise.all([
    guard(health, async () => {
      let head = null;
      let err = null;
      try {
        head = await getChainHead();
      } catch (e) {
        err = e;
      }
      if (!ctx.current()) return;
      if (!head) {
        fill(health, h("h2", { id: "s-health" }, icon("gear", { size: 22 }), "Network health"), callout("bad", "The network didn't answer", `The public connection to ${CONFIG.chainName} isn't responding right now. Nothing is lost: the ledger is separate. Try again in a minute.`, "alert"), h("p", { class: "muted small" }, String(err?.message ?? "")));
        return;
      }
      const age = Math.max(0, Math.floor(Date.now() / 1000) - head.timestamp);
      const fresh = blockFreshness(age);
      const tone = { fresh: "ok", slow: "warn", stale: "bad", unknown: "neutral" }[fresh];
      fill(health, 
        h("h2", { id: "s-health" }, icon("gear", { size: 22 }), "Network health"),
        h("div", { class: "badges" }, badge("Connection works", "ok", "check"), badge(fresh === "fresh" ? "Producing blocks" : fresh === "slow" ? "Blocks are slow" : fresh === "stale" ? "No new blocks" : "Block age unknown", tone), onCoston2() || !state.address ? null : badge("Your crypto-wallet is on another network", "warn", "alert")),
        statGrid([["Latest block", head.number.toLocaleString("en-CA")], ["Block age", ageText(age), fresh === "fresh" ? "normal" : "check the network status", tone === "ok" ? "ok" : tone], ["Answer time", `${head.latencyMs} ms`], ["Network", CONFIG.chainName, `chain id ${CONFIG.chainId}`]]),
        h("p", { class: "muted small" }, "Connection: ", h("code", { class: "code" }, CONFIG.rpcUrl)),
      );
    }),
    guard(contracts, async () => {
      const facts = await getWiringFacts();
      if (!ctx.current()) return;
      const checks = wiringChecks(CONFIG.contracts, facts);
      if (facts.staffAddress) checks.push({ label: "StaffRegistry points at this ElectionRegistry", pass: sameAddress(facts.staffRegistry, CONFIG.contracts.registry) });
      const allOk = checks.every((c) => c.pass) && Object.values(facts.hasCode ?? {}).every(Boolean);
      const contractRows = Object.entries(CONFIG.contracts).map(([k, a]) => ({ name: CONTRACT_INFO[k][0], what: CONTRACT_INFO[k][1], addr: extLink(explorerAddress(a), shortAddress(a)), code: facts.hasCode?.[k] ? badge("Yes", "ok") : badge("No code found", "bad"), _class: facts.hasCode?.[k] ? "" : "row-bad" }));
      if (CONFIG.staffRegistry) contractRows.push({ name: CONTRACT_INFO.staff[0], what: CONTRACT_INFO.staff[1], addr: extLink(explorerAddress(CONFIG.staffRegistry), shortAddress(CONFIG.staffRegistry)), code: facts.hasCode?.staff ? badge("Yes", "ok") : badge("No code found", "bad"), _class: facts.hasCode?.staff ? "" : "row-bad" });
      fill(contracts, 
        h("h2", { id: "s-contracts" }, icon("shield", { size: 22 }), "Contracts"),
        allOk ? callout("ok", "Wired together correctly", facts.staffAddress ? "The four election contracts and the staff roster contract exist at these addresses and point where the site expects." : "All four contracts exist at these addresses and point at each other as the site expects.", "check") : callout("warn", "Something doesn't line up", "At least one contract is missing or points somewhere else. Check the list below before relying on this site.", "alert"),
        dataTable(
          [{ key: "name", label: "Contract" }, { key: "what", label: "What it does" }, { key: "addr", label: "Address" }, { key: "code", label: "Deployed" }],
          contractRows,
          { caption: "Contract addresses" },
        ),
        h("h3", null, "Wiring"),
        h("ul", { class: "checks" }, checks.map((c) => h("li", { class: `check check-${c.pass ? "pass" : "fail"}` }, h("span", { class: "check-icon" }, icon(c.pass ? "check" : "x", { size: 18 })), h("span", null, c.label)))),
        kvList([["Deployer wallet", facts.deployer ? extLink(explorerAddress(facts.deployer), shortAddress(facts.deployer)) : "unknown"], ["Anyone may close an election after", facts.closeGrace != null ? `${ageText(facts.closeGrace)} past its scheduled closing` : "unknown"], ["This wallet", state.address ? (sameAddress(state.address, facts.deployer) ? "is the deployer" : "is not the deployer") : "not connected"]]),
        h("p", { class: "muted small" }, "Addresses are set in js/config.js. New elections are created on these four. Elections from an earlier deployment stay on that deployment; every screen still finds them there."),
        (CONFIG.legacySets ?? []).length
          ? dataTable(
              [{ key: "name", label: "Earlier set" }, { key: "what", label: "What it does" }, { key: "addr", label: "Address" }, { key: "from", label: "From block" }],
              (CONFIG.legacySets ?? []).flatMap((set) =>
                Object.entries(set.contracts ?? {}).map(([k, a]) => ({
                  name: `${set.id} · ${CONTRACT_INFO[k]?.[0] ?? k}`,
                  what: CONTRACT_INFO[k]?.[1] ?? "",
                  addr: extLink(explorerAddress(a), shortAddress(a)),
                  from: Number(set.deployBlock).toLocaleString("en-CA"),
                })),
              ),
              { caption: "Earlier contract sets, still readable" },
            )
          : null,
      );
    }),
    guard(services, async () => {
      const imageLookup = resolveImagePath(CONFIG.imagesApi);
      const verifierImages = resolveImagePath("/api/verifier/images");
      const [images, verifier, explorer] = await Promise.all([pingService(imageLookup, { fetchImpl: fetchImageApi }), pingService(verifierImages, { fetchImpl: fetchImageApi }), pingService(`${CONFIG.explorer}/api?module=block&action=eth_block_number`)]);
      if (!ctx.current()) return;
      // a 4xx answer means the service is up and refusing an unsigned request, which is the right thing
      const row = (name, r, note) => ({ name, state: r.ok ? badge("Answering", "ok", "check") : badge(r.status ? `Error ${r.status}` : "Not reachable", "bad", "x"), ms: r.ms ? `${r.ms} ms` : "", note });
      fill(services, 
        h("h2", { id: "s-services" }, icon("link", { size: 22 }), "Site services"),
        dataTable([{ key: "name", label: "Service" }, { key: "state", label: "State" }, { key: "ms", label: "Time", num: true }, { key: "note", label: "Notes" }], [row("Voter image lookup", images, `${imageLookup} (shows a voter their own ballot image)`), row("Verifier image download", verifier, `${verifierImages} (needs a signed request from a registered verifier)`), row("Block explorer", explorer, "Used for the history lists on every screen")], { caption: "Services this site depends on" }),
        h("p", { class: "muted small" }, "“Answering” also covers a refusal of an unsigned test request: that is the service correctly saying no."),
      );
    }),
    guard(nodes, async () => {
      const list = await loadVerifierNodes();
      if (!ctx.current()) return;
      list.sort((a, b) => b.registeredAt - a.registeredAt);
      fill(nodes, 
        h("h2", { id: "s-nodes" }, icon("users", { size: 22 }), "Verifier registry"),
        h("p", null, "Anyone can register as a verifier, and nobody can remove them. The registry has no administrator. What limits who may download ballot images is the image service's own allow-list setting, not this list."),
        dataTable([{ key: "name", label: "Name" }, { key: "addr", label: "Wallet" }, { key: "at", label: "Registered" }, { key: "info", label: "Details" }], list.map((n) => ({ name: n.name || "(no name)", addr: extLink(explorerAddress(n.address), shortAddress(n.address)), at: fmtDate(n.registeredAt), info: n.infoCid ? n.infoCid : "-" })), { caption: `${list.length} registered verifier${list.length === 1 ? "" : "s"}`, empty: "No verifiers have registered yet." }),
      );
    }),
    guard(elections, async () => {
      const { elections: found, discovered } = await discoverElections();
      const rows = [];
      for (const e of found) {
        try {
          const el = await getElection(e.code, e);
          rows.push(el ? { code: e.code, el } : { code: e.code, el: null });
        } catch {
          rows.push({ code: e.code, el: null });
        }
      }
      if (!ctx.current()) return;
      const names = ["Unknown", "Getting ready", "Voting open", "Voting closed", "Results published"];
      fill(elections, 
        h("h2", { id: "s-elections" }, icon("clipboard", { size: 22 }), "Elections on the ledger"),
        !discovered ? callout("warn", "Partial list", "The block explorer didn't answer, so only the elections bundled with the site are shown.", "alert") : null,
        dataTable(
          [{ key: "code", label: "Election" }, { key: "status", label: "Stage" }, { key: "org", label: "Organizer" }, { key: "n", label: "Counted", num: true }],
          rows.map((r) => ({ code: h("a", { href: `#/admin?e=${r.code}` }, r.code), status: r.el ? names[r.el.status] : "not found", org: r.el ? shortAddress(r.el.organizer) : "-", n: r.el ? `${r.el.recordCount} / ${r.el.ballotCount}` : "-" })),
          { caption: `${rows.length} election${rows.length === 1 ? "" : "s"}`, empty: "No elections found." },
        ),
      );
    }),
  ]);
}

function mountSignOff(ctx, slot) {
  const initial = String(ctx.query?.get("e") || "").trim().toUpperCase();
  const input = h("input", { id: "system-signoff-code", value: initial, placeholder: "BEINGS-2026-XXXXXX", autocomplete: "off", spellcheck: "false", "aria-label": "Election code" });
  const button = h("button", { class: "btn", type: "button", id: "system-signoff-load" }, "Review this election");
  const body = h("div");
  fill(slot,
    h("section", { class: "card" },
      h("h2", null, icon("gear", { size: 22 }), "Close-out verification"),
      h("p", null, "Review the roster's roles and crypto-wallets, then the duty and close-out sheet for each filled position. A standard election needs your signature before it can be certified. For a test or classroom election the signature is optional and, if you sign, it is disclosed. It does not certify those elections."),
      h("div", { class: "row" }, input, button),
      body,
    ),
  );
  const run = () => { void loadSignOff(ctx, body, input.value); };
  button.addEventListener("click", run);
  if (initial) run();
}

async function loadSignOff(ctx, body, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!ELECTION_CODE_RE.test(code)) {
    fill(body, h("p", { class: "hint" }, "Enter an election code such as BEINGS-2026-XXXXXX."));
    return;
  }
  let status = 0;
  let organizer = "";
  try {
    const el = await getElection(code);
    if (el) {
      status = el.status;
      organizer = el.organizer || "";
    }
  } catch {
    /* The local roster can still be reviewed when the ledger does not answer. */
  }
  if (!ctx.current()) return;
  const roster = loadRoster(localStorage, code, { organizerAddress: organizer });
  const address = contractAddress("staff");
  let chain = null;
  if (address) {
    try {
      chain = await readStaffRoster(await electionKeyOf(code));
    } catch {
      chain = null;
    }
  }
  if (!ctx.current()) return;
  let prepared = null;
  try {
    const ethers = await getEthers();
    const electionId = chain?.electionId || (await electionKeyOf(code));
    const seats = signOffSeats({ roster, chain, ethers, organizerAddress: organizer });
    prepared = assembleSystemSignOff(ethers, { electionId, rosterHash: rosterFileHash(roster, ethers), seats });
    prepared.contract = address;
  } catch (e) {
    fill(body, h("p", { class: "hint" }, String(e?.message ?? e)));
    return;
  }
  if (!ctx.current()) return;
  const kind = chain?.kind || electionKindOf(roster);
  fill(body, systemSignOffCard({
    electionCode: code,
    kind,
    status: chain?.known ? status : status,
    prepared,
    recorded: !!chain?.systemSignOffRecorded,
    current: !!chain?.systemSignOffCurrent,
    connectedAddress: state.address || "",
    contractReady: !!address,
    onSign: (payload) => submitSignOff({ code, organizer, payload }),
  }));
}

async function submitSignOff({ code, organizer, payload }) {
  if (!payload?.typed?.domain?.verifyingContract) {
    toast("The roster contract is not connected on this site yet. Nothing was signed.");
    return;
  }
  const signed = await signWithCard({
    title: "Sign the System admin close-out",
    lines: [SYSTEM_SIGNOFF_STATEMENT, "This covers the positions and the duty and close-out sheets listed above. The salt for each name stays off the chain."],
    facts: [["Election", code]],
    confirmText: "Sign",
    sign: (signer) => signer.signTypedData(payload.typed.domain, payload.typed.types, payload.typed.message),
  });
  if (signed?.status !== "signed") {
    if (signed?.message) toast(signed.message);
    return;
  }
  try {
    const next = recordSystemSignOffLocal(loadRoster(localStorage, code, { organizerAddress: organizer }), { ...payload, signature: signed.signature, signer: state.address || "" });
    saveRoster(localStorage, next);
  } catch (e) {
    toast(String(e?.message ?? e));
    return;
  }
  const result = await sendTx({
    contract: "staff",
    method: "recordSystemSignOff",
    args: [payload.typed.message.electionId, [payload.rosterHash, payload.positionIds, payload.sheetHashes, payload.statement, signed.signature]],
    title: "Record the System admin sign-off",
    lines: ["This stores the System admin's close-out signature on the roster contract. A standard election needs it before it can be certified. Names and salts stay off the chain."],
    facts: [["Election", code]],
    confirmText: "Record sign-off",
  });
  if (result.status === "failed") toast(result.message);
  if (result.status === "sent") toast("System admin sign-off recorded.");
}

function siteConfig() {
  const item = (k, v) => [k, typeof v === "string" && v.startsWith("http") ? extLink(v, v) : h("code", { class: "code" }, String(v))];
  return h(
    "section",
    { class: "card", "aria-labelledby": "s-config" },
    h("h2", { id: "s-config" }, icon("book", { size: 22 }), "Site settings"),
    h("p", null, "These come from ", h("code", { class: "code" }, "js/config.js"), " (public, shipped with the site). Server-side settings, such as how long images are kept and which verifiers may download them, are environment variables of the image service and aren't visible from a web page."),
    kvList([
      item("Network", `${CONFIG.chainName}, chain id ${CONFIG.chainId}`),
      item("Network connection", CONFIG.rpcUrl),
      item("Block explorer", CONFIG.explorer),
      item("Current contracts from block", CONFIG.deployBlock.toLocaleString("en-CA")),
      item("Staff roster contract", CONFIG.staffRegistry || "not set"),
      ...(CONFIG.legacySets ?? []).map((set) => item(`Earlier set ${set.id} from block`, Number(set.deployBlock).toLocaleString("en-CA"))),
      item("Voter image lookup", resolveImagePath(CONFIG.imagesApi)),
      item("Verifier image download", resolveImagePath("/api/verifier/images")),
      item("Bundled election list", CONFIG.knownElectionsUrl),
      item("File gateway (IPFS)", CONFIG.ipfsGateway),
      item("Wallet library", `ethers ${CONFIG.ethers.cdn.match(/ethers@([\d.]+)/)?.[1] ?? ""} (with a fallback copy in the site)`),
      item("Problem reports go to", CONFIG.reportEmail || "not set"),
      item("Public comments", resolveCommentsUrl() || "not connected"),
    ]),
    h("p", null, h("a", { href: "#/moderate" }, "Review public comments")),
  );
}
