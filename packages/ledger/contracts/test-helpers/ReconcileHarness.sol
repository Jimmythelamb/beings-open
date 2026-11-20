// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITally} from "../interfaces/ITally.sol";
import {ReconcileLib} from "../libraries/ReconcileLib.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ResultString} from "../libraries/ResultString.sol";

/// @dev TEST ONLY. Exposes the pure reconciliation, Merkle and results-string helpers so tests can feed them the core
///      package's test vectors directly. Never deploy.
contract ReconcileHarness {
    function failedChecks(
        ITally.Reconciliation memory r,
        uint32 registeredInRegistry,
        ITally.QuestionTally[] calldata perQ
    ) external pure returns (uint8) {
        return ReconcileLib.failedChecks(r, registeredInRegistry, perQ);
    }

    function unissued(uint32 printed, uint32 issued) external pure returns (uint32) {
        return ReconcileLib.unissued(printed, issued);
    }

    function segmentHash(string memory results, uint256 index) external pure returns (bool, bytes32) {
        return ResultString.segmentHash(results, index);
    }

    function verifyMerkle(bytes32[] calldata proof, bytes32 root, bytes32 leaf) external pure returns (bool) {
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }
}
