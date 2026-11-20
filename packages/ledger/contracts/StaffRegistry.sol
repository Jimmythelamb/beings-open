// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IElectionRegistry} from "./interfaces/IElectionRegistry.sol";
import {IStaffRegistry} from "./interfaces/IStaffRegistry.sol";

/// @title StaffRegistry
/// @notice Per-election staff roster on Flare Coston2 (chain id 114).
/// @dev NOT AUDITED. Sits beside the deployed ElectionRegistry. It does not replace it, and it does not
///      touch BallotLedger, Tally, or VerifierRegistry.
///
///      Why a separate contract: the live BallotLedger stores the ElectionRegistry address immutably, and
///      that registry has already used its one-time `setLedger`. A new ElectionRegistry would not be the
///      registry the live ledger asks about the ballot pool. New elections keep being created on the current
///      registry. This contract reads the organizer and the status from that registry and records the roster
///      next to it. Elections that never call `recordElectionAdmin` are left alone.
///
///      Names stay off-chain. Storage holds wallets, position ids, a salted name hash, and the keccak256 of the
///      public roster file. The name hash is keccak256(abi.encode(salt, normalizedName)). The salt is a random
///      32-byte value chosen in the browser for that staff entry. It is not an argument, it is not stored, and
///      it is not part of the EIP-712 typed data, so a transaction cannot reveal it. The public roster download
///      leaves it out as well. Staff sign an EIP-712 claim for free. The Election Administrator signs an
///      EIP-712 approval and pays the gas to submit both.
///
///      Domain: name "B.E.I.N.G.S.", version "1", chainId 114, verifyingContract = this contract.
///      StaffClaim(bytes32 electionId,bytes32 positionId,address wallet,bytes32 nameHash,uint256 nonce)
///      StaffApproval(bytes32 electionId,bytes32 positionId,address wallet,bytes32 nameHash,bytes32 claimDigest,uint256 nonce,string adultAttestation)
///      RosterLock(bytes32 electionId,bytes32 rosterHash,string attestation)
///      TestElectionAttestation(bytes32 electionId,string statement)
///      AdminCover(bytes32 electionId,bytes32 positionId,string statement)
///      SystemSignOff(bytes32 electionId,bytes32 rosterHash,bytes32 dutiesHash,bytes32 positionSetHash,string statement)
///
///      A position id is keccak256(abi.encode(uint8 role, uint16 seatNo)). Seat 1 is the primary line.
///      One wallet cannot hold two positions. The organizer wallet is the Election Admin and cannot be moved.
///      After the roster is locked, a change is `amendStaff`: it emits the old wallet, the new wallet, and the time.
///
///      Election kind is chosen in `recordElectionAdmin` and cannot be changed:
///      Standard (0) can be certification-ready only when every primary position has its own wallet,
///      none is covered, and each approval carries the legal-adult sentence.
///      Test (1) may record other adults, or cover positions after the test-election statement.
///      It is never certification-ready.
///      Classroom (2) is one administrator covering the other primary positions. It is never
///      certification-ready. The label is `CLASSROOM_LABEL`.
///
///      Scanner wallets: `mayRecordBallots` is the rule a later ledger can call. This deployment does not
///      change BallotLedger, so pool proofs and existing records stay where they are. When at least one
///      Scanner position has its own wallet, only those wallets are allowed. When the scanner line is still
///      covered, the existing Device role on the registry remains the gate.
///
///      Certified staffing (close-out can read this; this contract does not certify an election):
///      the roster is locked, the test-election attestation was not used, and Admin, Officer, Verifier,
///      Scanner, and System each have their own wallet, with no covered line. The three certification
///      roles are then three distinct wallets. A Standard election also needs the System admin's close-out
///      sign-off, covering every filled position. Test and Classroom may record that same sign-off. It is
///      disclosed and does not make them certification-ready.
///
///      On a test election only, the administrator may cover other positions after signing
///      "This election was used and identified as a test election". That cover is stored and emitted.
///      It does not give the administrator a second position. A roster locked on that path is never
///      reported as ready to certify.
contract StaffRegistry is IStaffRegistry, EIP712 {
    uint256 public constant COSTON2_CHAIN_ID = 114;
    uint16 public constant MAX_SEAT = 8;
    uint256 public constant MAX_BATCH = 8;
    uint256 public constant MAX_POSITIONS = 24;

    string public constant LOCK_ATTESTATION = "I have reviewed this staff roster and confirm it is accurate and complete";
    string public constant TEST_STATEMENT = "This election was used and identified as a test election";
    string public constant ADULT_ATTESTATION = "I attest that this staff member is a legal adult (18, or the age of majority where they live).";
    string public constant SYSTEM_SIGNOFF = "I verify that this roster's roles and wallets were set up correctly, and that each listed position's duties were verified complete.";
    string public constant CLASSROOM_LABEL = "Classroom election (single administrator), not certified";
    /// Election officers handle the paper ballots. A standard election needs at least this many.
    uint256 public constant MIN_BALLOT_HANDLERS = 2;
    /// 1 an officer co-signs a print run. 2 an officer co-signs a scan batch. 3 an officer records that the paper was stored.
    uint8 public constant CUSTODY_PRINT_RUN = 1;
    uint8 public constant CUSTODY_SCAN_BATCH = 2;
    uint8 public constant CUSTODY_BALLOTS_STORED = 3;

    bytes32 public constant STAFF_CLAIM_TYPEHASH =
        keccak256("StaffClaim(bytes32 electionId,bytes32 positionId,address wallet,bytes32 nameHash,uint256 nonce)");
    bytes32 public constant STAFF_APPROVAL_TYPEHASH =
        keccak256("StaffApproval(bytes32 electionId,bytes32 positionId,address wallet,bytes32 nameHash,bytes32 claimDigest,uint256 nonce,string adultAttestation)");
    bytes32 public constant ROSTER_LOCK_TYPEHASH =
        keccak256("RosterLock(bytes32 electionId,bytes32 rosterHash,string attestation)");
    bytes32 public constant TEST_ATTESTATION_TYPEHASH =
        keccak256("TestElectionAttestation(bytes32 electionId,string statement)");
    bytes32 public constant ADMIN_COVER_TYPEHASH =
        keccak256("AdminCover(bytes32 electionId,bytes32 positionId,string statement)");
    bytes32 public constant CUSTODY_TYPEHASH =
        keccak256("CustodyWitness(bytes32 electionId,uint8 action,bytes32 subjectHash,address officer,address scanner,uint256 nonce)");
    bytes32 public constant SYSTEM_SIGNOFF_TYPEHASH =
        keccak256("SystemSignOff(bytes32 electionId,bytes32 rosterHash,bytes32 dutiesHash,bytes32 positionSetHash,string statement)");

    IElectionRegistry public immutable registry;

    struct Seat {
        address wallet;
        bytes32 nameHash;
        uint64 recordedAt;
        uint64 amendedAt;
        uint32 amendmentCount;
        uint256 nonce;
        bool coveredByAdmin;
        bool exists;
        uint8 role;
        uint16 seatNo;
    }

    struct Roster {
        bool known;
        uint8 kind;
        bool testAttested;
        bool locked;
        bytes32 lockedRosterHash;
        bytes32 currentRosterHash;
        uint64 lockedAt;
        address lockSigner;
    }

    mapping(bytes32 => Roster) private _rosters;
    mapping(bytes32 => mapping(bytes32 => Seat)) private _seats;
    mapping(bytes32 => bytes32[]) private _positions;
    mapping(bytes32 => mapping(address => bytes32)) private _byWallet;
    mapping(bytes32 => bytes) private _lockSig;

    struct SystemNote {
        bool recorded;
        address signer;
        bytes32 rosterHash;
        bytes32 dutiesHash;
        bytes32 positionSetHash;
        uint64 recordedAt;
    }

    mapping(bytes32 => SystemNote) private _systemNote;
    mapping(bytes32 => bytes32[]) private _systemPositions;
    mapping(bytes32 => bytes32[]) private _systemSheets;
    mapping(bytes32 => bytes) private _systemSig;

    struct CustodyNote {
        uint8 action;
        bytes32 subjectHash;
        address officer;
        address scanner;
        uint64 witnessedAt;
        uint256 nonce;
    }

    mapping(bytes32 => CustodyNote[]) private _custody;
    mapping(bytes32 => mapping(uint256 => bool)) private _custodyNonceUsed;

    error WrongChain(uint256 chainId);
    error ZeroAddress();
    error UnknownElection();
    error NotOrganizer();
    error WrongStatus(IElectionRegistry.Status current);
    error AdminNotRecorded();
    error AdminAlreadyRecorded();
    error AdminFixed();
    error RosterIsLocked();
    error NotLocked();
    error AlreadyLocked();
    error BadRosterSignature();
    error WalletInTwoPositions(address wallet, bytes32 existingPosition);
    error BadPosition();
    error NonceUsed();
    error BadAttestation();
    error EmptyRosterHash();
    error EmptyBatch();
    error BatchTooLarge(uint256 count);
    error DuplicateInBatch();
    error TooManyPositions();
    error NotATestElection();
    error BadElectionKind();
    error ClassroomIsSingleAdmin();
    error AdultAttestationRequired();
    error BadCustodyAction();
    error NotAHandler(address wallet);
    error NotAScanner(address wallet);
    error ScannerNotOnThisStep();
    error AlreadyAttested();
    error TestAttestationRequired();
    error StaffingBlocksLock();
    error PositionOccupied(bytes32 positionId);
    error EmptyReason();
    error NotASystemAdmin();
    error SignOffIncomplete();
    error SignOffStale();
    error AlreadySigned();
    error NotSignOffParty();

    constructor(address registry_) EIP712("B.E.I.N.G.S.", "1") {
        if (block.chainid != COSTON2_CHAIN_ID) revert WrongChain(block.chainid);
        if (registry_ == address(0)) revert ZeroAddress();
        registry = IElectionRegistry(registry_);
    }

    // ---------------------------------------------------------------- writes

    /// @notice Organizer only, once, while the election is still in Setup. Fixes the election kind.
    ///         Classroom also records the other primary positions as covered by this administrator.
    function recordElectionAdmin(bytes32 electionId, uint8 kind) external {
        (address organizer, IElectionRegistry.Status status) = _requireOrganizer(electionId);
        if (status != IElectionRegistry.Status.Setup) revert WrongStatus(status);
        if (_rosters[electionId].known) revert AdminAlreadyRecorded();
        if (kind > uint8(Kind.Classroom)) revert BadElectionKind();
        bytes32 pid = positionIdOf(uint8(Role.Admin), 1);
        _rosters[electionId].known = true;
        _rosters[electionId].kind = kind;
        _writeSeat(electionId, pid, uint8(Role.Admin), 1, organizer, bytes32(0), 0, false);
        emit ElectionAdminRecorded(electionId, organizer, kind);
        if (kind == uint8(Kind.Classroom)) {
            _coverPrimary(electionId, organizer, uint8(Role.Officer));
            _coverPrimary(electionId, organizer, uint8(Role.Verifier));
            _coverPrimary(electionId, organizer, uint8(Role.Scanner));
            _coverPrimary(electionId, organizer, uint8(Role.System));
        }
    }

    function recordStaff(bytes32 electionId, StaffProof calldata proof) external {
        _recordOne(electionId, proof);
    }

    function recordStaffBatch(bytes32 electionId, StaffProof[] calldata proofs) external {
        uint256 n = proofs.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n);
        bool[] memory seenRole = new bool[](5 * (uint256(MAX_SEAT) + 1));
        for (uint256 i = 0; i < n; i++) {
            uint256 mark = uint256(proofs[i].role) * (uint256(MAX_SEAT) + 1) + uint256(proofs[i].seatNo);
            if (proofs[i].role > uint8(Role.System) || proofs[i].seatNo == 0 || proofs[i].seatNo > MAX_SEAT) revert BadPosition();
            if (seenRole[mark]) revert DuplicateInBatch();
            seenRole[mark] = true;
            _recordOne(electionId, proofs[i]);
        }
    }

    /// @notice Test elections only. The statement must be the exact test-election sentence.
    function attestTestElection(bytes32 electionId, string calldata statement, bytes calldata signature) external {
        (address organizer, ) = _requireOrganizer(electionId);
        _acceptTestAttestation(electionId, organizer, statement, signature);
    }

    /// @notice Test elections only. Marks one other position as covered by the administrator.
    ///         The administrator's wallet is not written onto that position.
    ///         After the lock, pass the new roster-file hash so the change is an amendment.
    function coverPosition(
        bytes32 electionId,
        uint8 role,
        uint16 seatNo,
        string calldata statement,
        bytes calldata signature,
        bytes32 newRosterHash
    ) external {
        (address organizer, ) = _requireOrganizer(electionId);
        Roster storage roster = _rosters[electionId];
        if (!roster.known) revert AdminNotRecorded();
        if (roster.kind != uint8(Kind.Test)) revert NotATestElection();
        if (!roster.testAttested) revert TestAttestationRequired();
        if (keccak256(bytes(statement)) != keccak256(bytes(TEST_STATEMENT))) revert BadAttestation();
        if (role == uint8(Role.Admin)) revert AdminFixed();
        bytes32 pid = positionIdOf(role, seatNo);
        bytes32 coverDigest = _hashTypedDataV4(
            keccak256(abi.encode(ADMIN_COVER_TYPEHASH, electionId, pid, keccak256(bytes(statement))))
        );
        if (!_signedBy(coverDigest, signature, organizer)) revert BadRosterSignature();
        Seat storage row = _seats[electionId][pid];
        if (row.exists && row.wallet != address(0)) revert PositionOccupied(pid);
        _writeSeat(electionId, pid, role, seatNo, address(0), bytes32(0), row.nonce, true);
        emit StaffCovered(electionId, pid, organizer, keccak256(bytes(TEST_STATEMENT)), uint64(block.timestamp));
        if (roster.locked) {
            if (newRosterHash == bytes32(0) || newRosterHash == roster.currentRosterHash) revert EmptyRosterHash();
            roster.currentRosterHash = newRosterHash;
            emit RosterAmended(electionId, pid, address(0), address(0), newRosterHash, keccak256(bytes(TEST_STATEMENT)), uint64(block.timestamp));
        }
    }

    /// @notice Organizer, Setup only, once. Stores the roster-file hash and the review signature.
    ///         Standard reverts while a required position is missing or any position is covered.
    ///         Test may lock with those gaps only after the test statement. Classroom may lock as it is:
    ///         one administrator covering the other positions. Only Standard can later report certification-ready.
    function lockRoster(
        bytes32 electionId,
        bytes32 rosterHash,
        string calldata attestation,
        bytes calldata attestationSig,
        string calldata testStatement,
        bytes calldata testSig
    ) external {
        (address organizer, IElectionRegistry.Status status) = _requireOrganizer(electionId);
        if (status != IElectionRegistry.Status.Setup) revert WrongStatus(status);
        _checkLock(electionId, organizer, rosterHash, attestation, attestationSig);
        _applyTestSig(electionId, organizer, testStatement, testSig);
        bool incomplete = _lockStaffing(electionId);
        _storeLock(electionId, organizer, rosterHash, attestationSig, incomplete);
    }

    /// @notice After the lock. Replaces the wallet on one position and emits the old wallet, the new wallet, and the time.
    ///         The hash stored at lock does not change. `newRosterHash` is the hash of the updated off-chain file.
    function amendStaff(bytes32 electionId, StaffProof calldata proof, bytes32 newRosterHash, bytes32 reasonHash) external {
        (address organizer, ) = _requireOrganizer(electionId);
        Roster storage roster = _rosters[electionId];
        if (!roster.known) revert AdminNotRecorded();
        if (roster.kind == uint8(Kind.Classroom)) revert ClassroomIsSingleAdmin();
        if (!roster.locked) revert NotLocked();
        if (newRosterHash == bytes32(0) || newRosterHash == roster.currentRosterHash) revert EmptyRosterHash();
        if (reasonHash == bytes32(0)) revert EmptyReason();
        if (proof.role == uint8(Role.Admin)) revert AdminFixed();
        bytes32 pid = positionIdOf(proof.role, proof.seatNo);
        Seat storage row = _seats[electionId][pid];
        address oldWallet = row.wallet;
        _acceptStaff(electionId, organizer, pid, proof);
        _writeSeat(electionId, pid, proof.role, proof.seatNo, proof.wallet, proof.nameHash, proof.nonce, false);
        row.amendedAt = uint64(block.timestamp);
        row.amendmentCount += 1;
        roster.currentRosterHash = newRosterHash;
        emit RosterAmended(electionId, pid, oldWallet, proof.wallet, newRosterHash, reasonHash, uint64(block.timestamp));
    }

    /// @notice Close-out, after voting is closed or the tally is published. The System admin signs for free.
    ///         The organizer or that System admin wallet pays the gas. Standard elections need this before
    ///         `certifiedStaffingReady` is true. Test and Classroom may record it; it is disclosed either way
    ///         and does not make those elections certification-ready.
    function recordSystemSignOff(bytes32 electionId, SystemSignOffProof calldata proof) external {
        (address organizer, IElectionRegistry.Status status, ) = _readElection(electionId);
        if (status != IElectionRegistry.Status.Closed && status != IElectionRegistry.Status.Tallied) revert WrongStatus(status);
        if (!_rosters[electionId].known) revert AdminNotRecorded();
        if (!_rosters[electionId].locked) revert NotLocked();
        address systemWallet = _systemWallet(electionId);
        if (systemWallet == address(0)) revert NotASystemAdmin();
        if (msg.sender != organizer && msg.sender != systemWallet) revert NotSignOffParty();
        if (proof.rosterHash == bytes32(0) || proof.rosterHash != _rosters[electionId].currentRosterHash) revert SignOffStale();
        if (keccak256(bytes(proof.statement)) != keccak256(bytes(SYSTEM_SIGNOFF))) revert BadAttestation();
        _checkSignOffSet(electionId, proof.positionIds, proof.sheetHashes);
        if (!_signedBy(_signOffDigest(electionId, proof), proof.signature, systemWallet)) revert BadRosterSignature();
        _storeSignOff(electionId, systemWallet, proof);
    }

    function _signOffDigest(bytes32 electionId, SystemSignOffProof calldata proof) private view returns (bytes32 digest) {
        digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SYSTEM_SIGNOFF_TYPEHASH,
                    electionId,
                    proof.rosterHash,
                    keccak256(abi.encode(proof.positionIds, proof.sheetHashes)),
                    keccak256(abi.encode(proof.positionIds)),
                    keccak256(bytes(proof.statement))
                )
            )
        );
    }

    function _storeSignOff(bytes32 electionId, address systemWallet, SystemSignOffProof calldata proof) private {
        bytes32 dutiesHash = keccak256(abi.encode(proof.positionIds, proof.sheetHashes));
        bytes32 setHash = keccak256(abi.encode(proof.positionIds));
        SystemNote storage note = _systemNote[electionId];
        if (note.recorded && note.rosterHash == proof.rosterHash && note.positionSetHash == setHash) revert AlreadySigned();
        _replaceSignOffLists(electionId, proof);
        note.recorded = true;
        note.signer = systemWallet;
        note.rosterHash = proof.rosterHash;
        note.dutiesHash = dutiesHash;
        note.positionSetHash = setHash;
        note.recordedAt = uint64(block.timestamp);
        _systemSig[electionId] = proof.signature;
        emit SystemSignOffRecorded(electionId, systemWallet, proof.rosterHash, dutiesHash, _rosters[electionId].kind == uint8(Kind.Standard), note.recordedAt);
    }

    function _replaceSignOffLists(bytes32 electionId, SystemSignOffProof calldata proof) private {
        delete _systemPositions[electionId];
        delete _systemSheets[electionId];
        for (uint256 i = 0; i < proof.positionIds.length; i++) {
            _systemPositions[electionId].push(proof.positionIds[i]);
            _systemSheets[electionId].push(proof.sheetHashes[i]);
        }
    }

    // ---------------------------------------------------------------- views

    function positionIdOf(uint8 role, uint16 seatNo) public pure returns (bytes32) {
        if (role > uint8(Role.System) || seatNo == 0 || seatNo > MAX_SEAT) revert BadPosition();
        return keccak256(abi.encode(role, seatNo));
    }

    function staffingReport(bytes32 electionId) external view returns (StaffingReport memory report) {
        Roster storage roster = _rosters[electionId];
        report.known = roster.known;
        report.kind = roster.kind;
        report.testAttested = roster.testAttested;
        report.locked = roster.locked;
        report.lockedRosterHash = roster.lockedRosterHash;
        report.currentRosterHash = roster.currentRosterHash;
        report.lockedAt = roster.lockedAt;
        report.adminFilled = _filled(electionId, uint8(Role.Admin), 1);
        report.officerFilled = _filled(electionId, uint8(Role.Officer), 1);
        report.verifierFilled = _filled(electionId, uint8(Role.Verifier), 1);
        report.scannerFilled = _filled(electionId, uint8(Role.Scanner), 1);
        report.systemFilled = _filled(electionId, uint8(Role.System), 1);
        report.anyCovered = _anyCovered(electionId);
        (address adminW, address officerW, address verifierW, bool distinct) = _certificationSigners(electionId);
        report.threeRolesDistinct = distinct && adminW != address(0) && officerW != address(0) && verifierW != address(0);
        report.approvedWalletCount = _walletCount(electionId);
        report.certifiedStaffingReady = _certifiedReady(electionId);
        report.ballotHandlerCount = _handlerCount(electionId);
        report.systemSignOffRecorded = _systemNote[electionId].recorded;
    }

    function certifiedStaffingReady(bytes32 electionId) external view returns (bool) {
        return _certifiedReady(electionId);
    }

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
        )
    {
        SystemNote storage note = _systemNote[electionId];
        Roster storage roster = _rosters[electionId];
        recorded = note.recorded;
        requiredForCertification = roster.known && roster.kind == uint8(Kind.Standard);
        current = _systemSignOffCurrent(electionId);
        signer = note.signer;
        rosterHash = note.rosterHash;
        dutiesHash = note.dutiesHash;
        positionSetHash = note.positionSetHash;
        recordedAt = note.recordedAt;
    }

    function systemSignOffPositions(bytes32 electionId) external view returns (bytes32[] memory positionIds, bytes32[] memory sheetHashes) {
        return (_systemPositions[electionId], _systemSheets[electionId]);
    }

    function systemSignOffSignature(bytes32 electionId) external view returns (bytes memory) {
        return _systemSig[electionId];
    }

    function certificationSigners(bytes32 electionId)
        external
        view
        returns (address adminW, address officerW, address verifierW, bool distinct)
    {
        return _certificationSigners(electionId);
    }

    function isApproved(bytes32 electionId, address wallet) external view returns (bool) {
        return wallet != address(0) && _byWallet[electionId][wallet] != bytes32(0);
    }

    function isApprovedScanner(bytes32 electionId, address wallet) public view returns (bool) {
        if (wallet == address(0)) return false;
        bytes32 pid = _byWallet[electionId][wallet];
        if (pid == bytes32(0)) return false;
        Seat storage row = _seats[electionId][pid];
        return row.role == uint8(Role.Scanner) && !row.coveredByAdmin;
    }

    /// @notice Legacy elections (no roster here) and rosters with no dedicated scanner wallet return true.
    ///         The ballot ledger still requires a registered Device. When a scanner wallet is recorded,
    ///         only those wallets return true.
    function mayRecordBallots(bytes32 electionId, address wallet) external view returns (bool) {
        if (!_rosters[electionId].known) return true;
        bool any = false;
        bytes32[] storage ids = _positions[electionId];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; i++) {
            Seat storage row = _seats[electionId][ids[i]];
            if (row.role == uint8(Role.Scanner) && row.wallet != address(0) && !row.coveredByAdmin) {
                any = true;
                if (row.wallet == wallet) return true;
            }
        }
        return !any;
    }

    function positionCount(bytes32 electionId) external view returns (uint256) {
        return _positions[electionId].length;
    }

    function positionAt(bytes32 electionId, uint256 index)
        external
        view
        returns (
            bytes32 positionId_,
            uint8 role,
            uint16 seatNo,
            address wallet,
            bytes32 nameHash,
            uint64 recordedAt,
            uint64 amendedAt,
            uint32 amendmentCount,
            bool coveredByAdmin,
            uint256 nonce
        )
    {
        bytes32 pid = _positions[electionId][index];
        Seat storage row = _seats[electionId][pid];
        return (pid, row.role, row.seatNo, row.wallet, row.nameHash, row.recordedAt, row.amendedAt, row.amendmentCount, row.coveredByAdmin, row.nonce);
    }

    function lockSignature(bytes32 electionId) external view returns (bytes memory) {
        return _lockSig[electionId];
    }

    function seat(bytes32 electionId, uint8 role, uint16 seatNo)
        external
        view
        returns (address wallet, bytes32 nameHash, uint64 recordedAt, uint64 amendedAt, uint32 amendmentCount, bool coveredByAdmin, bool exists, uint256 nonce)
    {
        Seat storage s = _seats[electionId][positionIdOf(role, seatNo)];
        return (s.wallet, s.nameHash, s.recordedAt, s.amendedAt, s.amendmentCount, s.coveredByAdmin, s.exists, s.nonce);
    }

    // ---------------------------------------------------------------- internals

    function _checkLock(
        bytes32 electionId,
        address organizer,
        bytes32 rosterHash,
        string calldata attestation,
        bytes calldata attestationSig
    ) private view {
        Roster storage roster = _rosters[electionId];
        if (!roster.known) revert AdminNotRecorded();
        if (roster.locked) revert AlreadyLocked();
        if (rosterHash == bytes32(0)) revert EmptyRosterHash();
        if (keccak256(bytes(attestation)) != keccak256(bytes(LOCK_ATTESTATION))) revert BadAttestation();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ROSTER_LOCK_TYPEHASH, electionId, rosterHash, keccak256(bytes(attestation)))));
        if (!_signedBy(digest, attestationSig, organizer)) revert BadRosterSignature();
    }

    function _applyTestSig(bytes32 electionId, address organizer, string calldata testStatement, bytes calldata testSig) private {
        if (testSig.length == 0) return;
        Roster storage roster = _rosters[electionId];
        if (roster.kind != uint8(Kind.Test)) revert NotATestElection();
        if (!roster.testAttested) _acceptTestAttestation(electionId, organizer, testStatement, testSig);
        else if (keccak256(bytes(testStatement)) != keccak256(bytes(TEST_STATEMENT))) revert BadAttestation();
    }

    function _lockStaffing(bytes32 electionId) private view returns (bool incomplete) {
        Roster storage roster = _rosters[electionId];
        incomplete = !_requiredFilled(electionId) || _anyCovered(electionId);
        if (roster.kind == uint8(Kind.Standard)) {
            if (incomplete || _handlerCount(electionId) < MIN_BALLOT_HANDLERS) revert StaffingBlocksLock();
            return false;
        }
        if (incomplete && roster.kind == uint8(Kind.Test) && !roster.testAttested) revert TestAttestationRequired();
        return incomplete;
    }

    function _storeLock(bytes32 electionId, address organizer, bytes32 rosterHash, bytes calldata attestationSig, bool incomplete) private {
        Roster storage roster = _rosters[electionId];
        roster.locked = true;
        roster.lockedRosterHash = rosterHash;
        roster.currentRosterHash = rosterHash;
        roster.lockedAt = uint64(block.timestamp);
        roster.lockSigner = organizer;
        _lockSig[electionId] = attestationSig;
        emit RosterLocked(electionId, rosterHash, organizer, attestationSig, incomplete, roster.testAttested, uint64(block.timestamp));
    }

    /// @notice Organizer pays. An Election officer signs off-chain, for free.
    ///         Print runs and scan batches also name the Scanner operator and carry that operator's signature,
    ///         so the operator is not alone with the paper. Storing the ballots is the officer only.
    ///         Test and classroom elections are not required to call this.
    function recordCustody(
        bytes32 electionId,
        uint8 action,
        bytes32 subjectHash,
        address officer,
        address scanner,
        uint256 nonce,
        bytes calldata officerSig,
        bytes calldata scannerSig
    ) external {
        _requireOrganizer(electionId);
        if (!_rosters[electionId].known) revert AdminNotRecorded();
        if (action != CUSTODY_PRINT_RUN && action != CUSTODY_SCAN_BATCH && action != CUSTODY_BALLOTS_STORED) revert BadCustodyAction();
        if (subjectHash == bytes32(0) || nonce == 0 || officer == address(0)) revert BadPosition();
        if (_custodyNonceUsed[electionId][nonce]) revert NonceUsed();
        if (!_isHandler(electionId, officer)) revert NotAHandler(officer);
        if (action == CUSTODY_BALLOTS_STORED) {
            if (scanner != address(0) || scannerSig.length != 0) revert ScannerNotOnThisStep();
        } else if (!_isScanner(electionId, scanner)) {
            revert NotAScanner(scanner);
        }
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CUSTODY_TYPEHASH, electionId, action, subjectHash, officer, scanner, nonce)));
        if (!_signedBy(digest, officerSig, officer)) revert BadRosterSignature();
        if (action != CUSTODY_BALLOTS_STORED && !_signedBy(digest, scannerSig, scanner)) revert BadRosterSignature();
        _custodyNonceUsed[electionId][nonce] = true;
        _custody[electionId].push(CustodyNote({ action: action, subjectHash: subjectHash, officer: officer, scanner: scanner, witnessedAt: uint64(block.timestamp), nonce: nonce }));
        emit CustodyWitnessed(electionId, action, subjectHash, officer, scanner, uint64(block.timestamp));
    }

    function _recordOne(bytes32 electionId, StaffProof calldata proof) private {
        (address organizer, IElectionRegistry.Status status) = _requireOrganizer(electionId);
        Roster storage roster = _rosters[electionId];
        if (!roster.known) revert AdminNotRecorded();
        if (roster.kind == uint8(Kind.Classroom)) revert ClassroomIsSingleAdmin();
        if (roster.locked) revert RosterIsLocked();
        if (status != IElectionRegistry.Status.Setup) revert WrongStatus(status);
        if (proof.role == uint8(Role.Admin)) revert AdminFixed();
        bytes32 pid = positionIdOf(proof.role, proof.seatNo);
        Seat storage existing = _seats[electionId][pid];
        address oldWallet = existing.wallet;
        bool existed = existing.exists;
        bool wasCovered = existing.coveredByAdmin;
        _acceptStaff(electionId, organizer, pid, proof);
        _writeSeat(electionId, pid, proof.role, proof.seatNo, proof.wallet, proof.nameHash, proof.nonce, false);
        if (existed && (oldWallet != proof.wallet || wasCovered)) {
            emit StaffReplaced(electionId, pid, oldWallet, proof.wallet, uint64(block.timestamp));
        } else {
            emit StaffRecorded(electionId, pid, proof.role, proof.seatNo, proof.wallet, proof.nameHash, uint64(block.timestamp));
        }
    }

    function _acceptStaff(bytes32 electionId, address organizer, bytes32 pid, StaffProof calldata proof) private view {
        if (proof.wallet == address(0) || proof.nameHash == bytes32(0) || proof.nonce == 0) revert BadPosition();
        if (keccak256(bytes(proof.adultAttestation)) != keccak256(bytes(ADULT_ATTESTATION))) revert AdultAttestationRequired();
        Seat storage existing = _seats[electionId][pid];
        if (proof.nonce <= existing.nonce) revert NonceUsed();
        bytes32 claimDigest = _hashTypedDataV4(
            keccak256(abi.encode(STAFF_CLAIM_TYPEHASH, electionId, pid, proof.wallet, proof.nameHash, proof.nonce))
        );
        if (!_signedBy(claimDigest, proof.claimSig, proof.wallet)) revert BadRosterSignature();
        bytes32 approvalDigest = _hashTypedDataV4(
            keccak256(abi.encode(STAFF_APPROVAL_TYPEHASH, electionId, pid, proof.wallet, proof.nameHash, claimDigest, proof.nonce, keccak256(bytes(proof.adultAttestation))))
        );
        if (!_signedBy(approvalDigest, proof.approvalSig, organizer)) revert BadRosterSignature();
        bytes32 held = _byWallet[electionId][proof.wallet];
        if (held != bytes32(0) && held != pid) revert WalletInTwoPositions(proof.wallet, held);
    }

    function _coverPrimary(bytes32 electionId, address admin, uint8 role) private {
        bytes32 pid = positionIdOf(role, 1);
        _writeSeat(electionId, pid, role, 1, address(0), bytes32(0), 0, true);
        emit StaffCovered(electionId, pid, admin, keccak256(bytes(CLASSROOM_LABEL)), uint64(block.timestamp));
    }

    function _writeSeat(
        bytes32 electionId,
        bytes32 pid,
        uint8 role,
        uint16 seatNo,
        address wallet,
        bytes32 nameHash,
        uint256 nonce,
        bool covered
    ) private {
        Seat storage row = _seats[electionId][pid];
        if (row.wallet != address(0) && row.wallet != wallet) _byWallet[electionId][row.wallet] = bytes32(0);
        if (!row.exists) {
            if (_positions[electionId].length >= MAX_POSITIONS) revert TooManyPositions();
            _positions[electionId].push(pid);
            row.exists = true;
            row.role = role;
            row.seatNo = seatNo;
            row.recordedAt = uint64(block.timestamp);
        }
        row.wallet = wallet;
        row.nameHash = nameHash;
        if (nonce != 0) row.nonce = nonce;
        row.coveredByAdmin = covered;
        if (wallet != address(0)) _byWallet[electionId][wallet] = pid;
    }

    function _acceptTestAttestation(bytes32 electionId, address organizer, string calldata statement, bytes calldata signature) private {
        Roster storage roster = _rosters[electionId];
        if (!roster.known) revert AdminNotRecorded();
        if (roster.kind != uint8(Kind.Test)) revert NotATestElection();
        if (roster.testAttested) revert AlreadyAttested();
        if (keccak256(bytes(statement)) != keccak256(bytes(TEST_STATEMENT))) revert BadAttestation();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(TEST_ATTESTATION_TYPEHASH, electionId, keccak256(bytes(statement))))
        );
        if (!_signedBy(digest, signature, organizer)) revert BadRosterSignature();
        roster.testAttested = true;
        emit TestElectionAttested(electionId, organizer, keccak256(bytes(statement)), uint64(block.timestamp));
    }

    function _requireOrganizer(bytes32 electionId) private view returns (address organizer, IElectionRegistry.Status status) {
        (organizer, status, , , , , , ) = registry.elections(electionId);
        if (status == IElectionRegistry.Status.None) revert UnknownElection();
        if (msg.sender != organizer) revert NotOrganizer();
    }

    function custodyCount(bytes32 electionId) external view returns (uint256) {
        return _custody[electionId].length;
    }

    function custodyAt(bytes32 electionId, uint256 index) external view returns (uint8 action, bytes32 subjectHash, address officer, address scanner, uint64 witnessedAt, uint256 nonce) {
        CustodyNote storage note = _custody[electionId][index];
        return (note.action, note.subjectHash, note.officer, note.scanner, note.witnessedAt, note.nonce);
    }

    function _filled(bytes32 electionId, uint8 role, uint16 seatNo) private view returns (bool) {
        Seat storage row = _seats[electionId][positionIdOf(role, seatNo)];
        return row.exists && row.wallet != address(0) && !row.coveredByAdmin;
    }

    function _requiredFilled(bytes32 electionId) private view returns (bool) {
        return _filled(electionId, uint8(Role.Admin), 1) &&
            _filled(electionId, uint8(Role.Officer), 1) &&
            _filled(electionId, uint8(Role.Verifier), 1) &&
            _filled(electionId, uint8(Role.Scanner), 1) &&
            _filled(electionId, uint8(Role.System), 1);
    }

    function _anyCovered(bytes32 electionId) private view returns (bool) {
        bytes32[] storage ids = _positions[electionId];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; i++) if (_seats[electionId][ids[i]].coveredByAdmin) return true;
        return false;
    }

    function _walletCount(bytes32 electionId) private view returns (uint256 count) {
        bytes32[] storage ids = _positions[electionId];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; i++) if (_seats[electionId][ids[i]].wallet != address(0)) count += 1;
    }

    function _certificationSigners(bytes32 electionId)
        private
        view
        returns (address adminW, address officerW, address verifierW, bool distinct)
    {
        adminW = _seats[electionId][positionIdOf(uint8(Role.Admin), 1)].wallet;
        officerW = _seats[electionId][positionIdOf(uint8(Role.Officer), 1)].wallet;
        verifierW = _seats[electionId][positionIdOf(uint8(Role.Verifier), 1)].wallet;
        distinct = adminW != address(0) && adminW != officerW && adminW != verifierW && officerW != address(0) && officerW != verifierW;
    }

    function _certifiedReady(bytes32 electionId) private view returns (bool) {
        Roster storage roster = _rosters[electionId];
        if (!roster.known || !roster.locked || roster.kind != uint8(Kind.Standard) || roster.testAttested) return false;
        if (!_requiredFilled(electionId) || _anyCovered(electionId) || _handlerCount(electionId) < MIN_BALLOT_HANDLERS) return false;
        (, , , bool distinct) = _certificationSigners(electionId);
        return distinct && _systemSignOffCurrent(electionId);
    }

    function _readElection(bytes32 electionId)
        private
        view
        returns (address organizer, IElectionRegistry.Status status, bool exists)
    {
        (organizer, status, , , , , , ) = registry.elections(electionId);
        if (status == IElectionRegistry.Status.None) revert UnknownElection();
        exists = true;
    }

    function _systemWallet(bytes32 electionId) private view returns (address) {
        Seat storage row = _seats[electionId][positionIdOf(uint8(Role.System), 1)];
        if (!row.exists || row.coveredByAdmin || row.wallet == address(0)) return address(0);
        return row.wallet;
    }

    function _filledPositionIds(bytes32 electionId) private view returns (bytes32[] memory ids) {
        bytes32[] storage all = _positions[electionId];
        uint256 n = all.length;
        uint256 count = 0;
        for (uint256 i = 0; i < n; i++) {
            Seat storage row = _seats[electionId][all[i]];
            if (row.wallet != address(0) && !row.coveredByAdmin) count += 1;
        }
        ids = new bytes32[](count);
        uint256 w = 0;
        for (uint256 i = 0; i < n; i++) {
            Seat storage row = _seats[electionId][all[i]];
            if (row.wallet != address(0) && !row.coveredByAdmin) {
                ids[w] = all[i];
                w += 1;
            }
        }
    }

    function _checkSignOffSet(bytes32 electionId, bytes32[] calldata positionIds, bytes32[] calldata sheetHashes) private view {
        uint256 n = positionIds.length;
        if (n == 0 || n != sheetHashes.length || n > MAX_POSITIONS) revert SignOffIncomplete();
        bytes32[] memory filled = _filledPositionIds(electionId);
        if (filled.length != n) revert SignOffIncomplete();
        for (uint256 i = 0; i < n; i++) {
            if (positionIds[i] == bytes32(0) || sheetHashes[i] == bytes32(0)) revert SignOffIncomplete();
            for (uint256 j = 0; j < i; j++) if (positionIds[j] == positionIds[i]) revert SignOffIncomplete();
            bool found = false;
            for (uint256 k = 0; k < filled.length; k++) if (filled[k] == positionIds[i]) found = true;
            if (!found) revert SignOffIncomplete();
        }
    }

    function _systemSignOffCurrent(bytes32 electionId) private view returns (bool) {
        SystemNote storage note = _systemNote[electionId];
        if (!note.recorded || note.rosterHash != _rosters[electionId].currentRosterHash) return false;
        if (note.signer == address(0) || note.signer != _systemWallet(electionId)) return false;
        bytes32[] memory filled = _filledPositionIds(electionId);
        uint256 n = filled.length;
        if (n != _systemPositions[electionId].length) return false;
        for (uint256 i = 0; i < n; i++) {
            bool found = false;
            for (uint256 j = 0; j < n; j++) if (_systemPositions[electionId][j] == filled[i]) found = true;
            if (!found) return false;
        }
        return true;
    }

    /// Election officers with their own wallet. Covered lines and every other role are not handlers.
    function _handlerCount(bytes32 electionId) private view returns (uint256 count) {
        bytes32[] storage ids = _positions[electionId];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; i++) {
            Seat storage row = _seats[electionId][ids[i]];
            if (row.role == uint8(Role.Officer) && row.wallet != address(0) && !row.coveredByAdmin) count += 1;
        }
    }

    function _isHandler(bytes32 electionId, address wallet) private view returns (bool) {
        return _holdsRole(electionId, wallet, uint8(Role.Officer));
    }

    function _isScanner(bytes32 electionId, address wallet) private view returns (bool) {
        return _holdsRole(electionId, wallet, uint8(Role.Scanner));
    }

    function _holdsRole(bytes32 electionId, address wallet, uint8 role) private view returns (bool) {
        bytes32 pid = _byWallet[electionId][wallet];
        if (pid == bytes32(0)) return false;
        Seat storage row = _seats[electionId][pid];
        return row.role == role && row.wallet == wallet && !row.coveredByAdmin;
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || recovered == address(0)) revert BadRosterSignature();
        return recovered;
    }

    function _signedBy(bytes32 digest, bytes calldata sig, address expected) private pure returns (bool) {
        if (expected == address(0)) return false;
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError && recovered == expected;
    }
}
