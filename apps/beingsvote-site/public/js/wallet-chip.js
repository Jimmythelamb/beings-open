// The connected wallet at the top right of every page (the shared site header): short address, copy, network badge
// (Coston2 or wrong network) and disconnect. Uses the existing wallet state from roles.js; it holds no keys and sends
// nothing. Pure model + small view so it is tested.
import { h, icon, badge } from "./ui.js";
import { networkState } from "./logic.js";
import { shortAddress } from "./format.js";
import { addressAvatar } from "./appkit-connect.js";

export const WALLET_ROLE_LINE = "This is the wallet that signs and pays for your election.";
export const CONNECT_LABEL = "Connect wallet";

/** What the header shows for a wallet state. */
export function walletChipModel(s, expectedChainId) {
  if (!s?.address) return { connected: false, label: CONNECT_LABEL, title: "Connect a wallet to create or run an election. Voters don't need one. No wallet yet? Get Bifrost (bifrostwallet.com), then free test coins at faucet.flare.network (choose C2FLR, not CFLR).", network: null };
  const net = networkState(s.chainId, expectedChainId);
  return {
    connected: true,
    label: shortAddress(s.address),
    address: s.address,
    title: `${s.address}. ${WALLET_ROLE_LINE}`,
    network: net,
    networkText: net === "ok" ? "Coston2" : net === "wrong" ? "Wrong network" : "Network unknown",
    networkTone: net === "ok" ? "ok" : net === "wrong" ? "bad" : "neutral",
    balanceText: s.balanceText || "",
  };
}

const NS = "http://www.w3.org/2000/svg";

/** Round identicon for the header chip. Drawn as SVG, so it needs no image host. */
export function walletChipAvatar(address) {
  const { hue, cells } = addressAvatar(address);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 5 4");
  svg.setAttribute("class", "wallet-avatar");
  svg.setAttribute("aria-hidden", "true");
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", "5");
  bg.setAttribute("height", "4");
  bg.setAttribute("fill", `hsl(${hue} 28% 88%)`);
  svg.append(bg);
  cells.forEach((row, y) => {
    row.forEach((on, x) => {
      if (!on) return;
      const cell = document.createElementNS(NS, "rect");
      cell.setAttribute("x", String(x));
      cell.setAttribute("y", String(y));
      cell.setAttribute("width", "1");
      cell.setAttribute("height", "1");
      cell.setAttribute("fill", `hsl(${hue} 42% 32%)`);
      svg.append(cell);
    });
  });
  return svg;
}

/** Network badge, copy and disconnect, shown next to the wallet button while connected. */
export function walletChipExtras(model, { onCopy, onDisconnect, onSwitch } = {}) {
  if (!model.connected) return [];
  return [
    model.network === "wrong" && onSwitch
      ? h("button", { class: "badge badge-bad net-badge", type: "button", title: "Switch your wallet to the Coston2 test network", onClick: onSwitch }, icon("alert", { size: 14 }), model.networkText)
      : h("span", { class: `badge badge-${model.networkTone} net-badge`, title: model.network === "ok" ? "Flare Coston2 test network (chain 114)" : "Your wallet is not on the Coston2 test network" }, icon(model.network === "ok" ? "check" : "alert", { size: 14 }), model.networkText),
    h("button", { class: "icon-btn", type: "button", "aria-label": "Copy your wallet address", title: "Copy your wallet address", onClick: () => onCopy?.(model.address) }, icon("copy", { size: 16 })),
    h("button", { class: "icon-btn", type: "button", "aria-label": "Disconnect your wallet", title: "Disconnect", onClick: () => onDisconnect?.() }, icon("x", { size: 16 })),
  ];
}

/** The short info line under the header while connected. */
export const walletRoleLine = (model) => (model.connected ? h("span", { class: "wallet-role-line small" }, icon("info", { size: 14 }), WALLET_ROLE_LINE) : null);
