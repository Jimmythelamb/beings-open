// Download and plain-language steps for the Windows printer/scanner helper.
// The zip is built by packages/scanner-helper/tools/build-windows-bundle.mjs and published
// with its SHA256. The helper itself stays on 127.0.0.1; this page only offers the file.
import { h } from "./ui.js";
import { isMobileDevice } from "./logic.js";
import { HELPER_DOWNLOAD } from "../downloads/helper-download.js";

export { HELPER_DOWNLOAD };

export const INSTALL_BUTTON_LABEL = "Install printer/scanner helper";

/** The same command the desktop shortcut runs. Kept for the advanced detail, not the main message. */
export const HELPER_BRIDGE_COMMAND = 'node src\\cli.mjs bridge --output-root "%USERPROFILE%\\Documents\\BEINGS-Scans"';

export const INSTALL_STEPS = Object.freeze([
  "Download the setup file with the button above.",
  "Double-click BEINGS-Scanner-Helper-Setup.exe.",
  "If Windows SmartScreen appears, choose More info, then Run anyway. The file is not code-signed yet.",
  "The setup window closes itself. The helper runs in the background. There is no window to keep open.",
  "Come back to this page and press Connect printer & scanner (Windows PC).",
]);

export function formatDownloadSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function helperLooksHandheld(nav = typeof navigator !== "undefined" ? navigator : null) {
  if (!nav) return false;
  return isMobileDevice(nav.userAgent, nav.maxTouchPoints, nav.platform);
}

/** Collapsed command, for teachers who already have Node and a command window. */
export function helperCommandDetails() {
  return h(
    "details",
    { class: "advanced", "data-helper-advanced": "1" },
    h("summary", null, "Advanced: start the helper from a command window"),
    h("p", { class: "hint" }, "Most teachers can ignore this. After Install-BEINGS-Helper.cmd has run, the Start BEINGS helper shortcut does this for you. To start it by hand, open a command window in the helper folder and run:"),
    h("p", { class: "helper-sha" }, HELPER_BRIDGE_COMMAND),
  );
}

/**
 * Button, steps, and the zip's SHA256. handheld forces the iPad/phone note in tests;
 * otherwise the page checks the browser.
 */
export function helperInstallPanel({ handheld } = {}) {
  const onPhone = handheld ?? helperLooksHandheld();
  const size = formatDownloadSize(HELPER_DOWNLOAD.bytes);
  return h(
    "div",
    { class: "helper-install", "data-helper-install-panel": "1" },
    h("p", { class: "hint" }, "Do this on the Windows PC that has the printer and scanner. An iPad or phone cannot run the helper. No administrator password is needed. The helper runs in the background and starts when you sign in to Windows."),
    onPhone
      ? h("p", { class: "hint", "data-helper-phone": "1" }, "You are on an iPad or phone. The helper cannot run on this device. Open this page on the Windows PC with the printer and scanner, or copy the downloaded zip to that PC, then follow the steps there.")
      : null,
    h(
      "p",
      { class: "actions" },
      h(
        "a",
        { class: "btn", href: HELPER_DOWNLOAD.href, download: HELPER_DOWNLOAD.fileName, "data-helper-install": "1" },
        INSTALL_BUTTON_LABEL,
      ),
    ),
    h("ol", { class: "helper-steps" }, ...INSTALL_STEPS.map((step) => h("li", null, step))),
    h("p", { class: "helper-sha", "data-helper-sha": HELPER_DOWNLOAD.sha256 }, "SHA256 ", HELPER_DOWNLOAD.sha256),
    size ? h("p", { class: "hint" }, `File: ${HELPER_DOWNLOAD.fileName} (${size}).`) : null,
  );
}
