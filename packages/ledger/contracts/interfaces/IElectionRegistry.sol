// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IElectionRegistry
/// @notice Registry entry, version history, roles and status of an election (design spec 10.1).
/// @dev INTERFACE ONLY. Taken from the design spec's sketch; not implemented, not audited.
///      `key` everywhere is keccak256(bytes(electionCode)) (spec 9.7), which the core package (beings-core) `electionKey()` computes.
interface IElectionRegistry {
    enum Status { None, Setup, Open, Closed, Tallied }
    enum Role { None, Device, Reviewer }

    struct Version {
        string cid;
        bytes32 fileSha256;
        uint64 postedAt;
    }

    struct Election {
        address organizer;
        Status status;
        uint32 ballotCount;       // printed ballots incl. spares; hard cap
        uint32 registeredVoters;  // count only, no identities; 0 = no register used
        uint8 quorum;             // min matching device signatures per record
        uint64 opensAt;
        uint64 closesAt;
        bytes32 ballotListRoot;   // Merkle root of ballot keys (see the core package (beings-core) ballotListRoot)
    }

    event ElectionCreated(bytes32 indexed key, string electionCode, address indexed organizer);
    event VersionPosted(bytes32 indexed key, uint256 index, string cid, bytes32 fileSha256);
    event DeviceRegistered(bytes32 indexed key, address indexed device, bytes32 appHash);
    event ReviewerRegistered(bytes32 indexed key, address indexed reviewer);
    event StatusChanged(bytes32 indexed key, Status from, Status to);
    event ImagesRetired(bytes32 indexed key, uint64 at, string noteCid);
    /// Extra ballots approved before opening. `root` is a Merkle root of keccak256(code); the codes themselves are not logged.
    event BallotsAdded(bytes32 indexed electionId, bytes32 root, uint32 addedCount, uint32 newBallotCount);
    /// A damaged ballot reprinted with its own code. `ballotKey` is keccak256(code); `reasonHash` is the hash of an off-chain note.
    event ReprintNoted(bytes32 indexed electionId, bytes32 indexed ballotKey, bytes32 reasonHash, address indexed by);

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
    ) external;

    /// Same arguments as `createElection`, and the ballot-pool flag is on. This is the path for new elections.
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
    ) external;

    /// Organizer only, and only while `block.timestamp < opensAt`. Appends one Merkle root and adds `count` to `ballotCount`.
    function addBallots(bytes32 electionId, bytes32 root, uint32 count) external;

    /// Organizer only. Logs a reprint of a pooled ballot. Does not record a vote and does not change counts.
    function noteReprint(bytes32 electionId, bytes32 ballotKey, bytes32 reasonHash, bytes32[] calldata proof, uint256 rootIndex) external;

    function postVersion(bytes32 key, string calldata cid, bytes32 fileSha256) external;
    function registerDevice(bytes32 key, address device, bytes32 appHash) external;
    function registerReviewer(bytes32 key, address reviewer) external;
    function openElection(bytes32 key) external;
    function closeElection(bytes32 key) external;
    function markTallied(bytes32 key) external;
    function noticeImagesRetired(bytes32 key, string calldata noteCid) external;

    function elections(bytes32 key)
        external
        view
        returns (
            address organizer,
            Status status,
            uint32 ballotCount,
            uint32 registeredVoters,
            uint8 quorum,
            uint64 opensAt,
            uint64 closesAt,
            bytes32 ballotListRoot
        );
    function roles(bytes32 key, address who) external view returns (Role);
    function deviceCount(bytes32 key) external view returns (uint8);
    function latestVersion(bytes32 key) external view returns (Version memory);
    function versionCount(bytes32 key) external view returns (uint256);

    /// True only for elections created with the pool flag. Elections created by the original `createElection` stay false.
    function poolEnforced(bytes32 key) external view returns (bool);
    /// 0 when the election does not exist. Otherwise 1 (the creation root) plus one per `addBallots` call.
    function ballotRootCount(bytes32 key) external view returns (uint256);
    /// Index 0 is `ballotListRoot`. Later indexes are roots appended by `addBallots`.
    function ballotRootAt(bytes32 key, uint256 index) external view returns (bytes32);
    /// True iff `ballotKey` is in the named approved root (OpenZeppelin sorted-pair proof).
    function ballotListedIn(bytes32 key, bytes32 ballotKey, bytes32[] calldata proof, uint256 rootIndex) external view returns (bool);
}
