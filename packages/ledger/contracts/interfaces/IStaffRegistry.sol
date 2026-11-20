// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStaffRegistry
/// @notice On-chain staff roster for one election: wallets, positions, a roster-file hash, and disclosed amendments.
/// @dev Names stay off-chain. A stored name hash is keccak256(abi.encode(salt, normalizedName)). The salt is a
///      random 32-byte value kept off-chain. It is not a function argument and it is not stored here.
///      This contract does not replace ElectionRegistry or BallotLedger.
interface IStaffRegistry {
    enum Role { Admin, Officer, Verifier, Scanner, System }
    /// Chosen once, when the Election Admin is recorded. 0 Standard, 1 Test, 2 Classroom.
    enum Kind { Standard, Test, Classroom }

    struct StaffProof {
        uint8 role;
        uint16 seatNo;
        address wallet;
        bytes32 nameHash;
        uint256 nonce;
        string adultAttestation;
        bytes claimSig;
        bytes approvalSig;
    }

    struct StaffingReport {
        bool known;
        uint8 kind;
        bool testAttested;
        bool locked;
        bytes32 lockedRosterHash;
        bytes32 currentRosterHash;
        uint64 lockedAt;
        uint256 approvedWalletCount;
        bool adminFilled;
        bool officerFilled;
        bool verifierFilled;
        bool scannerFilled;
        bool systemFilled;
        bool anyCovered;
        bool threeRolesDistinct;
        bool certifiedStaffingReady;
        uint256 ballotHandlerCount;
        /// True once a System admin sign-off has been stored. A later roster change can make it stale.
        bool systemSignOffRecorded;
    }

    event ElectionAdminRecorded(bytes32 indexed electionId, address indexed admin, uint8 kind);
    event StaffRecorded(
        bytes32 indexed electionId,
        bytes32 indexed positionId,
        uint8 role,
        uint16 seatNo,
        address indexed wallet,
        bytes32 nameHash,
        uint64 timestamp
    );
    event StaffReplaced(
        bytes32 indexed electionId,
        bytes32 indexed positionId,
        address oldWallet,
        address indexed newWallet,
        uint64 timestamp
    );
    event StaffCovered(
        bytes32 indexed electionId,
        bytes32 indexed positionId,
        address indexed admin,
        bytes32 statementHash,
        uint64 timestamp
    );
    event TestElectionAttested(bytes32 indexed electionId, address indexed admin, bytes32 statementHash, uint64 timestamp);
    event RosterLocked(
        bytes32 indexed electionId,
        bytes32 rosterHash,
        address indexed signer,
        bytes signature,
        bool staffingIncomplete,
        bool testDisclosed,
        uint64 timestamp
    );
    /// An Election officer witnessed paper handling. `action` 1 is a print run, 2 a scan batch, 3 ballots stored.
    /// `scanner` is the Scanner operator for 1 and 2, and the zero address for 3.
    event CustodyWitnessed(
        bytes32 indexed electionId,
        uint8 action,
        bytes32 subjectHash,
        address indexed officer,
        address indexed scanner,
        uint64 timestamp
    );
    /// Close-out verification by the System admin wallet. Required before a Standard election is certification-ready.
    /// Optional for Test and Classroom: `requiredForCertification` is false, and the record is still public.
    event SystemSignOffRecorded(
        bytes32 indexed electionId,
        address indexed signer,
        bytes32 rosterHash,
        bytes32 dutiesHash,
        bool requiredForCertification,
        uint64 timestamp
    );
    event RosterAmended(
        bytes32 indexed electionId,
        bytes32 indexed positionId,
        address oldWallet,
        address indexed newWallet,
        bytes32 newRosterHash,
        bytes32 reasonHash,
        uint64 timestamp
    );

    function recordElectionAdmin(bytes32 electionId, uint8 kind) external;
    function recordStaff(bytes32 electionId, StaffProof calldata proof) external;
    function recordStaffBatch(bytes32 electionId, StaffProof[] calldata proofs) external;
    function attestTestElection(bytes32 electionId, string calldata statement, bytes calldata signature) external;
    function coverPosition(
        bytes32 electionId,
        uint8 role,
        uint16 seatNo,
        string calldata statement,
        bytes calldata signature,
        bytes32 newRosterHash
    ) external;
    function lockRoster(
        bytes32 electionId,
        bytes32 rosterHash,
        string calldata attestation,
        bytes calldata attestationSig,
        string calldata testStatement,
        bytes calldata testSig
    ) external;
    function amendStaff(bytes32 electionId, StaffProof calldata proof, bytes32 newRosterHash, bytes32 reasonHash) external;

    struct SystemSignOffProof {
        bytes32 rosterHash;
        bytes32[] positionIds;
        bytes32[] sheetHashes;
        string statement;
        bytes signature;
    }

    /// @notice Close-out. The System admin signs, and the organizer or that same wallet pays the gas.
    ///         `positionIds` are the positions covered. `sheetHashes` are the duty and close-out sheet hashes, in the same order.
    ///         The statement is the fixed System admin sentence. A Standard election is not certification-ready without this.
    function recordSystemSignOff(bytes32 electionId, SystemSignOffProof calldata proof) external;

    /// Optional hook. An Election officer co-signs a print run or a scan batch with the Scanner operator,
    /// or signs alone that the paper ballots were stored. The organizer pays the gas.
    function recordCustody(
        bytes32 electionId,
        uint8 action,
        bytes32 subjectHash,
        address officer,
        address scanner,
        uint256 nonce,
        bytes calldata officerSig,
        bytes calldata scannerSig
    ) external;

    function staffingReport(bytes32 electionId) external view returns (StaffingReport memory);
    function certifiedStaffingReady(bytes32 electionId) external view returns (bool);
    function systemSignOff(bytes32 electionId)
        external
        view
        returns (
            bool recorded,
            bool requiredForCertification,
            bool current,
            address signer,
            bytes32 rosterHash,
            bytes32 dutiesHash,
            bytes32 positionSetHash,
            uint64 recordedAt
        );
    function systemSignOffPositions(bytes32 electionId) external view returns (bytes32[] memory positionIds, bytes32[] memory sheetHashes);
    function certificationSigners(bytes32 electionId)
        external
        view
        returns (address adminW, address officerW, address verifierW, bool distinct);
    function isApproved(bytes32 electionId, address wallet) external view returns (bool);
    function isApprovedScanner(bytes32 electionId, address wallet) external view returns (bool);
    function mayRecordBallots(bytes32 electionId, address wallet) external view returns (bool);
    function positionIdOf(uint8 role, uint16 seatNo) external pure returns (bytes32);
}
