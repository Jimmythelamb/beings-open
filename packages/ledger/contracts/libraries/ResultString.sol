// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ResultString
/// @notice Helpers for the joined results string, e.g. "V:c1|U|B" (spec 9.7): one segment per question, joined by "|".
library ResultString {
    /// @return found false if the string has no segment at `index` (or the segment is empty).
    /// @return segmentHash_ keccak256 of the segment's bytes.
    /// @dev Compares by hash so no memory copy is needed. Segment text is validated nowhere on-chain except that the
    ///      segment must be non-empty for a correction to apply.
    function segmentHash(string memory results, uint256 index) internal pure returns (bool found, bytes32 segmentHash_) {
        bytes memory b = bytes(results);
        uint256 seg = 0;
        uint256 start = 0;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == 0x7C) {
                // "|"
                if (seg == index) {
                    if (i == start) return (false, bytes32(0)); // empty segment
                    bytes32 h;
                    assembly ("memory-safe") {
                        h := keccak256(add(add(b, 0x20), start), sub(i, start))
                    }
                    return (true, h);
                }
                seg++;
                start = i + 1;
            }
        }
        return (false, bytes32(0));
    }
}
