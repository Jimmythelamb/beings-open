// @vitest-environment happy-dom
// The site reads the deployed StaffRegistry. These calls are read-only. Nothing is sent.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";
import { CONFIG, contractAddress } from "../public/js/config.js";
import { getWiringFacts, readStaffRoster } from "../public/js/chain.js";
import { emptyRoster, setElectionKind } from "../public/js/roster.js";
import { rosterReviewCard } from "../public/js/roster-review.js";
import { renderSystem } from "../public/js/system.js";

const STAFF = "0x7e519d972e61929f54d9f316eA79F6BB51dAf635";
const REGISTRY = "0x9Ae01EEAf38FB03554970cbDC7F83FFBB8d4Ee8A";
const LEDGER = "0x5d00bE9A32DcF1FcDe9475C8Be874aE8af0fCf0b";
const TALLY = "0xeDaBF1D8597FC4CA0aB71fcF0E91a0be966E7892";
const VERIFIERS = "0x360e9d558DEc99a2E2F81Cf925424ba399492bDc";
const CODE = "BEINGS-2026-QB1TTH";

beforeAll(() => {
  (window as unknown as { ethers: typeof ethers }).ethers = ethers;
});

describe("StaffRegistry on the site", () => {
  it("points staffRegistry at the Coston2 deploy and leaves the four live addresses unchanged", () => {
    expect(CONFIG.staffRegistry).toBe(STAFF);
    expect(contractAddress("staff")).toBe(STAFF);
    expect(CONFIG.chainId).toBe(114);
    expect(CONFIG.contracts).toEqual({ registry: REGISTRY, ledger: LEDGER, tally: TALLY, verifiers: VERIFIERS });
    const recorded = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/ledger/deployments/coston2-staff.json"), "utf8"));
    expect(recorded.chainId).toBe(114);
    expect(recorded.contracts.StaffRegistry).toBe(STAFF);
    expect(recorded.contracts.ElectionRegistry).toBe(REGISTRY);
    expect(recorded.deployTransactions[0].txHash).toBe("0xf628baa51be82c51fa360ac7da10b0c902dd5de4ede45a14ad12ec53a03bb067");
    expect(recorded.deployTransactions[0].block).toBe(37963247);
  });

  it("reads registry() from that address and shows it on the roster review and System admin pages", async () => {
    const facts = await getWiringFacts();
    expect(facts.staffAddress).toBe(STAFF);
    expect(facts.staffRegistry).toBe(REGISTRY);
    expect(facts.hasCode?.staff).toBe(true);

    const roster = await readStaffRoster(ethers.id("BEINGS-2026-NOSUCH"));
    expect(roster.configured).toBe(true);
    expect(roster.address).toBe(STAFF);
    expect(roster.known).toBe(false);
    expect(roster.lockedRosterHash).toMatch(/^0x[0-9a-f]{64}$/);

    const card = rosterReviewCard({
      roster: setElectionKind(emptyRoster(CODE, { organizerAddress: "0xFdAC058d47dc99A70f076523c95a5c97b3805bBB" }), "classroom"),
      organizerAddress: "0xFdAC058d47dc99A70f076523c95a5c97b3805bBB",
      chain: { configured: true, known: false, kind: "", locked: false, seats: {}, address: contractAddress("staff"), electionId: ethers.id(CODE) },
      canEdit: false,
    });
    expect(card.textContent).toContain("Review and approve staff roster");
    expect(card.textContent).toContain("Election Administrator is not recorded");

    const root = document.createElement("div");
    document.body.append(root);
    await renderSystem({ root, query: new URLSearchParams(`e=${CODE}`), current: () => true });
    expect(root.textContent).toContain("System admin");
    expect(root.textContent).toContain(STAFF);
    expect(root.textContent).toContain("StaffRegistry points at this ElectionRegistry");
    expect(root.textContent).toContain("Wired together correctly");
    expect(root.textContent).toContain("Close-out verification");
    expect(root.textContent).not.toContain("No code found");
    expect(root.textContent).not.toContain("Something went wrong");
  }, 60_000);
});
