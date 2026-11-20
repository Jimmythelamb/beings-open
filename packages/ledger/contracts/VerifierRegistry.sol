// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IVerifierRegistry} from "./interfaces/IVerifierRegistry.sol";

/// @title VerifierRegistry
/// @notice Optional hook for verifier nodes (design spec 10.4). It has NO write path into the ElectionRegistry,
///         BallotLedger or Tally. Registration is optional and permissionless: any address can report.
/// @dev NOT AUDITED. It does not check that an election exists: reports are public signals, and a report for an unknown
///      election key only shows up under that key.
///
/// A node's later report for the same election replaces its earlier one in `metrics`; all reports stay in the event log.
/// A node "agrees" when ballotQuestionsAgreed == ballotQuestionsChecked and all three match flags are true.
///
/// IC16 [PROPOSED]: `reportVerificationSigned` lets a relayer submit for a node. The node signs EIP-712 typed data
/// (domain: name "B.E.I.N.G.S.", version "1", chainId, verifyingContract = this contract):
///   VerificationNotice(bytes32 electionKey,uint32 tallyVersion,bytes32 reportCidHash,bytes32 reportSha256,
///                      uint64 ballotQuestionsChecked,uint64 ballotQuestionsAgreed,bool tallyMatches,
///                      bool reconciliationMatches,bool merkleMatches,uint256 nonce)
/// where reportCidHash = keccak256(bytes(reportCid)). This is NOT the core library's `VerifierReport` signature
/// (keccak of the report file without its signature): that hash is not among the on-chain arguments, so it would
/// not bind the counts and flags a relayer could otherwise change. `nonce` must equal `nonces[node]` and is then
/// incremented, so a relayer cannot replay an older signed notice over a newer one.
contract VerifierRegistry is IVerifierRegistry, EIP712 {
    bytes32 public constant NOTICE_TYPEHASH =
        keccak256(
            "VerificationNotice(bytes32 electionKey,uint32 tallyVersion,bytes32 reportCidHash,bytes32 reportSha256,uint64 ballotQuestionsChecked,uint64 ballotQuestionsAgreed,bool tallyMatches,bool reconciliationMatches,bool merkleMatches,uint256 nonce)"
        );

    struct Latest {
        bool exists;
        bool allAgree;
        uint64 checked;
        uint64 agreed;
    }

    mapping(address => Node) public override nodes;
    mapping(bytes32 => Metrics) public override metrics; // electionKey => public metrics
    mapping(bytes32 => mapping(address => Latest)) public latest; // electionKey => node => latest report summary
    mapping(address => uint256) public nonces; // IC16 sequential nonce per node

    error AgreedExceedsChecked();
    error BadTallyVersion();
    error BadSignature();
    error BadNonce(uint256 expected);

    constructor() EIP712("B.E.I.N.G.S.", "1") {}

    /// @notice Optional. Anyone. Re-registering updates the name and info file.
    function register(string calldata name, string calldata infoCid) external {
        Node storage n = nodes[msg.sender];
        n.name = name;
        n.infoCid = infoCid;
        if (n.registeredAt == 0) n.registeredAt = uint64(block.timestamp);
        emit NodeRegistered(msg.sender, name, infoCid);
    }

    /// @notice Anyone. msg.sender is the node.
    function reportVerification(
        bytes32 electionKey,
        uint32 tallyVersion,
        string calldata reportCid,
        bytes32 reportSha256,
        uint64 ballotQuestionsChecked,
        uint64 ballotQuestionsAgreed,
        bool tallyMatches,
        bool reconciliationMatches,
        bool merkleMatches
    ) external {
        _report(
            msg.sender,
            ReportArgs({
                electionKey: electionKey,
                tallyVersion: tallyVersion,
                reportCid: reportCid,
                reportSha256: reportSha256,
                ballotQuestionsChecked: ballotQuestionsChecked,
                ballotQuestionsAgreed: ballotQuestionsAgreed,
                tallyMatches: tallyMatches,
                reconciliationMatches: reconciliationMatches,
                merkleMatches: merkleMatches,
                nonce: 0
            })
        );
    }

    /// @notice IC16 [PROPOSED]. Anyone (a relayer) may submit; the node is recovered from `nodeSig`.
    function reportVerificationSigned(ReportArgs calldata args, bytes calldata nodeSig) external {
        bytes32 digest = _hashTypedDataV4(_noticeStructHash(args));
        (address node, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, nodeSig);
        if (err != ECDSA.RecoverError.NoError || node == address(0)) revert BadSignature();
        if (args.nonce != nonces[node]) revert BadNonce(nonces[node]);
        nonces[node] = args.nonce + 1;
        _report(node, args);
    }

    function _noticeStructHash(ReportArgs calldata a) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    NOTICE_TYPEHASH,
                    a.electionKey,
                    a.tallyVersion,
                    keccak256(bytes(a.reportCid)),
                    a.reportSha256,
                    a.ballotQuestionsChecked,
                    a.ballotQuestionsAgreed,
                    a.tallyMatches,
                    a.reconciliationMatches,
                    a.merkleMatches,
                    a.nonce
                )
            );
    }

    function _report(address node, ReportArgs memory a) private {
        if (a.ballotQuestionsAgreed > a.ballotQuestionsChecked) revert AgreedExceedsChecked();
        if (a.tallyVersion == 0) revert BadTallyVersion();

        Metrics storage m = metrics[a.electionKey];
        Latest storage l = latest[a.electionKey][node];
        if (l.exists) {
            m.ballotQuestionsChecked -= l.checked;
            m.ballotQuestionsAgreed -= l.agreed;
            if (l.allAgree) m.nodesAllAgree -= 1;
            else m.nodesWithDisagreement -= 1;
        } else {
            m.nodeCount += 1;
            l.exists = true;
        }

        bool allAgree = a.ballotQuestionsAgreed == a.ballotQuestionsChecked &&
            a.tallyMatches &&
            a.reconciliationMatches &&
            a.merkleMatches;
        l.allAgree = allAgree;
        l.checked = a.ballotQuestionsChecked;
        l.agreed = a.ballotQuestionsAgreed;
        m.ballotQuestionsChecked += a.ballotQuestionsChecked;
        m.ballotQuestionsAgreed += a.ballotQuestionsAgreed;
        if (allAgree) m.nodesAllAgree += 1;
        else m.nodesWithDisagreement += 1;

        emit VerificationReported(
            a.electionKey,
            node,
            a.tallyVersion,
            a.reportCid,
            a.reportSha256,
            a.ballotQuestionsChecked,
            a.ballotQuestionsAgreed,
            a.tallyMatches,
            a.reconciliationMatches,
            a.merkleMatches
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
