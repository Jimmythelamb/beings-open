// Election Administrator registration. Synthetic wallet only. The signature is EIP-191 (personal_sign).
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Wallet, verifyMessage } from "ethers";
import { askAdminNames, resolveElectionId, startAdminRegistration } from "../public/js/admin-register.js";
import { loadRoster, memoryStorage, readAdminRegistration } from "../public/js/roster.js";

const CODE = "BEINGS-2026-RST4XY";
const AT = "2026-11-16T01:30:00.000Z";

describe("register name and wallet", () => {
  it("uses the draft election code, then the open election, otherwise the words new election", () => {
    const input = document.createElement("input");
    input.id = "c-code";
    input.value = "beings-2026-rst4xy";
    const doc = { getElementById: (id: string) => (id === "c-code" ? input : null) };
    expect(resolveElectionId({ doc: doc as any })).toBe(CODE);
    input.value = "";
    expect(resolveElectionId({ electionCode: CODE, doc: doc as any })).toBe(CODE);
    expect(resolveElectionId({ electionCode: "new election", doc: doc as any })).toBe("new election");
    expect(resolveElectionId({ doc: { getElementById: () => null } as any })).toBe("new election");
  });

  it("asks for a first and last name only when they are empty", async () => {
    await expect(askAdminNames({ first: "Grace", last: "Hopper" })).resolves.toEqual({ firstName: "Grace", lastName: "Hopper" });
    const pending = askAdminNames({ first: "", last: "" });
    const first = document.getElementById("admin-reg-first") as HTMLInputElement;
    const last = document.getElementById("admin-reg-last") as HTMLInputElement;
    expect(first).toBeTruthy();
    first.value = "Ada";
    last.value = "Lovelace";
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Continue")?.dispatchEvent(new Event("click"));
    await expect(pending).resolves.toEqual({ firstName: "Ada", lastName: "Lovelace" });
    expect(document.getElementById("admin-reg-first")).toBeNull();
  });

  it("opens the connect step when no wallet is connected, then signs, verifies, and stores the roster", async () => {
    const organizer = new Wallet(Wallet.createRandom().privateKey);
    const storage = memoryStorage();
    let ensured = 0;
    let signed = "";
    const saved = await startAdminRegistration({
      electionCode: CODE,
      storage,
      getAddress: () => null,
      ensureWallet: async () => {
        ensured += 1;
        return organizer.address;
      },
      askNames: async () => ({ firstName: "Grace", lastName: "Hopper" }),
      now: () => AT,
      sign: async (message: string) => {
        signed = message;
        return { status: "signed", signature: await organizer.signMessage(message) };
      },
      verify: verifyMessage,
      onDone: () => {},
    });
    expect(ensured).toBe(1);
    expect(signed).toBe(`B.E.I.N.G.S. Election Administrator registration: I, Grace Hopper, hold wallet ${organizer.address} and will administer election ${CODE}. ${AT}`);
    expect(verifyMessage(signed, await organizer.signMessage(signed))).toBe(organizer.address);
    expect(saved.status).toBe("saved");
    const admin = loadRoster(storage, CODE, { organizerAddress: organizer.address }).seats.find((s) => s.id === "admin");
    expect(admin.firstName).toBe("Grace");
    expect(admin.lastName).toBe("Hopper");
    expect(admin.address).toBe(organizer.address);
    expect(admin.registration.message).toBe(signed);
    expect(admin.registration.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(verifyMessage(admin.registration.message, admin.registration.signature)).toBe(organizer.address);
    const again = await startAdminRegistration({
      electionCode: CODE,
      storage,
      getAddress: () => organizer.address,
      ensureWallet: async () => {
        throw new Error("should not connect again");
      },
      askNames: async () => {
        throw new Error("should not ask again");
      },
      sign: async () => {
        throw new Error("should not sign again");
      },
      verify: verifyMessage,
    });
    expect(again).toMatchObject({ status: "saved", already: true });
    expect(readAdminRegistration(storage, "new election")).toBeNull();
  });

  it("stores a new-election registration when there is no id yet", async () => {
    const organizer = new Wallet(Wallet.createRandom().privateKey);
    const storage = memoryStorage();
    const saved = await startAdminRegistration({
      electionCode: "new election",
      storage,
      getAddress: () => organizer.address,
      askNames: async () => ({ firstName: "Grace", lastName: "Hopper" }),
      now: () => AT,
      sign: async (message: string) => ({ status: "signed", signature: await organizer.signMessage(message) }),
      verify: verifyMessage,
    });
    expect(saved.status).toBe("saved");
    const pending = readAdminRegistration(storage, "new election");
    expect(pending.message).toContain("election new election.");
    expect(pending.address).toBe(organizer.address);
    expect(verifyMessage(pending.message, pending.signature)).toBe(organizer.address);
  });
});
