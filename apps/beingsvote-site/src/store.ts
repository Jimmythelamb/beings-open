// The small slice of the Netlify Blobs store API this site uses. The real store is wrapped by netlifyStore.ts;
// tests use an in-memory implementation (test/mockStore.ts).

export interface ImageMetadata {
  electionCode: string;
  /** keccak256 of the ballot code (the on-chain ballotKey). The raw ballot code is never stored. */
  ballotCodeHash: string;
  contentType: string;
  /** Byte length of the image. */
  size: number;
  uploadedAt: string;
  deleteAfter: string;
  [k: string]: string | number;
}

export interface BlobStore {
  /** Returns modified:false (and writes nothing) when onlyIfNew is set and the key exists. */
  set(key: string, data: Uint8Array, options: { metadata: ImageMetadata; onlyIfNew?: boolean }): Promise<{ modified: boolean }>;
  get(key: string): Promise<{ data: Uint8Array; metadata: Record<string, unknown> } | null>;
  getMetadata(key: string): Promise<{ metadata: Record<string, unknown> } | null>;
  delete(key: string): Promise<void>;
  /** All keys in the store (paged internally), optionally only those starting with `prefix`. */
  listKeys(prefix?: string): AsyncIterable<string>;
}
