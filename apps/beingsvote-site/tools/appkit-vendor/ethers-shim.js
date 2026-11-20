// The site already loads ethers v6 (CDN, then /vendor). AppKit's adapter imports the package name.
// This shim forwards those imports to that copy so the bundle does not ship a second ethers.
function get(name) {
  const ethers = globalThis.ethers;
  if (!ethers || typeof ethers[name] === "undefined") throw new Error("ethers is not loaded yet");
  return ethers[name];
}

const call = (name) => (...args) => get(name)(...args);
// `new` on these returns the real ethers instance (a constructor that returns an object).
const construct = (name) => function ethersForward(...args) {
  return new (get(name))(...args);
};

export const BrowserProvider = construct("BrowserProvider");
export const Contract = construct("Contract");
export const JsonRpcProvider = construct("JsonRpcProvider");
export const JsonRpcSigner = construct("JsonRpcSigner");
export const formatEther = call("formatEther");
export const formatUnits = call("formatUnits");
export const getAddress = call("getAddress");
export const hexlify = call("hexlify");
export const isHexString = call("isHexString");
export const parseUnits = call("parseUnits");
export const toUtf8Bytes = call("toUtf8Bytes");
