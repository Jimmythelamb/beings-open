// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IElectionRegistry} from "./interfaces/IElectionRegistry.sol";
import {IBallotLedger} from "./interfaces/IBallotLedger.sol";
import {ResultString} from "./libraries/ResultString.sol";

/// @title BallotLedger
/// @notice One record per ballot, accepted when enough registered devices agree; corrections and spoil marks
///         (design spec 10.2). Permanent on-chain data per ballot: results and image hash.
/// @dev NOT AUDITED.
///
/// EIP-712 domain (matches the core package `eip712Domain`): name "B.E.I.N.G.S.", version "1", chainId = block.chainid,
/// verifyingContract = this contract. Typed data:
///   Reading(bytes32 electionKey,bytes32 ballotKey,bytes32 resultsHash,bytes32 imageSha256,bytes32 scoresHash)
///   Review(bytes32 electionKey,bytes32 ballotKey,bytes32 resultsHash)            [PROPOSED]
/// with resultsHash = keccak256(bytes(results)).
///
/// Acceptance (spec 10.2): the election is Open; the ballot is not recorded or spoiled; recordCount < ballotCount;
/// every included reading is from a distinct Device-role address with a valid signature over THIS submission's
/// resultsHash (a reading that read the ballot differently cannot be included: it stays in the off-chain record);
/// one reading's imageSha256 equals the submission's; and either
///   (a) at least `quorum` readings are included, or
///   (b) a registered Reviewer signed the results (Review) and at least one valid reading is included.
///
/// [PROPOSED] choices where the spec is silent:
///   * Any invalid reading, non-device, duplicate device or invalid reviewer signature REVERTS the whole call
///     (so a batch is all-or-nothing).
///   * `postCorrection` takes the election key as an extra parameter, requires `c.by == msg.sender`, ignores the
///     supplied `c.at` and stores block.timestamp, and requires the election to be Open, Closed or Tallied.
///   * Correction indexes are 1-based in posting order per election; `prevIndex` 0 means the original record, and
///     `head[election][ballot][question]` holds the 1-based index of the latest correction (0 = none).
///   * `fromResult` must equal the question's current result: the original results segment, or the previous
///     correction's `toResult`. `questionIndex` is the 0-based position in the results string.
///   * `markSpoiled` is allowed while the election is Open or Closed, only for ballots not yet recorded.
///
/// Ballot pool (spec v0.8, sections 9.5–9.7, :James-Hugh: Lamb.): when `registry.poolEnforced` is true, every record
/// must carry a Merkle proof that its ballot key is in one approved root (the creation root, or a root added with
/// `addBallots` before opening). The original `submitRecord` / `submitBatch` stay as they are for elections created
/// without that flag. One record per ballot key is unchanged, so a reprint of a damaged ballot cannot count twice.
contract BallotLedger is IBallotLedger, EIP712 {
    bytes32 public constant READING_TYPEHASH =
        keccak256("Reading(bytes32 electionKey,bytes32 ballotKey,bytes32 resultsHash,bytes32 imageSha256,bytes32 scoresHash)");
    bytes32 public constant REVIEW_TYPEHASH = keccak256("Review(bytes32 electionKey,bytes32 ballotKey,bytes32 resultsHash)");

    IElectionRegistry public immutable registry;

    mapping(bytes32 => mapping(bytes32 => Record)) public records; // electionKey => ballotKey
    mapping(bytes32 => uint32) public override recordCount;
    mapping(bytes32 => mapping(bytes32 => bool)) public override spoiled;
    mapping(bytes32 => uint32) public override spoiledCount;
    mapping(bytes32 => Correction[]) public corrections; // append-only
    mapping(bytes32 => mapping(bytes32 => mapping(uint8 => uint32))) public override head; // latest correction per question

    error ElectionNotOpen();
    error ElectionNotStarted();
    error NotOrganizerOrReviewer();
    error AlreadyRecorded();
    error BallotSpoiledAlready();
    error BallotCapReached();
    error EmptyResults();
    error NoReadings();
    error NotADevice(address device);
    error DuplicateDevice(address device);
    error BadSignature(address expected);
    error ImageHashMismatch();
    error QuorumNotMet(uint256 valid, uint8 quorum);
    error NotAReviewer(address reviewer);
    error UnknownBallot();
    error WrongPrevIndex(uint32 expected, uint32 given);
    error WrongFromResult();
    error BadCorrection();
    error NotCorrectionAuthor();
    error PoolProofRequired();
    error BallotNotInPool(bytes32 ballotKey);
    error ProofCountMismatch();

    constructor(IElectionRegistry registry_) EIP712("B.E.I.N.G.S.", "1") {
        registry = registry_;
    }

    // ---------------------------------------------------------------- records

    function submitRecord(Submission calldata s) external {
        if (registry.poolEnforced(s.electionKey)) revert PoolProofRequired();
        _accept(s);
    }

    /// @notice Pooled elections. `rootIndex` 0 is the creation root; later indexes are `addBallots` roots.
    function submitRecord(Submission calldata s, bytes32[] calldata proof, uint256 rootIndex) external {
        _requireInPool(s.electionKey, s.ballotKey, proof, rootIndex);
        _accept(s);
    }

    /// @notice Offline sync: many records in one transaction. All-or-nothing.
    ///         For a pooled election this reverts with `PoolProofRequired`; use the proof-carrying overload.
    function submitBatch(Submission[] calldata batch) external {
        for (uint256 i = 0; i < batch.length; i++) {
            if (registry.poolEnforced(batch[i].electionKey)) revert PoolProofRequired();
            _accept(batch[i]);
        }
    }

    /// @notice Offline sync for pooled elections. One proof and one root index per record. All-or-nothing.
    function submitBatch(Submission[] calldata batch, bytes32[][] calldata proofs, uint256[] calldata rootIndexes) external {
        if (batch.length != proofs.length || batch.length != rootIndexes.length) revert ProofCountMismatch();
        for (uint256 i = 0; i < batch.length; i++) {
            _requireInPool(batch[i].electionKey, batch[i].ballotKey, proofs[i], rootIndexes[i]);
            _accept(batch[i]);
        }
    }

    /// Elections that were not created with the pool flag skip this. A failed proof names the ballot key, never a code.
    function _requireInPool(bytes32 electionKey, bytes32 ballotKey, bytes32[] calldata proof, uint256 rootIndex) private view {
        if (!registry.poolEnforced(electionKey)) return;
        if (!registry.ballotListedIn(electionKey, ballotKey, proof, rootIndex)) revert BallotNotInPool(ballotKey);
    }

    function _accept(Submission calldata s) private {
        (, IElectionRegistry.Status status, uint32 ballotCount, , uint8 quorum, , , ) = registry.elections(s.electionKey);
        if (status != IElectionRegistry.Status.Open) revert ElectionNotOpen();
        if (records[s.electionKey][s.ballotKey].acceptedAt != 0) revert AlreadyRecorded();
        if (spoiled[s.electionKey][s.ballotKey]) revert BallotSpoiledAlready();
        if (recordCount[s.electionKey] >= ballotCount) revert BallotCapReached();
        if (bytes(s.results).length == 0) revert EmptyResults();

        bytes32 resultsHash = keccak256(bytes(s.results));
        uint256 valid = _checkReadings(s, resultsHash);

        bool reviewed = false;
        if (s.reviewer != address(0)) {
            _checkReviewer(s, resultsHash);
            reviewed = true;
        } else if (valid < quorum) {
            revert QuorumNotMet(valid, quorum);
        }

        records[s.electionKey][s.ballotKey] = Record({
            results: s.results,
            imageSha256: s.imageSha256,
            recordSha256: s.recordSha256,
            acceptedAt: uint64(block.timestamp),
            reviewed: reviewed
        });
        recordCount[s.electionKey] += 1;

        emit BallotAccepted(s.electionKey, s.ballotKey, s.results, s.imageSha256, s.recordSha256, reviewed);
    }

    /// Verifies every reading; returns how many (all of them, or reverts).
    function _checkReadings(Submission calldata s, bytes32 resultsHash) private view returns (uint256) {
        uint256 n = s.readings.length;
        if (n == 0) revert NoReadings();
        bool imageMatched = false;
        for (uint256 i = 0; i < n; i++) {
            Reading calldata r = s.readings[i];
            if (registry.roles(s.electionKey, r.device) != IElectionRegistry.Role.Device) revert NotADevice(r.device);
            for (uint256 j = 0; j < i; j++) {
                if (s.readings[j].device == r.device) revert DuplicateDevice(r.device);
            }
            bytes32 digest = _hashTypedDataV4(
                keccak256(abi.encode(READING_TYPEHASH, s.electionKey, s.ballotKey, resultsHash, r.imageSha256, r.scoresHash))
            );
            if (!_signedBy(digest, r.sig, r.device)) revert BadSignature(r.device);
            if (r.imageSha256 == s.imageSha256) imageMatched = true;
        }
        if (!imageMatched) revert ImageHashMismatch();
        return n;
    }

    function _checkReviewer(Submission calldata s, bytes32 resultsHash) private view {
        if (registry.roles(s.electionKey, s.reviewer) != IElectionRegistry.Role.Reviewer) revert NotAReviewer(s.reviewer);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REVIEW_TYPEHASH, s.electionKey, s.ballotKey, resultsHash)));
        if (!_signedBy(digest, s.reviewerSig, s.reviewer)) revert BadSignature(s.reviewer);
    }

    /// Valid, canonical (low-s) 65-byte signature by `signer`. Never reverts.
    function _signedBy(bytes32 digest, bytes calldata sig, address signer) private pure returns (bool) {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError && recovered == signer && signer != address(0);
    }

    // ---------------------------------------------------------------- corrections and spoil marks

    /// @notice Reviewer or organizer only. `prevIndex` must equal head[...] so corrections form a chain.
    function postCorrection(bytes32 electionKey, Correction calldata c) external {
        (address organizer, IElectionRegistry.Status status, , , , , , ) = registry.elections(electionKey);
        if (
            status != IElectionRegistry.Status.Open &&
            status != IElectionRegistry.Status.Closed &&
            status != IElectionRegistry.Status.Tallied
        ) revert ElectionNotOpen();
        if (msg.sender != organizer && registry.roles(electionKey, msg.sender) != IElectionRegistry.Role.Reviewer) {
            revert NotOrganizerOrReviewer();
        }
        if (c.by != msg.sender) revert NotCorrectionAuthor();

        uint32 index = _applyCorrection(electionKey, c);
        _emitCorrection(electionKey, index, c);
    }

    function _applyCorrection(bytes32 electionKey, Correction calldata c) private returns (uint32 index) {
        Record storage rec = records[electionKey][c.ballotKey];
        if (rec.acceptedAt == 0) revert UnknownBallot();

        uint32 current = head[electionKey][c.ballotKey][c.questionIndex];
        if (c.prevIndex != current) revert WrongPrevIndex(current, c.prevIndex);

        if (
            c.reason == Reason.None ||
            bytes(c.toResult).length == 0 ||
            keccak256(bytes(c.toResult)) == keccak256(bytes(c.fromResult))
        ) revert BadCorrection();

        // fromResult must be the question's current result
        bytes32 fromHash = keccak256(bytes(c.fromResult));
        if (current == 0) {
            (bool found, bytes32 segHash) = ResultString.segmentHash(rec.results, c.questionIndex);
            if (!found || segHash != fromHash) revert WrongFromResult();
        } else if (keccak256(bytes(corrections[electionKey][current - 1].toResult)) != fromHash) {
            revert WrongFromResult();
        }

        Correction memory stored = c;
        stored.at = uint64(block.timestamp);
        corrections[electionKey].push(stored);
        index = uint32(corrections[electionKey].length); // 1-based
        head[electionKey][c.ballotKey][c.questionIndex] = index;
    }

    function _emitCorrection(bytes32 electionKey, uint32 index, Correction calldata c) private {
        emit CorrectionPosted(
            electionKey,
            c.ballotKey,
            index,
            c.prevIndex,
            c.questionIndex,
            c.fromResult,
            c.toResult,
            c.reason,
            c.evidenceSha256
        );
    }

    /// @notice Organizer or reviewer. Spoiled ballots cannot later be recorded. `replacedByKey` may be zero.
    function markSpoiled(bytes32 electionKey, bytes32 ballotKey, bytes32 replacedByKey) external {
        (address organizer, IElectionRegistry.Status status, , , , , , ) = registry.elections(electionKey);
        if (status != IElectionRegistry.Status.Open && status != IElectionRegistry.Status.Closed) revert ElectionNotOpen();
        if (msg.sender != organizer && registry.roles(electionKey, msg.sender) != IElectionRegistry.Role.Reviewer) {
            revert NotOrganizerOrReviewer();
        }
        if (records[electionKey][ballotKey].acceptedAt != 0) revert AlreadyRecorded();
        if (spoiled[electionKey][ballotKey]) revert BallotSpoiledAlready();
        if (replacedByKey == ballotKey) revert BadCorrection();
        spoiled[electionKey][ballotKey] = true;
        spoiledCount[electionKey] += 1;
        emit BallotSpoiled(electionKey, ballotKey, replacedByKey);
    }

    function correctionCount(bytes32 electionKey) external view returns (uint256) {
        return corrections[electionKey].length;
    }

    /// @notice The EIP-712 domain separator (for off-chain signers and tests).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
