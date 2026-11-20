// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IBallotLedger
/// @notice One record per ballot, accepted when enough registered devices agree; corrections and spoil marks (spec 10.2).
/// @dev INTERFACE ONLY. Not implemented, not audited.
///
/// EIP-712 typed data signed off-chain by each phone for each ballot (exact type string, matches the core package (beings-core)):
///   Reading(bytes32 electionKey,bytes32 ballotKey,bytes32 resultsHash,bytes32 imageSha256,bytes32 scoresHash)
/// Reviewer signature (PROPOSED, matches the core package (beings-core) `signReview`):
///   Review(bytes32 electionKey,bytes32 ballotKey,bytes32 resultsHash)
/// EIP-712 domain (PROPOSED, matches the core package (beings-core) `eip712Domain`):
///   name "B.E.I.N.G.S.", version "1", chainId, verifyingContract = this contract.
/// resultsHash = keccak256(bytes(results)) where `results` is the joined string, e.g. "V:c1|V:c2".
/// scoresHash  = keccak256(RFC 8785 canonical JSON of the fill-score table).
/// Merkle leaves (Tally) are keccak256 of the JCS ledger entry with corrections applied; see the core package (beings-core) `entryLeaf`.
interface IBallotLedger {
    struct Reading {
        address device;
        bytes32 imageSha256;
        bytes32 scoresHash;
        bytes sig;
    }

    struct Submission {
        bytes32 electionKey;
        bytes32 ballotKey;
        string results;
        bytes32 imageSha256;
        bytes32 recordSha256;
        Reading[] readings;
        address reviewer;
        bytes reviewerSig;
    }

    struct Record {
        string results;
        bytes32 imageSha256;
        bytes32 recordSha256;
        uint64 acceptedAt;
        bool reviewed;
    }

    enum Reason { None, FaintMark, Erasure, StrayMark, GlareOrAlignment, PhoneMisread, Other }

    struct Correction {
        bytes32 ballotKey;
        uint32 prevIndex;       // PROPOSED convention: 0 = original record; n = the n-th correction of the election (1-based)
        uint8 questionIndex;
        string fromResult;
        string toResult;
        Reason reason;
        bytes32 evidenceSha256;
        address by;
        uint64 at;
    }

    event BallotAccepted(
        bytes32 indexed electionKey, bytes32 indexed ballotKey, string results,
        bytes32 imageSha256, bytes32 recordSha256, bool reviewed
    );
    event CorrectionPosted(
        bytes32 indexed electionKey, bytes32 indexed ballotKey, uint32 index, uint32 prevIndex,
        uint8 questionIndex, string fromResult, string toResult, Reason reason, bytes32 evidenceSha256
    );
    event BallotSpoiled(bytes32 indexed electionKey, bytes32 indexed ballotKey, bytes32 replacedByKey);

    function submitRecord(Submission calldata s) external;
    /// Pooled elections: `proof` shows `s.ballotKey` is in approved root `rootIndex` (0 = the creation root).
    function submitRecord(Submission calldata s, bytes32[] calldata proof, uint256 rootIndex) external;
    function submitBatch(Submission[] calldata batch) external;
    /// One proof and one root index per submission. All-or-nothing, same as `submitBatch`.
    function submitBatch(Submission[] calldata batch, bytes32[][] calldata proofs, uint256[] calldata rootIndexes) external;
    /// @dev SPEC GAP: the spec's `postCorrection(Correction)` has no election key (the Correction struct lacks one) but
    ///      stores into `corrections[electionKey]`. The key is passed explicitly here; confirm with the contract author.
    function postCorrection(bytes32 electionKey, Correction calldata c) external;
    function markSpoiled(bytes32 electionKey, bytes32 ballotKey, bytes32 replacedByKey) external;

    function recordCount(bytes32 electionKey) external view returns (uint32);
    function spoiledCount(bytes32 electionKey) external view returns (uint32);
    function correctionCount(bytes32 electionKey) external view returns (uint256);
    function spoiled(bytes32 electionKey, bytes32 ballotKey) external view returns (bool);
    function head(bytes32 electionKey, bytes32 ballotKey, uint8 questionIndex) external view returns (uint32);
}
