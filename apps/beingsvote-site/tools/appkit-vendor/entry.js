// Reown AppKit for the static site. Loaded only when someone connects a wallet.
// ethers is the copy the page already loaded (see ethers-shim.js).
import { createAppKit } from "@reown/appkit";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";

// AppKit writes <style> tags. This site's CSP allows styles from files only, so mirror those
// tags into constructable stylesheets (which the policy permits) and do not insert the tags.
if (typeof document !== "undefined" && !document.__beingsAppKitStyles) {
  document.__beingsAppKitStyles = true;
  const origCreate = document.createElement.bind(document);
  const headAppend = document.head.appendChild.bind(document.head);
  const headRemove = document.head.removeChild.bind(document.head);
  document.createElement = function beingsCreate(tag, options) {
    const el = origCreate(tag, options);
    if (String(tag).toLowerCase() !== "style") return el;
    let sheet = null;
    const sync = () => {
      const css = String(el.textContent || "");
      const off = el.getAttribute("media") === "enabled";
      if (!sheet) {
        sheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      try {
        sheet.replaceSync(off ? "" : css);
      } catch {
        /* a bad token must not blank the rest of the modal */
      }
    };
    const text = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    if (text?.set) {
      Object.defineProperty(el, "textContent", {
        configurable: true,
        get: text.get ? () => text.get.call(el) : undefined,
        set(value) {
          text.set.call(el, value);
          sync();
        },
      });
    }
    const media = Object.getOwnPropertyDescriptor(HTMLStyleElement.prototype, "media");
    if (media?.set) {
      Object.defineProperty(el, "media", {
        configurable: true,
        get: media.get ? () => media.get.call(el) : undefined,
        set(value) {
          media.set.call(el, value);
          sync();
        },
      });
    }
    el.__beingsSync = sync;
    return el;
  };
  document.head.appendChild = function beingsAppend(node) {
    if (node?.tagName === "STYLE") {
      node.__beingsSync?.();
      return node;
    }
    return headAppend(node);
  };
  document.head.removeChild = function beingsRemove(node) {
    if (node?.tagName === "STYLE" && node.parentNode !== document.head) return node;
    return headRemove(node);
  };
}

export { createAppKit, EthersAdapter };
