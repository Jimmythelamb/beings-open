// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IElectionRegistry} from "./interfaces/IElectionRegistry.sol";
import {ITally} from "./interfaces/ITally.sol";

/// Minimal view of the deployed ElectionRegistry's public wiring getter (not part of IElectionRegistry).
interface IRegistryWiring {
    function tally() external view returns (address);
}

/// @title ElectionNotes
/// @notice Append-only public notes about a tallied election: an official's signed explanation (for example of a
///         failed reconciliation check) or the fingerprint of the election's long-term public record bundle.
///         Each note stores the SHA-256 of an off-chain file, a pointer to where that file is kept, the author's wallet,
///         the author's role as read from the ElectionRegistry at the time of posting, and an optional display name.
/// @dev NOT AUDITED. Design draft "long-term public election record", 10 Nov 2026, section 7.2 (Option B).
///      * Reads roles from the existing ElectionRegistry; changes nothing in ElectionRegistry, BallotLedger, Tally or
///        VerifierRegistry. Posting a note can never change counts, failed checks or Final / Provisional.
///      * No owner, no admin, no pause, no delete, no edit, no upgrade path. A correction is a new note.
///      * Who may post: the election's organizer, or an address the organizer registered during Setup as a Device
///        (scanning staff) or Reviewer. Election must be Tallied (the last status) and `tallyVersion` must be an
///        existing tally version (1 .. Tally.resultCount).
///      * The same `noteSha256` can be posted only once per election (any author), so a note can't be double-counted.
///      * `displayName` is optional, at most 64 bytes, and PERMANENT once posted: the chain cannot forget it
///        (it is written to the event log, which every node keeps).
///      * Storage keeps author, role, tally version, time and hash (so a page can check a note with one call);
///        `cid` and `displayName` live in the `NotePosted` event.
///      * The off-chain file's own EIP-712 signature (schema `beings-election-note/1`) is checked by readers, not here:
///        the transaction itself already proves which wallet posted the fingerprint.
contract ElectionNotes {
    /// Role of the author, read from the registry when the note is posted.
    enum AuthorRole { None, Organizer, Device, Reviewer }

    /// Stored per note (two storage slots). The pointer (`cid`) and the optional display name are kept in the
    /// `NotePosted` event log only: event logs are just as permanent as storage, and far cheaper.
    struct Note {
        address author;
        AuthorRole role;
        uint32 tallyVersion;
        uint40 postedAt;
        bytes32 noteSha256;
    }

    uint256 public constant MAX_DISPLAY_NAME_BYTES = 64;
    uint256 public constant MAX_CID_BYTES = 256;

    IElectionRegistry public immutable registry;
    ITally public immutable tally;

    mapping(bytes32 => Note[]) private _notes;
    /// electionKey => noteSha256 => 1-based index into `_notes[electionKey]` (0 = not posted).
    mapping(bytes32 => mapping(bytes32 => uint256)) public noteIndexPlusOne;

    event NotePosted(
        bytes32 indexed electionKey,
        address indexed author,
        AuthorRole role,
        uint32 tallyVersion,
        bytes32 noteSha256,
        string cid,
        string displayName,
        uint64 timestamp
    );

    error ZeroAddress();
    error UnknownElection();
    error NotTallied(IElectionRegistry.Status current);
    error NotAuthorized();
    error BadTallyVersion(uint32 tallyVersion, uint256 latest);
    error EmptyNoteHash();
    error EmptyCid();
    error CidTooLong(uint256 length);
    error DisplayNameTooLong(uint256 length);
    error DuplicateNote(uint256 index);

    /// @param registry_ the deployed ElectionRegistry. The Tally address is read from it, so the two can't disagree.
    constructor(address registry_) {
        if (registry_ == address(0)) revert ZeroAddress();
        address tally_ = IRegistryWiring(registry_).tally();
        if (tally_ == address(0)) revert ZeroAddress();
        registry = IElectionRegistry(registry_);
        tally = ITally(tally_);
    }

    /// @notice Post a note without a display name (the default; recommended).
    function postNote(bytes32 electionKey, uint32 tallyVersion, bytes32 noteSha256, string calldata cid) external {
        _post(electionKey, tallyVersion, noteSha256, cid, "");
    }

    /// @notice Post a note with an opt-in display name (max 64 bytes). The name is public and permanent.
    function postNoteWithName(
        bytes32 electionKey,
        uint32 tallyVersion,
        bytes32 noteSha256,
        string calldata cid,
        string calldata displayName
    ) external {
        _post(electionKey, tallyVersion, noteSha256, cid, displayName);
    }

    // ---------------------------------------------------------------- views

    /// @notice The role `who` would post with right now (None = may not post).
    function roleOf(bytes32 electionKey, address who) public view returns (AuthorRole) {
        (address organizer, IElectionRegistry.Status status,,,,,,) = registry.elections(electionKey);
        if (status == IElectionRegistry.Status.None) return AuthorRole.None;
        if (who == organizer) return AuthorRole.Organizer;
        IElectionRegistry.Role r = registry.roles(electionKey, who);
        if (r == IElectionRegistry.Role.Device) return AuthorRole.Device;
        if (r == IElectionRegistry.Role.Reviewer) return AuthorRole.Reviewer;
        return AuthorRole.None;
    }

    function noteCount(bytes32 electionKey) external view returns (uint256) {
        return _notes[electionKey].length;
    }

    /// @notice Note by 0-based index (posting order). `cid` and `displayName` are in the matching NotePosted event.
    function getNote(bytes32 electionKey, uint256 index) external view returns (Note memory) {
        return _notes[electionKey][index];
    }

    // ---------------------------------------------------------------- internals

    function _post(bytes32 electionKey, uint32 tallyVersion, bytes32 noteSha256, string calldata cid, string memory displayName) private {
        (, IElectionRegistry.Status status,,,,,,) = registry.elections(electionKey);
        if (status == IElectionRegistry.Status.None) revert UnknownElection();
        if (status != IElectionRegistry.Status.Tallied) revert NotTallied(status);
        AuthorRole role = roleOf(electionKey, msg.sender);
        if (role == AuthorRole.None) revert NotAuthorized();
        uint256 latest = tally.resultCount(electionKey);
        if (tallyVersion == 0 || tallyVersion > latest) revert BadTallyVersion(tallyVersion, latest);
        if (noteSha256 == bytes32(0)) revert EmptyNoteHash();
        uint256 cidLen = bytes(cid).length;
        if (cidLen == 0) revert EmptyCid();
        if (cidLen > MAX_CID_BYTES) revert CidTooLong(cidLen);
        uint256 nameLen = bytes(displayName).length;
        if (nameLen > MAX_DISPLAY_NAME_BYTES) revert DisplayNameTooLong(nameLen);
        uint256 existing = noteIndexPlusOne[electionKey][noteSha256];
        if (existing != 0) revert DuplicateNote(existing - 1);

        Note[] storage list = _notes[electionKey];
        list.push(
            Note({
                author: msg.sender,
                role: role,
                tallyVersion: tallyVersion,
                postedAt: uint40(block.timestamp),
                noteSha256: noteSha256
            })
        );
        noteIndexPlusOne[electionKey][noteSha256] = list.length;
        emit NotePosted(electionKey, msg.sender, role, tallyVersion, noteSha256, cid, displayName, uint64(block.timestamp));
    }
}
