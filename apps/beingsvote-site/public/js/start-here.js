// Landing on "Create Your Election Here": the header scrolls off and the Start here section sits at the top of the screen.
const REDUCE = "(prefers-reduced-motion: reduce)";

export function motionReduced(win = globalThis) {
  try {
    return !!win.matchMedia?.(REDUCE)?.matches;
  } catch {
    return false;
  }
}

/**
 * Unstick the header, then bring #start-here to the top of the viewport.
 * Reduced motion jumps. Otherwise the move is smooth. Returns false when the section is not on the page.
 */
export function revealStartHere({ doc = globalThis.document, win = globalThis } = {}) {
  const el = doc?.getElementById?.("start-here");
  if (!el) return false;
  doc.documentElement?.classList?.add("start-here-view");
  void el.offsetHeight;
  const behavior = motionReduced(win) ? "auto" : "smooth";
  el.style.scrollMarginTop = "0px";
  const align = () => {
    const top = el.getBoundingClientRect().top + (win.scrollY || win.pageYOffset || 0);
    win.scrollTo?.({ top: Math.max(0, top), left: 0, behavior });
  };
  align();
  // The header leaving sticky layout can shift the section by a frame. Correct once that settles.
  win.requestAnimationFrame?.(() => align());
  const button = el.querySelector("[data-start-here], summary");
  if (button) {
    button.setAttribute("tabindex", "-1");
    button.focus?.({ preventScroll: true });
  }
  el.classList.add("start-here-flash");
  win.setTimeout?.(() => el.classList.remove("start-here-flash"), 1800);
  return behavior;
}

export function clearStartHereView(doc = globalThis.document) {
  doc?.documentElement?.classList?.remove("start-here-view");
}

/** True when this click is the create-election link and the Start here section is already on the page. */
export function createLinkAlreadyHere(event, win = globalThis) {
  const a = event?.target?.closest?.("a.create-btn, a[href='#/admin?new=1']");
  if (!a) return false;
  const hash = String(win.location?.hash ?? "");
  return hash === "#/admin?new=1" && !!win.document?.getElementById?.("start-here");
}
