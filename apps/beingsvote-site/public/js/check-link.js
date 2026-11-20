// Receipt links open Check my ballot with the election code in the URL fragment.
// The ballot code is never read from the address. The fragment is cleared after it is read.

export function isCheckDocumentPath(pathname) {
  return /\/check\.html$/i.test(String(pathname || ""));
}

/**
 * Where the hash router should go.
 * `#e=BEINGS-...` and a bare `/check.html` both open Check my ballot.
 * A normal hash route (`#/results`) is unchanged.
 */
export function routeFromLocation({ pathname = "/", hash = "" } = {}) {
  const checkFile = isCheckDocumentPath(pathname);
  const raw = String(hash || "").replace(/^#/, "");
  if (raw.startsWith("e=") || raw.startsWith("e&") || (checkFile && raw === "")) {
    return { path: "/check", query: new URLSearchParams() };
  }
  const [pathPart, qs = ""] = (raw || "/").split("?");
  const path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  return { path, query: new URLSearchParams(qs) };
}

/** Election code text carried in the fragment. Ballot-code parameters are ignored. */
export function electionTextFromFragment(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (!raw) return "";
  if (raw.startsWith("e=") || raw.startsWith("e&")) return new URLSearchParams(raw).get("e") ?? "";
  const q = raw.indexOf("?");
  if (q === -1) return "";
  if (raw.slice(0, q) !== "/check") return "";
  const params = new URLSearchParams(raw.slice(q + 1));
  return params.get("e") || params.get("election") || "";
}

/**
 * Hash to leave in the address bar after the election code has been read.
 * Returns "" when the fragment should be removed, "#/check" when the route must stay,
 * or null when the address should not change.
 * Ballot-code parameters are stripped too, so a hand-edited link cannot keep one in the address.
 */
export function hashAfterReadingElection(hash, { checkFile = false } = {}) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (raw.startsWith("e=") || raw.startsWith("e&")) return checkFile ? "" : "#/check";
  const q = raw.indexOf("?");
  if (q === -1) return null;
  if (raw.slice(0, q) !== "/check") return null;
  const params = new URLSearchParams(raw.slice(q + 1));
  const had = ["e", "election", "b", "ballot", "ballotCode"].some((k) => params.has(k));
  if (!had) return null;
  for (const k of ["e", "election", "b", "ballot", "ballotCode"]) params.delete(k);
  const rest = params.toString();
  if (!rest) return checkFile ? "" : "#/check";
  return `#/check?${rest}`;
}

/** Path + search + hash with the election code removed from the fragment. Null when nothing changes. */
export function urlWithoutElectionFragment({ pathname = "/", search = "", hash = "", checkFile = false } = {}) {
  const next = hashAfterReadingElection(hash, { checkFile });
  if (next === null) return null;
  return `${pathname}${search}${next}`;
}
