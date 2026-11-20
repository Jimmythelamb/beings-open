import { Wallet, TypedDataEncoder } from "ethers";
import { describe, expect, it } from "vitest";
import {
  NOTICE_TYPES,
  eip712Domain,
  electionKey,
  keccakHex,
  noticeDigest,
  noticeMessage,
  signNotice,
  verifyNotice,
  type NoticeInput,
} from "../src/index.js";

const node = new Wallet("0x" + "44".repeat(32));
const other = new Wallet("0x" + "55".repeat(32));
const domain = eip712Domain({ verifyingContract: "0x" + "ab".repeat(20) });
const notice: NoticeInput = {
  electionCode: "BEINGS-2026-K7M4Q2",
  tallyVersion: 1,
  reportCid: "bafy-report",
  reportSha256: "ab".repeat(32),
  ballotQuestionsChecked: 10,
  ballotQuestionsAgreed: 9,
  tallyMatches: true,
  reconciliationMatches: false,
  merkleMatches: true,
  nonce: 0,
};

describe("VerificationNotice [PROPOSED]", () => {
  it("message hashes the election code and the report CID", () => {
    const m = noticeMessage(notice);
    expect(m.electionKey).toBe(electionKey(notice.electionCode));
    expect(m.reportCidHash).toBe(keccakHex("bafy-report"));
    expect(m.reportSha256).toBe("0x" + "ab".repeat(32));
    expect(m.nonce).toBe(0n);
  });

  it("type string is exactly the one the contract hashes", () => {
    expect(TypedDataEncoder.from(NOTICE_TYPES).encodeType("VerificationNotice")).toBe(
      "VerificationNotice(bytes32 electionKey,uint32 tallyVersion,bytes32 reportCidHash,bytes32 reportSha256,uint64 ballotQuestionsChecked,uint64 ballotQuestionsAgreed,bool tallyMatches,bool reconciliationMatches,bool merkleMatches,uint256 nonce)",
    );
  });

  it("sign, verify, and detect any edit including the nonce", async () => {
    const sig = await signNotice(node, notice, domain);
    expect(verifyNotice(notice, sig, node.address, domain)).toBe(true);
    expect(verifyNotice(notice, sig, other.address, domain)).toBe(false);
    for (const edit of [
      { tallyVersion: 2 },
      { reportCid: "bafy-other" },
      { ballotQuestionsAgreed: 10 },
      { reconciliationMatches: true },
      { nonce: 1 },
    ]) {
      expect(verifyNotice({ ...notice, ...edit }, sig, node.address, domain)).toBe(false);
    }
    expect(verifyNotice(notice, "0x12", node.address, domain)).toBe(false);
    expect(noticeDigest(notice, domain)).toBe(noticeDigest({ ...notice }, domain));
  });
});
