// Scheduled cleanup: delete every blob whose deleteAfter has passed. Metadata is the only source of the date.
import { isExpired, parseDeleteAfter } from "./expiry.js";
import type { BlobStore } from "./store.js";

export interface CleanupResult {
  scanned: number;
  deleted: number;
  kept: number;
  /** Blobs with a missing or unreadable deleteAfter. They are never deleted blindly; they are reported for a human. */
  needsAttention: string[];
}

export async function runCleanup(store: BlobStore, now: Date): Promise<CleanupResult> {
  const out: CleanupResult = { scanned: 0, deleted: 0, kept: 0, needsAttention: [] };
  // Collect keys first so deleting while paging cannot skip entries.
  const keys: string[] = [];
  for await (const k of store.listKeys()) keys.push(k);
  for (const key of keys) {
    out.scanned++;
    const meta = await store.getMetadata(key);
    if (!meta) continue; // already gone
    if (parseDeleteAfter(meta.metadata.deleteAfter) === null) {
      out.needsAttention.push(key);
      continue;
    }
    if (isExpired(meta.metadata.deleteAfter, now)) {
      await store.delete(key);
      out.deleted++;
    } else {
      out.kept++;
    }
  }
  return out;
}
