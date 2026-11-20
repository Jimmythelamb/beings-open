// Resolves the package name @beings/core for site tests inside the monorepo.
// These are the real modules. The schema validator (ajv) is not loaded.
export { ballotKey, electionKey } from "../../../../packages/core/src/codes.js";
export { keccakHex, sha256Hex } from "../../../../packages/core/src/hash.js";
