import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { polkadotHubTestnet } from "./chain";

export const config = createConfig({
  chains: [polkadotHubTestnet],
  connectors: [injected()],
  transports: {
    [polkadotHubTestnet.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
