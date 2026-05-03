import { defineChain } from "viem";

const PRIMARY_RPC =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://services.polkadothub-rpc.com/testnet";

export const polkadotHubTestnet = defineChain({
  id: 420420417,
  name: "Polkadot Hub TestNet",
  nativeCurrency: { decimals: 18, name: "PAS", symbol: "PAS" },
  rpcUrls: {
    default: {
      http: [PRIMARY_RPC, "https://eth-rpc-testnet.polkadot.io/"],
    },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://blockscout-passet-hub.parity-testnet.parity.io",
    },
  },
});
