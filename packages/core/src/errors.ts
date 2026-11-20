/** Error codes thrown by @beings/core. The library fails closed: it throws, it never "repairs". */
export type BeingsErrorCode =
  | "INVALID_JSON"
  | "NON_CANONICAL"
  | "SCHEMA_MISMATCH"
  | "SCHEMA_VERSION"
  | "BAD_HEX"
  | "BAD_CODE"
  | "BAD_RESULT"
  | "BAD_INPUT"
  | "BAD_SIGNATURE"
  | "BAD_CORRECTION"
  | "MERKLE";

export class BeingsError extends Error {
  readonly code: BeingsErrorCode;
  constructor(code: BeingsErrorCode, message: string) {
    super(message);
    this.name = "BeingsError";
    this.code = code;
  }
}

export interface SchemaIssue {
  path: string;
  message: string;
  keyword: string;
}

export class SchemaValidationError extends BeingsError {
  readonly schemaName: string;
  readonly issues: SchemaIssue[];
  constructor(schemaName: string, issues: SchemaIssue[], code: BeingsErrorCode = "SCHEMA_MISMATCH") {
    const first = issues[0];
    super(
      code,
      `${schemaName}: ${issues.length} schema issue(s)` +
        (first ? `; first: ${first.path || "/"} ${first.message}` : ""),
    );
    this.name = "SchemaValidationError";
    this.schemaName = schemaName;
    this.issues = issues;
  }
}
