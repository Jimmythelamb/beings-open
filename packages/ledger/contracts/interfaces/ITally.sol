// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ITally
/// @notice Posts the Merkle root, results and reconciliation counts; runs checks R1 to R6; inclusion proofs (spec 10.3).
/// @dev INTERFACE ONLY. Not implemented, not audited.
///      failedChecks bit mask: 1 R1, 2 R2, 4 R3, 8 R4, 16 R5, 32 R6 (0 = all passed). See the core package (beings-core) `reconcile`.
///      Merkle trees: keccak256, sorted-pair hashing (OpenZeppelin MerkleProof), odd node promoted,
///      leaves sorted; see the core package (beings-core) `merkleRoot` for the exact construction.
interface ITally {
    struct QuestionTally {
        uint32 valid;
        uint32 blank;
        uint32 overvote;
        uint32 unclear;
    }

    struct Reconciliation {
        uint32 registered;
        uint32 printed;
        uint32 issued;
        uint32 cast;
        uint32 spoiled;
        uint32 unusedReturned;
        uint32 unissued;
    }

    enum Finality { Provisional, Final }

    struct Result {
        uint32 version;
        bytes32 merkleRoot;
        Reconciliation recon;
        uint8 failedChecks;
        Finality finality;
        address clearedBy;
        string clearanceCid;
        string resultsCid;
        bytes32 resultsSha256;
        uint64 postedAt;
    }

    event TallyPosted(
        bytes32 indexed electionKey, uint32 version, bytes32 merkleRoot,
        uint32 issued, uint32 cast, uint32 spoiled, uint32 unusedReturned,
        uint8 failedChecks, Finality finality, string resultsCid
    );
    event ReviewRequired(bytes32 indexed electionKey, uint32 version, uint8 failedChecks);
    event ReviewCleared(bytes32 indexed electionKey, uint32 version, address indexed reviewer, string clearanceCid);

    function postTally(
        bytes32 electionKey, bytes32 merkleRoot, QuestionTally[] calldata perQ,
        uint32 registered, uint32 issued, uint32 unusedReturned,
        string calldata resultsCid, bytes32 resultsSha256
    ) external;

    function clearReview(bytes32 electionKey, uint32 version, string calldata clearanceCid) external;

    function postAmendedTally(
        bytes32 electionKey, bytes32 merkleRoot, QuestionTally[] calldata perQ,
        uint32 registered, uint32 issued, uint32 unusedReturned,
        string calldata resultsCid, bytes32 resultsSha256
    ) external;

    function isFinal(bytes32 electionKey) external view returns (bool);

    /// Number of tally versions posted (1-based versions: valid versions are 1..resultCount).
    function resultCount(bytes32 electionKey) external view returns (uint256);

    /// Full result for `version` (1-based).
    function getResult(bytes32 electionKey, uint32 version) external view returns (Result memory);

    function verifyInclusion(bytes32 electionKey, uint32 version, bytes32 leaf, bytes32[] calldata proof)
        external
        view
        returns (bool);
}
