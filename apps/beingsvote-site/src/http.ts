import type { SiteConfig } from "./config.js";

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });
}

/** CORS headers only for origins listed in ALLOWED_ORIGINS. No list means same-origin only (no CORS headers at all). */
export function corsHeaders(req: Request, cfg: SiteConfig): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !cfg.allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-ballot-code, x-election-code, x-image-sha256, x-ballot-key, x-retention-days, x-public-images, x-verifier-timestamp, x-verifier-signature",
    "access-control-expose-headers": "x-image-sha256, content-type",
    "access-control-max-age": "600",
  };
}

export function withHeaders(res: Response, extra: Record<string, string>): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
