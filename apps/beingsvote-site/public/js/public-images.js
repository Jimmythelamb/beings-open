// Public ballot images: the visible notice, and a single-picture lookup (election code + fingerprint).
// The full gallery stays on Admin and Verifier only. Nothing is fetched until the voter or visitor asks.
import { h, icon, callout, spinner } from "./ui.js";
import { headingWithHelp, helpToggle, labelWithHelp } from "./help.js";
import { isPublicBallotImages, normalizeImageSha256, pictureMatchesLedger, ballotImageFailure, createBallotImageView } from "./logic.js";
import { sha256Hex, shortHash } from "./format.js";
import { CONFIG, fetchImageApi, resolveImagePath } from "./config.js";

export { isPublicBallotImages, normalizeImageSha256 };

export const PUBLIC_IMAGES_NOTICE_TITLE = "Ballot pictures are public for a short time";
export const PUBLIC_IMAGES_NOTICE_TEXT = "Anyone who has this election code and a ballot's fingerprint can view that picture. The scan can show the printed ballot code, so it could be used as proof of how someone voted or to pressure them. Pictures stay public for 30 to 60 days, then are removed. Fingerprints and readings stay on the chain.";

export function publicImagesNotice({ help = "results.publicImages", headingId = "public-images-h" } = {}) {
  return h(
    "div",
    { class: "card public-images-notice" },
    ...headingWithHelp("h2", { id: headingId }, PUBLIC_IMAGES_NOTICE_TITLE, help),
    h("p", null, PUBLIC_IMAGES_NOTICE_TEXT),
  );
}

/** Compact callout used next to Check my ballot's scan, or under a heading that already exists. */
export function publicImagesCallout({ help = "check.publicImages" } = {}) {
  const { button, panel } = helpToggle("check.publicImages", { label: PUBLIC_IMAGES_NOTICE_TITLE });
  return h(
    "div",
    { class: "public-images-callout" },
    callout("warn", h("span", { class: "heading-row" }, PUBLIC_IMAGES_NOTICE_TITLE, button), PUBLIC_IMAGES_NOTICE_TEXT, "alert"),
    panel,
  );
}

export function publicImagesStaffNote() {
  return callout(
    "info",
    "Single pictures can also be opened without signing in",
    "Because Public ballot images is on, anyone with this election code and one picture's fingerprint can view that picture. The full set of pictures here still needs the organizer or a registered verifier to sign in. Pictures stay public for 30 to 60 days, then are removed. Fingerprints and readings stay on the chain.",
    "info",
  );
}

export function fetchPublicBallotImage(electionCode, imageHash) {
  const hash = normalizeImageSha256(imageHash);
  if (!hash) return Promise.reject(new Error("bad fingerprint"));
  const url = `${resolveImagePath(CONFIG.imagesApi)}?election=${encodeURIComponent(electionCode)}`;
  return fetchImageApi(url, { headers: { "X-Image-Sha256": hash }, cache: "no-store", referrerPolicy: "no-referrer" });
}

/**
 * A card: type a fingerprint, then press View. No request goes out until then.
 * `initialHash` is shown in the box but is not fetched automatically.
 */
export function publicImageLookup({ electionCode, initialHash = "", headingId = "public-lookup-h" } = {}) {
  const view = createBallotImageView();
  const hashIn = h("input", {
    id: "public-image-hash",
    type: "text",
    class: "plain-mono",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "64 hex characters",
    value: initialHash || "",
    "aria-describedby": "public-image-hash-hint",
  });
  const hint = h("p", { id: "public-image-hash-hint", class: "hint" }, "The picture's SHA-256 fingerprint, from the ledger. 0x at the start is fine. Nothing is downloaded until you press the button.");
  const button = h("button", { class: "btn btn-primary", type: "button" }, icon("image", { size: 18 }), "View this picture");
  const out = h("div", { class: "public-image-out", role: "status" });
  const err = h("p", { class: "err", hidden: true });

  const show = (node) => { out.replaceChildren(node); };

  button.addEventListener("click", () => {
    err.hidden = true;
    err.textContent = "";
    const hash = normalizeImageSha256(hashIn.value);
    if (!hash) {
      err.hidden = false;
      err.textContent = "That doesn't look like a picture fingerprint. It should be 64 letters and numbers (0–9, a–f).";
      hashIn.setAttribute("aria-invalid", "true");
      hashIn.focus();
      return;
    }
    hashIn.removeAttribute("aria-invalid");
    button.disabled = true;
    show(spinner("Fetching the ballot picture…"));
    view.reset();
    view.load({
      fetchImage: () => fetchPublicBallotImage(electionCode, hash),
      hashBytes: (bytes) => sha256Hex(bytes),
      objectUrlFor: (bytes, type) => URL.createObjectURL(new Blob([bytes], { type })),
      expectedHash: hash,
    }).then((result) => {
      if (result.revoke) URL.revokeObjectURL(result.revoke);
      if (result.previous) URL.revokeObjectURL(result.previous);
      if (result.status === "duplicate" || result.status === "stale") return;
      button.disabled = false;
      if (result.status === "error") {
        const title = result.title === "The picture has been deleted" ? "Image expired" : result.title;
        show(callout(result.tone, title, result.text));
        return;
      }
      const media = result.type === "application/pdf"
        ? h("iframe", { src: result.url, title: "Ballot scan", class: "ballot-frame" })
        : h("img", { src: result.url, alt: "Scan of a ballot. A printed ballot code may be visible.", class: "ballot-img" });
      const match = result.matches
        ? callout("ok", "This is exactly the picture recorded on the ledger", ["We computed the fingerprint (SHA-256) of this picture in your browser and compared it with the one you entered: ", h("code", null, shortHash(result.hex, 10, 8)), ". They are identical."])
        : callout("bad", "This picture does NOT match the fingerprint you entered", "The picture's fingerprint is different, so it should not be trusted.");
      show(h("div", { class: "stack" }, h("div", { class: "ballot-media" }, media), match, h("p", { class: "small" }, h("a", { href: result.url, target: "_blank", rel: "noopener", class: "btn btn-sm" }, "Open full size"))));
    }).catch(() => {
      button.disabled = false;
      show(callout("warn", "We couldn't load the picture", "The image service didn't answer."));
    });
  });

  return h(
    "section",
    { class: "card public-image-lookup", "aria-labelledby": headingId },
    ...headingWithHelp("h2", { id: headingId }, [icon("image", { size: 22 }), "Look up a ballot picture"], "results.publicImages"),
    h("p", null, "Open one picture with this election's code and the picture's fingerprint. The full set of pictures is not listed here."),
    h("div", { class: "field" }, labelWithHelp("public-image-hash", "Picture fingerprint", "results.publicImages"), hashIn, hint),
    err,
    h("div", { class: "actions" }, button),
    out,
  );
}

export { pictureMatchesLedger };
