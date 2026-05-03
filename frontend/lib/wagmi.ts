import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { polkadotHubTestnet } from "./chain";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;

export const config = createConfig({
  chains: [polkadotHubTestnet],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [polkadotHubTestnet.id]: http(RPC_URL),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
