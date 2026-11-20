// Only the viem pieces AppKit reaches. The main `viem` entry also dragged in every chain.
export { createPublicClient } from "./node_modules/viem/_esm/clients/createPublicClient.js";
export { fallback } from "./node_modules/viem/_esm/clients/transports/fallback.js";
export { http } from "./node_modules/viem/_esm/clients/transports/http.js";
export { erc20Abi } from "./node_modules/viem/_esm/constants/abis.js";
export { encodeFunctionData } from "./node_modules/viem/_esm/utils/abi/encodeFunctionData.js";
export { defineChain } from "./node_modules/viem/_esm/utils/chain/defineChain.js";
export { toHex } from "./node_modules/viem/_esm/utils/encoding/toHex.js";
export { hashMessage } from "./node_modules/viem/_esm/utils/signature/hashMessage.js";
export { hashTypedData } from "./node_modules/viem/_esm/utils/signature/hashTypedData.js";
export { formatUnits } from "./node_modules/viem/_esm/utils/unit/formatUnits.js";
