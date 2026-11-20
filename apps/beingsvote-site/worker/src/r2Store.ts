// R2 adapter for the existing BlobStore. Keys stay `<electionCode>/<sha256>`.
// Create is conditional (If-None-Match semantics). Bytes that do not hash to the key are refused.
import { ELECTION_CODE_RE, SHA256_HEX_RE, isElectionCode, sha256Hex } from "../../src/codes.js";
import type { BlobStore, ImageMetadata } from "../../src/store.js";

const KEY_RE = new RegExp(`^(${ELECTION_CODE_RE.source.slice(1, -1)})/(${SHA256_HEX_RE.source.slice(1, -1)})$`);

export function isImageKey(key: string): boolean {
  return KEY_RE.test(key);
}

function parts(key: string): { electionCode: string; imageSha256: string } {
  const match = KEY_RE.exec(key);
  if (!match?.[1] || !match[2]) throw new Error("refusing a key that is not electionCode/sha256");
  return { electionCode: match[1], imageSha256: match[2] };
}

function metaValue(custom: Record<string, string> | undefined, name: string): string | undefined {
  if (!custom) return undefined;
  if (typeof custom[name] === "string") return custom[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(custom)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function metadataFrom(custom: Record<string, string> | undefined, electionCode: string): Record<string, unknown> | null {
  const storedElection = metaValue(custom, "electionCode");
  if (storedElection !== electionCode) return null;
  const size = Number(metaValue(custom, "size"));
  return {
    electionCode: storedElection,
    ballotCodeHash: metaValue(custom, "ballotCodeHash") ?? "",
    contentType: metaValue(custom, "contentType") ?? "application/octet-stream",
    size: Number.isSafeInteger(size) && size >= 0 ? size : -1,
    uploadedAt: metaValue(custom, "uploadedAt") ?? "",
    deleteAfter: metaValue(custom, "deleteAfter") ?? "",
  };
}

function customFrom(metadata: ImageMetadata): Record<string, string> {
  return {
    electionCode: metadata.electionCode,
    ballotCodeHash: metadata.ballotCodeHash,
    contentType: metadata.contentType,
    size: String(metadata.size),
    uploadedAt: metadata.uploadedAt,
    deleteAfter: metadata.deleteAfter,
  };
}

export function openR2Store(bucket: R2Bucket, maxBytes: number): BlobStore {
  const putBase = (metadata: ImageMetadata, imageSha256: string) => ({
    customMetadata: customFrom(metadata),
    httpMetadata: { contentType: metadata.contentType, cacheControl: "private, no-store" },
    sha256: imageSha256,
  });

  return {
    async set(key, data, options) {
      const { electionCode, imageSha256 } = parts(key);
      if (options.metadata.electionCode !== electionCode) throw new Error("metadata election does not match key");
      if (sha256Hex(data) !== imageSha256) throw new Error("refusing bytes that do not match the key hash");
      if (data.byteLength > maxBytes) throw new Error("refusing an object over the size limit");
      const base = putBase(options.metadata, imageSha256);
      if (options.onlyIfNew) {
        const created = await bucket.put(key, data, { ...base, onlyIf: { etagDoesNotMatch: "*" } });
        return { modified: created !== null };
      }
      // Retention updates never replace a longer deleteAfter and never change bytes (the key is the hash).
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await bucket.head(key);
        if (!current) {
          const created = await bucket.put(key, data, { ...base, onlyIf: { etagDoesNotMatch: "*" } });
          if (created) return { modified: true };
          continue;
        }
        const storedUntil = Date.parse(metaValue(current.customMetadata, "deleteAfter") ?? "");
        const nextUntil = Date.parse(options.metadata.deleteAfter);
        if (Number.isFinite(storedUntil) && Number.isFinite(nextUntil) && nextUntil <= storedUntil) return { modified: false };
        const updated = await bucket.put(key, data, { ...base, onlyIf: { etagMatches: current.etag } });
        if (updated) return { modified: true };
      }
      return { modified: false };
    },
    async get(key) {
      const { electionCode } = parts(key);
      const obj = await bucket.head(key);
      if (!obj || obj.size > maxBytes) return null;
      const metadata = metadataFrom(obj.customMetadata, electionCode);
      if (!metadata) return null;
      const body = await bucket.get(key);
      if (!body) return null;
      return { data: new Uint8Array(await body.arrayBuffer()), metadata };
    },
    async getMetadata(key) {
      const { electionCode } = parts(key);
      const obj = await bucket.head(key);
      if (!obj) return null;
      const metadata = metadataFrom(obj.customMetadata, electionCode);
      return metadata ? { metadata } : null;
    },
    async delete(key) {
      parts(key);
      await bucket.delete(key);
    },
    async *listKeys(prefix?: string) {
      if (prefix !== undefined && !(prefix.endsWith("/") && isElectionCode(prefix.slice(0, -1)))) {
        throw new Error("refusing a list prefix that is not one election");
      }
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ limit: 1000, ...(prefix ? { prefix } : {}), ...(cursor ? { cursor } : {}) });
        for (const obj of page.objects) {
          if (!isImageKey(obj.key)) continue;
          if (prefix && !obj.key.startsWith(prefix)) continue;
          yield obj.key;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },
  };
}
