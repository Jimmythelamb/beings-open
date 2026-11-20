import { getStore } from "@netlify/blobs";
import { STORE_NAME } from "./config.js";
import type { BlobStore } from "./store.js";

/** The production store: Netlify Blobs, site-wide (it survives deploys), strongly consistent. */
export function openBlobStore(): BlobStore {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  return {
    async set(key, data, options) {
      const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      const opts = options.onlyIfNew ? { metadata: options.metadata, onlyIfNew: true as const } : { metadata: options.metadata };
      const res = await store.set(key, body, opts);
      return { modified: res.modified };
    },
    async get(key) {
      const r = await store.getWithMetadata(key, { type: "arrayBuffer" });
      return r ? { data: new Uint8Array(r.data), metadata: r.metadata as Record<string, unknown> } : null;
    },
    async getMetadata(key) {
      const r = await store.getMetadata(key);
      return r ? { metadata: r.metadata as Record<string, unknown> } : null;
    },
    async delete(key) {
      await store.delete(key);
    },
    async *listKeys(prefix?: string) {
      for await (const page of store.list(prefix ? { paginate: true, prefix } : { paginate: true })) {
        for (const b of page.blobs) yield b.key;
      }
    },
  };
}
