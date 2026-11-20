// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IElectionRegistry} from "./interfaces/IElectionRegistry.sol";

/// @title ElectionRegistry
/// @notice Registry entry, version history, roles and status of each election (design spec 10.1).
/// @dev NOT AUDITED. Elections are keyed by keccak256(bytes(electionCode)), the value
///      the core library computes as `electionKey()`.
///
///      Status flow: None -> Setup -> Open -> Closed -> Tallied.
///      The organizer is the address that called `createElection`. Devices and reviewers are registered per election
///      during Setup only.
///
///      [PROPOSED] choices where the spec is silent:
///        * `CLOSE_GRACE` = 1 day: anyone may close an Open election once `closesAt + CLOSE_GRACE` has passed.
///        * `setLedger` / `setTally` wire the sibling contracts exactly once, by the deploying address (the spec says
///          "set once" but not who sets them).
///        * The election code format is checked on-chain (`BEINGS-YYYY-XXXXXX`, Crockford base-32 suffix).
///        * A device or reviewer address can hold only one role in an election, and only once.
contract ElectionRegistry is IElectionRegistry {
    /// Grace period after `closesAt` before anyone may close the election.
    uint64 public constant CLOSE_GRACE = 1 days;

    /// Address allowed to wire `ledger` and `tally` (once each).
    address public immutable deployer;
    /// BallotLedger, set once.
    address public ledger;
    /// Tally, set once.
    address public tally;

    mapping(bytes32 => Election) public override elections;
    mapping(bytes32 => Version[]) private _versions;
    mapping(bytes32 => mapping(address => Role)) public override roles;
    mapping(bytes32 => uint8) public override deviceCount;
    /// Set at creation. The original `createElection` leaves this false, so elections created that way keep the old rules.
    mapping(bytes32 => bool) public override poolEnforced;
    /// Merkle roots appended by `addBallots`, in order. The creation root stays in `elections[key].ballotListRoot` (index 0).
    mapping(bytes32 => bytes32[]) private _addedRoots;

    event LedgerSet(address indexed ledger);
    event TallySet(address indexed tally);

    error NotDeployer();
    error AlreadySet();
    error ZeroAddress();
    error NotOrganizer();
    error NotTally();
    error ElectionExists();
    error UnknownElection();
    error BadElectionCode();
    error BadParameters();
    error WrongStatus(Status current);
    error RoleTaken();
    error NotEnoughDevices(uint8 have, uint8 need);
    error TooEarly(uint64 opensAt);
    error CloseNotAllowed();
    error BallotsLocked(uint64 opensAt);
    error PoolNotEnforced();
    error DuplicateBallotRoot();
    error BallotCountOverflow();
    error UnknownBallotRoot(uint256 rootIndex);
    error BallotNotInPool(bytes32 ballotKey);

    constructor() {
        deployer = msg.sender;
    }

    // ---------------------------------------------------------------- wiring

    function setLedger(address ledger_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (ledger != address(0)) revert AlreadySet();
        if (ledger_ == address(0)) revert ZeroAddress();
        ledger = ledger_;
        emit LedgerSet(ledger_);
    }

    function setTally(address tally_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (tally != address(0)) revert AlreadySet();
        if (tally_ == address(0)) revert ZeroAddress();
        tally = tally_;
        emit TallySet(tally_);
    }

    // ---------------------------------------------------------------- setup

    /// @notice Anyone. The caller becomes the organizer. The election code must be unused.
    ///         Ballot-pool checks stay off: this is the path existing elections and old callers use.
    function createElection(
        string calldata electionCode,
        string calldata cid,
        bytes32 fileSha256,
        uint32 ballotCount,
        uint32 registeredVoters,
        uint8 quorum,
        uint64 opensAt,
        uint64 closesAt,
        bytes32 ballotListRoot
    ) external {
        _create(electionCode, cid, fileSha256, ballotCount, registeredVoters, quorum, opensAt, closesAt, ballotListRoot, false);
    }

    /// @notice Same arguments as `createElection`. The ballot-pool flag is on. New elections use this.
    ///         A pooled election must register a non-zero ballot-list root. Plain codes are never stored.
    function createPooledElection(
        string calldata electionCode,
        string calldata cid,
        bytes32 fileSha256,
        uint32 ballotCount,
        uint32 registeredVoters,
        uint8 quorum,
        uint64 opensAt,
        uint64 closesAt,
        bytes32 ballotListRoot
    ) external {
        if (ballotListRoot == bytes32(0)) revert BadParameters();
        _create(electionCode, cid, fileSha256, ballotCount, registeredVoters, quorum, opensAt, closesAt, ballotListRoot, true);
    }

    /// @notice Organizer only. Adds a Merkle root of newly verified ballots and raises the authorized count.
    ///         Allowed only during Setup and strictly before `opensAt`. Unissued extras are not added here.
    function addBallots(bytes32 electionId, bytes32 root, uint32 count) external {
        _requireOrganizer(electionId);
        if (!poolEnforced[electionId]) revert PoolNotEnforced();
        Election storage e = elections[electionId];
        if (e.status != Status.Setup) revert WrongStatus(e.status);
        if (block.timestamp >= e.opensAt) revert BallotsLocked(e.opensAt);
        if (root == bytes32(0) || count == 0) revert BadParameters();
        if (root == e.ballotListRoot) revert DuplicateBallotRoot();
        bytes32[] storage added = _addedRoots[electionId];
        uint256 n = added.length;
        for (uint256 i = 0; i < n; i++) {
            if (added[i] == root) revert DuplicateBallotRoot();
        }
        uint256 next = uint256(e.ballotCount) + uint256(count);
        if (next > type(uint32).max) revert BallotCountOverflow();
        added.push(root);
        e.ballotCount = uint32(next);
        emit BallotsAdded(electionId, root, count, uint32(next));
    }

    /// @notice Organizer only. Records that a damaged pooled ballot was reprinted with its own code.
    ///         The note names the ballot by `ballotKey` and a hash of the off-chain reason. It does not record a vote.
    function noteReprint(
        bytes32 electionId,
        bytes32 ballotKey,
        bytes32 reasonHash,
        bytes32[] calldata proof,
        uint256 rootIndex
    ) external {
        _requireOrganizer(electionId);
        if (!poolEnforced[electionId]) revert PoolNotEnforced();
        if (reasonHash == bytes32(0) || ballotKey == bytes32(0)) revert BadParameters();
        if (!ballotListedIn(electionId, ballotKey, proof, rootIndex)) revert BallotNotInPool(ballotKey);
        emit ReprintNoted(electionId, ballotKey, reasonHash, msg.sender);
    }

    /// @notice Organizer, Setup only. Appends a new election-file version; earlier versions stay readable.
    function postVersion(bytes32 key, string calldata cid, bytes32 fileSha256) external {
        _requireOrganizer(key);
        _requireStatus(key, Status.Setup);
        if (fileSha256 == bytes32(0) || bytes(cid).length == 0) revert BadParameters();
        uint256 index = _versions[key].length;
        _versions[key].push(Version({cid: cid, fileSha256: fileSha256, postedAt: uint64(block.timestamp)}));
        emit VersionPosted(key, index, cid, fileSha256);
    }

    /// @notice Organizer, Setup only. `appHash` is the approved scanning-app hash this device runs (spec 9.5).
    function registerDevice(bytes32 key, address device, bytes32 appHash) external {
        _requireOrganizer(key);
        _requireStatus(key, Status.Setup);
        if (device == address(0)) revert ZeroAddress();
        if (roles[key][device] != Role.None) revert RoleTaken();
        roles[key][device] = Role.Device;
        deviceCount[key] += 1; // reverts on overflow past 255
        emit DeviceRegistered(key, device, appHash);
    }

    /// @notice Organizer, Setup only.
    function registerReviewer(bytes32 key, address reviewer) external {
        _requireOrganizer(key);
        _requireStatus(key, Status.Setup);
        if (reviewer == address(0)) revert ZeroAddress();
        if (roles[key][reviewer] != Role.None) revert RoleTaken();
        roles[key][reviewer] = Role.Reviewer;
        emit ReviewerRegistered(key, reviewer);
    }

    // ---------------------------------------------------------------- status

    /// @notice Organizer. Needs deviceCount >= quorum and now >= opensAt.
    function openElection(bytes32 key) external {
        _requireOrganizer(key);
        _requireStatus(key, Status.Setup);
        Election storage e = elections[key];
        if (deviceCount[key] < e.quorum) revert NotEnoughDevices(deviceCount[key], e.quorum);
        if (block.timestamp < e.opensAt) revert TooEarly(e.opensAt);
        e.status = Status.Open;
        emit StatusChanged(key, Status.Setup, Status.Open);
    }

    /// @notice Organizer, or anyone after `closesAt + CLOSE_GRACE`.
    function closeElection(bytes32 key) external {
        Election storage e = elections[key];
        if (e.status == Status.None) revert UnknownElection();
        if (e.status != Status.Open) revert WrongStatus(e.status);
        if (msg.sender != e.organizer && block.timestamp <= uint256(e.closesAt) + CLOSE_GRACE) revert CloseNotAllowed();
        e.status = Status.Closed;
        emit StatusChanged(key, Status.Open, Status.Closed);
    }

    /// @notice Tally contract only; election must be Closed.
    function markTallied(bytes32 key) external {
        if (msg.sender != tally || tally == address(0)) revert NotTally();
        _requireStatus(key, Status.Closed);
        elections[key].status = Status.Tallied;
        emit StatusChanged(key, Status.Closed, Status.Tallied);
    }

    /// @notice Organizer, once the election is Closed or Tallied. A public notice only; changes nothing else.
    function noticeImagesRetired(bytes32 key, string calldata noteCid) external {
        _requireOrganizer(key);
        Status s = elections[key].status;
        if (s != Status.Closed && s != Status.Tallied) revert WrongStatus(s);
        emit ImagesRetired(key, uint64(block.timestamp), noteCid);
    }

    // ---------------------------------------------------------------- views

    function latestVersion(bytes32 key) external view returns (Version memory) {
        Version[] storage v = _versions[key];
        if (v.length == 0) revert UnknownElection();
        return v[v.length - 1];
    }

    function versionCount(bytes32 key) external view returns (uint256) {
        return _versions[key].length;
    }

    /// @notice Version by 0-based index (matches the `index` in `VersionPosted`).
    function getVersion(bytes32 key, uint256 index) external view returns (Version memory) {
        return _versions[key][index];
    }

    /// @notice True iff `ballotKey` is in the election's `ballotListRoot` (OpenZeppelin sorted-pair proof).
    ///         A zero root (no list registered) never matches. Added roots are checked with `ballotListedIn`.
    function ballotListed(bytes32 key, bytes32 ballotKey, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = elections[key].ballotListRoot;
        if (root == bytes32(0)) return false;
        return MerkleProof.verifyCalldata(proof, root, ballotKey);
    }

    function ballotRootCount(bytes32 key) external view returns (uint256) {
        if (elections[key].status == Status.None) return 0;
        return 1 + _addedRoots[key].length;
    }

    function ballotRootAt(bytes32 key, uint256 index) external view returns (bytes32) {
        if (elections[key].status == Status.None) revert UnknownElection();
        if (index == 0) return elections[key].ballotListRoot;
        uint256 added = _addedRoots[key].length;
        if (index > added) revert UnknownBallotRoot(index);
        return _addedRoots[key][index - 1];
    }

    /// @notice True iff `ballotKey` sits in approved root `rootIndex`. Index 0 is the creation root.
    function ballotListedIn(bytes32 key, bytes32 ballotKey, bytes32[] calldata proof, uint256 rootIndex) public view returns (bool) {
        if (elections[key].status == Status.None) return false;
        uint256 count = 1 + _addedRoots[key].length;
        if (rootIndex >= count) return false;
        bytes32 root = rootIndex == 0 ? elections[key].ballotListRoot : _addedRoots[key][rootIndex - 1];
        if (root == bytes32(0)) return false;
        return MerkleProof.verifyCalldata(proof, root, ballotKey);
    }

    // ---------------------------------------------------------------- internals

    function _requireOrganizer(bytes32 key) private view {
        Election storage e = elections[key];
        if (e.status == Status.None) revert UnknownElection();
        if (msg.sender != e.organizer) revert NotOrganizer();
    }

    function _create(
        string calldata electionCode,
        string calldata cid,
        bytes32 fileSha256,
        uint32 ballotCount,
        uint32 registeredVoters,
        uint8 quorum,
        uint64 opensAt,
        uint64 closesAt,
        bytes32 ballotListRoot,
        bool poolEnforced_
    ) private {
        if (!_isElectionCode(bytes(electionCode))) revert BadElectionCode();
        bytes32 key = keccak256(bytes(electionCode));
        if (elections[key].status != Status.None) revert ElectionExists();
        if (ballotCount == 0 || quorum == 0 || closesAt <= opensAt || fileSha256 == bytes32(0) || bytes(cid).length == 0) {
            revert BadParameters();
        }

        elections[key] = Election({
            organizer: msg.sender,
            status: Status.Setup,
            ballotCount: ballotCount,
            registeredVoters: registeredVoters,
            quorum: quorum,
            opensAt: opensAt,
            closesAt: closesAt,
            ballotListRoot: ballotListRoot
        });
        poolEnforced[key] = poolEnforced_;
        _versions[key].push(Version({cid: cid, fileSha256: fileSha256, postedAt: uint64(block.timestamp)}));

        emit ElectionCreated(key, electionCode, msg.sender);
        emit VersionPosted(key, 0, cid, fileSha256);
        emit StatusChanged(key, Status.None, Status.Setup);
    }

    function _requireStatus(bytes32 key, Status want) private view {
        Status s = elections[key].status;
        if (s == Status.None) revert UnknownElection();
        if (s != want) revert WrongStatus(s);
    }

    /// `BEINGS-YYYY-XXXXXX`: 18 bytes, 4 digits, 6 Crockford base-32 characters (no I, L, O, U).
    function _isElectionCode(bytes calldata c) private pure returns (bool) {
        if (c.length != 18) return false;
        bytes memory prefix = "BEINGS-";
        for (uint256 i = 0; i < 7; i++) if (c[i] != prefix[i]) return false;
        for (uint256 i = 7; i < 11; i++) if (c[i] < 0x30 || c[i] > 0x39) return false;
        if (c[11] != 0x2D) return false; // "-"
        for (uint256 i = 12; i < 18; i++) if (!_isCrockford(c[i])) return false;
        return true;
    }

    function _isCrockford(bytes1 b) private pure returns (bool) {
        if (b >= 0x30 && b <= 0x39) return true; // 0-9
        if (b < 0x41 || b > 0x5A) return false; // A-Z only
        return b != 0x49 && b != 0x4C && b != 0x4F && b != 0x55; // not I L O U
    }
}
