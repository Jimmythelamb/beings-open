// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITally} from "../interfaces/ITally.sol";

/// @title ReconcileLib
/// @notice Count reconciliation R1 to R6 (design spec 8.3 and 10.3). Pure. Mirrors `reconcile()` in the core package;
///         the two are checked against the shared test vectors.
library ReconcileLib {
    uint8 internal constant R1 = 1; // cast <= issued
    uint8 internal constant R2 = 2; // issued - spoiled <= registered (skipped when registered == 0)
    uint8 internal constant R3 = 4; // issued <= printed
    uint8 internal constant R4 = 8; // issued == cast + spoiled + unusedReturned
    uint8 internal constant R5 = 16; // every question: valid + blank + overvote + unclear == cast
    uint8 internal constant R6 = 32; // registered == the registry's registeredVoters

    /// @return mask Bit mask of FAILED checks; 0 = every check passed.
    function failedChecks(
        ITally.Reconciliation memory r,
        uint32 registeredInRegistry,
        ITally.QuestionTally[] calldata perQ
    ) internal pure returns (uint8 mask) {
        if (r.cast > r.issued) mask |= R1;
        // issued - spoiled <= registered, written without subtraction so it cannot underflow
        if (r.registered != 0 && uint256(r.issued) > uint256(r.registered) + uint256(r.spoiled)) mask |= R2;
        if (r.issued > r.printed) mask |= R3;
        if (uint256(r.issued) != uint256(r.cast) + uint256(r.spoiled) + uint256(r.unusedReturned)) mask |= R4;
        for (uint256 i = 0; i < perQ.length; i++) {
            ITally.QuestionTally calldata q = perQ[i];
            if (uint256(q.valid) + q.blank + q.overvote + q.unclear != uint256(r.cast)) {
                mask |= R5;
                break;
            }
        }
        if (r.registered != registeredInRegistry) mask |= R6;
    }

    /// printed - issued, clamped at 0 (R3 reports the underlying problem). Same as the core library.
    function unissued(uint32 printed, uint32 issued) internal pure returns (uint32) {
        return printed > issued ? printed - issued : 0;
    }
}
