// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVerifierRegistry
/// @notice Optional hook for verifier nodes (spec 10.4). No write path into the other contracts.
/// @dev INTERFACE ONLY. Not implemented, not audited.
///      IC16 [PROPOSED] (architecture doc): `reportVerificationSigned` lets a relayer submit; the contract recovers the
///      node from an EIP-712 `VerificationNotice` signature that binds every argument (see VerifierRegistry.sol and
///      the core package `signNotice`). This differs from the report-file signature `VerifierReport` (`signReport`).
interface IVerifierRegistry {
    struct Node {
        string name;
        string infoCid;
        uint64 registeredAt;
    }

    struct Metrics {
        uint32 nodeCount;
        uint32 nodesAllAgree;
        uint32 nodesWithDisagreement;
        uint64 ballotQuestionsChecked;
        uint64 ballotQuestionsAgreed;
    }

    struct ReportArgs {
        bytes32 electionKey;
        uint32 tallyVersion;
        string reportCid;
        bytes32 reportSha256;
        uint64 ballotQuestionsChecked;
        uint64 ballotQuestionsAgreed;
        bool tallyMatches;
        bool reconciliationMatches;
        bool merkleMatches;
        uint256 nonce; // must equal nonces[node]; ignored by reportVerification
    }

    event NodeRegistered(address indexed node, string name, string infoCid);
    event VerificationReported(
        bytes32 indexed electionKey, address indexed node, uint32 tallyVersion,
        string reportCid, bytes32 reportSha256,
        uint64 ballotQuestionsChecked, uint64 ballotQuestionsAgreed,
        bool tallyMatches, bool reconciliationMatches, bool merkleMatches
    );

    function register(string calldata name, string calldata infoCid) external;

    function reportVerification(
        bytes32 electionKey, uint32 tallyVersion, string calldata reportCid, bytes32 reportSha256,
        uint64 ballotQuestionsChecked, uint64 ballotQuestionsAgreed,
        bool tallyMatches, bool reconciliationMatches, bool merkleMatches
    ) external;

    function nodes(address node) external view returns (string memory name, string memory infoCid, uint64 registeredAt);
    function metrics(bytes32 electionKey)
        external
        view
        returns (
            uint32 nodeCount,
            uint32 nodesAllAgree,
            uint32 nodesWithDisagreement,
            uint64 ballotQuestionsChecked,
            uint64 ballotQuestionsAgreed
        );

    /// IC16 [PROPOSED]. Typed data: VerificationNotice(...), see the VerifierRegistry contract for the exact string.
    function reportVerificationSigned(ReportArgs calldata args, bytes calldata nodeSig) external;
}
