// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IElectionRegistry} from "./interfaces/IElectionRegistry.sol";
import {IBallotLedger} from "./interfaces/IBallotLedger.sol";
import {ITally} from "./interfaces/ITally.sol";
import {ReconcileLib} from "./libraries/ReconcileLib.sol";

/// @title Tally
/// @notice Posts the Merkle root, the results and the reconciliation counts at close, runs checks R1 to R6 and
///         records any failure publicly, and supports inclusion proofs (design spec 10.3).
/// @dev NOT AUDITED.
///
/// What is and is not checked on-chain:
///   * `cast` and `spoiled` are READ from the BallotLedger, `printed` and the register count from the registry.
///   * The Merkle root and the per-question counts are SUPPLIED by the organizer; the contract cannot recompute them
///     (it does not hold the corrections applied to results). Every verifier node recomputes them off-chain.
///   * A failed check never reverts: the result is stored as Provisional, ReviewRequired is emitted and the
///     mismatch stays public. `failedChecks` bits: 1 R1, 2 R2, 4 R3, 8 R4, 16 R5, 32 R6.
///
/// [PROPOSED] choices where the spec is silent:
///   * Question `i` in `perQ` and in `perQuestion[key][version][i]` is the 0-based position in the election file's
///     question order (the same order as the ledger's results string and `questionIndex` of corrections).
///   * `postTally` and `postAmendedTally` need at least one question (an empty `perQ` would pass R5 vacuously).
///   * Final immediately when `failedChecks == 0`; otherwise Provisional until a Reviewer calls `clearReview`.
///   * `clearReview` only applies to the LATEST version, which must be Provisional, with a non-empty `clearanceCid`.
///   * Amended tallies need the election to be Tallied; the contract does not require corrections to exist.
contract Tally is ITally {
    IElectionRegistry public immutable registry;
    IBallotLedger public immutable ledger;

    mapping(bytes32 => Result[]) public results; // append-only history per election
    mapping(bytes32 => mapping(uint32 => mapping(uint8 => QuestionTally))) public perQuestion; // key => version => question

    error NotOrganizer();
    error NotReviewer();
    error WrongElectionStatus(IElectionRegistry.Status current);
    error NoQuestions();
    error TooManyQuestions();
    error NoTally();
    error NotLatestVersion(uint32 latest);
    error NotProvisional();
    error EmptyClearanceCid();

    constructor(IElectionRegistry registry_, IBallotLedger ledger_) {
        registry = registry_;
        ledger = ledger_;
    }

    struct Post {
        bytes32 merkleRoot;
        uint32 registered;
        uint32 issued;
        uint32 unusedReturned;
        string resultsCid;
        bytes32 resultsSha256;
    }

    /// @notice Organizer only; election must be Closed. Status becomes Tallied.
    function postTally(
        bytes32 electionKey,
        bytes32 merkleRoot,
        QuestionTally[] calldata perQ,
        uint32 registered,
        uint32 issued,
        uint32 unusedReturned,
        string calldata resultsCid,
        bytes32 resultsSha256
    ) external {
        _post(electionKey, perQ, Post(merkleRoot, registered, issued, unusedReturned, resultsCid, resultsSha256), false);
    }

    /// @notice Organizer only; election must be Tallied. Posts version + 1 and re-runs the checks.
    function postAmendedTally(
        bytes32 electionKey,
        bytes32 merkleRoot,
        QuestionTally[] calldata perQ,
        uint32 registered,
        uint32 issued,
        uint32 unusedReturned,
        string calldata resultsCid,
        bytes32 resultsSha256
    ) external {
        _post(electionKey, perQ, Post(merkleRoot, registered, issued, unusedReturned, resultsCid, resultsSha256), true);
    }

    /// Authorizes the caller and builds the reconciliation (reads cast/spoiled/printed from the other contracts).
    function _prepare(bytes32 electionKey, Post memory p, bool amended)
        private
        view
        returns (Reconciliation memory recon, uint32 registryRegistered)
    {
        address organizer;
        IElectionRegistry.Status status;
        (organizer, status, recon.printed, registryRegistered, , , , ) = registry.elections(electionKey);
        if (msg.sender != organizer) revert NotOrganizer();
        IElectionRegistry.Status want = amended ? IElectionRegistry.Status.Tallied : IElectionRegistry.Status.Closed;
        if (status != want) revert WrongElectionStatus(status);
        if (amended && results[electionKey].length == 0) revert NoTally();

        recon.registered = p.registered;
        recon.issued = p.issued;
        recon.unusedReturned = p.unusedReturned;
        recon.cast = ledger.recordCount(electionKey); // read from the ledger, not supplied
        recon.spoiled = ledger.spoiledCount(electionKey); // read from the ledger, not supplied
        recon.unissued = ReconcileLib.unissued(recon.printed, p.issued);
    }

    function _post(bytes32 electionKey, QuestionTally[] calldata perQ, Post memory p, bool amended) private {
        if (perQ.length == 0) revert NoQuestions();
        if (perQ.length > 255) revert TooManyQuestions();

        (Reconciliation memory recon, uint32 registryRegistered) = _prepare(electionKey, p, amended);
        uint8 failed = ReconcileLib.failedChecks(recon, registryRegistered, perQ);

        uint32 version = _store(electionKey, perQ, p, recon, failed);
        _announce(electionKey, version, p, recon, failed);

        if (!amended) registry.markTallied(electionKey);
    }

    function _store(
        bytes32 electionKey,
        QuestionTally[] calldata perQ,
        Post memory p,
        Reconciliation memory recon,
        uint8 failed
    ) private returns (uint32 version) {
        Result storage res = results[electionKey].push();
        version = uint32(results[electionKey].length); // 1-based
        res.version = version;
        res.merkleRoot = p.merkleRoot;
        res.recon = recon;
        res.failedChecks = failed;
        res.finality = failed == 0 ? Finality.Final : Finality.Provisional;
        res.resultsCid = p.resultsCid;
        res.resultsSha256 = p.resultsSha256;
        res.postedAt = uint64(block.timestamp);

        for (uint256 i = 0; i < perQ.length; i++) {
            perQuestion[electionKey][version][uint8(i)] = perQ[i];
        }
    }

    function _announce(bytes32 electionKey, uint32 version, Post memory p, Reconciliation memory recon, uint8 failed)
        private
    {
        emit TallyPosted(
            electionKey,
            version,
            p.merkleRoot,
            p.issued,
            recon.cast,
            recon.spoiled,
            p.unusedReturned,
            failed,
            failed == 0 ? Finality.Final : Finality.Provisional,
            p.resultsCid
        );
        if (failed != 0) emit ReviewRequired(electionKey, version, failed);
    }

    /// @notice Registered Reviewer only. Marks the latest Provisional result Final; the failed checks stay on the record.
    function clearReview(bytes32 electionKey, uint32 version, string calldata clearanceCid) external {
        if (registry.roles(electionKey, msg.sender) != IElectionRegistry.Role.Reviewer) revert NotReviewer();
        Result[] storage list = results[electionKey];
        if (list.length == 0) revert NoTally();
        if (version != list.length) revert NotLatestVersion(uint32(list.length));
        Result storage res = list[version - 1];
        if (res.finality != Finality.Provisional) revert NotProvisional();
        if (bytes(clearanceCid).length == 0) revert EmptyClearanceCid();
        res.finality = Finality.Final;
        res.clearedBy = msg.sender;
        res.clearanceCid = clearanceCid;
        emit ReviewCleared(electionKey, version, msg.sender, clearanceCid);
    }

    /// @notice True iff the latest version is Final.
    function isFinal(bytes32 electionKey) external view returns (bool) {
        Result[] storage list = results[electionKey];
        return list.length != 0 && list[list.length - 1].finality == Finality.Final;
    }

    /// @notice OpenZeppelin-style sorted-pair Merkle proof against the root posted for `version` (1-based).
    ///         False for an unknown version.
    function verifyInclusion(bytes32 electionKey, uint32 version, bytes32 leaf, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Result[] storage list = results[electionKey];
        if (version == 0 || version > list.length) return false;
        return MerkleProof.verifyCalldata(proof, list[version - 1].merkleRoot, leaf);
    }

    function resultCount(bytes32 electionKey) external view returns (uint256) {
        return results[electionKey].length;
    }

    /// @notice Full result for `version` (1-based).
    function getResult(bytes32 electionKey, uint32 version) external view returns (Result memory) {
        return results[electionKey][version - 1];
    }
}
