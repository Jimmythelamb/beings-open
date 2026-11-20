// Daily scheduled function: delete every Netlify Blob whose deleteAfter has passed (03:30 UTC).
// New images live in R2. The Worker cron at the same time deletes those. This function does not call the Worker.
import type { Config } from "@netlify/functions";
import { runCleanup } from "../../src/cleanup.js";
import { openBlobStore } from "../../src/netlifyStore.js";

export default async (): Promise<Response> => {
  const r = await runCleanup(openBlobStore(), new Date());
  console.log(`cleanup: scanned ${r.scanned}, deleted ${r.deleted}, kept ${r.kept}, needing attention ${r.needsAttention.length}`);
  if (r.needsAttention.length) console.warn(`cleanup: ${r.needsAttention.length} blob(s) have no valid deleteAfter and were NOT deleted`);
  return new Response(JSON.stringify({ scanned: r.scanned, deleted: r.deleted, kept: r.kept, needsAttention: r.needsAttention.length }), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = { schedule: "30 3 * * *" };
