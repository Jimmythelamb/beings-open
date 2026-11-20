// Shared copy: which wallet to get and how to get free Coston2 test coins (used by wallet-info.js and faucet.js).
/**
 * Getting a wallet and free test coins. Faucet facts are from the official Flare Faucet page (checked 10 Nov 2026):
 * 100 C2FLR, 10 USDT0 and 10 FXRP for the Coston2 testnet per address per 24 hours; test coins with no real value.
 */
export const WALLET_GUIDE = {
  recommended: { name: "Bifrost Wallet", url: "https://bifrostwallet.com" },
  alsoWorks: "MetaMask",
  faucet: { name: "official Flare Faucet", url: "https://faucet.flare.network", host: "faucet.flare.network", perRequest: "100 C2FLR, 10 USDT0 and 10 FXRP", per: "per address every 24 hours", button: "Request C2FLR", choose: "On the faucet, choose C2FLR in the drop-down (not CFLR)", notThis: "CFLR is the older Coston test network (chain 16); CFLR coins do not work with B.E.I.N.G.S., which runs on Coston2 (chain 114)" },
  typicalNeed: "about 1 to 2 C2FLR",
  noValue: "These are free test coins with no real-world value. You can't buy, sell or cash them out; they only pay the tiny fees on the test network.",
  networkLabel: "Flare Coston2 test network",
};

