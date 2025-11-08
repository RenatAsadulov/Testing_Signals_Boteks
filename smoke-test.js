import axios from "axios";
import https from "node:https";

const AX = axios.create({
  // форс IPv4 и без keepAlive (некоторым сетям CF так нравится больше)
  httpsAgent: new https.Agent({ family: 4, keepAlive: false }),
  timeout: 15000,
  headers: {
    accept: "application/json",
    "user-agent": "riichard-swap-bot/1.0",
    origin: "https://jup.ag",
    referer: "https://jup.ag/",
  },
});

const { data } = await AX.get("https://quote-api.jup.ag/v6/quote", {
  params: {
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "So11111111111111111111111111111111111111112",
    amount: "1000000000",
    slippageBps: 50,
  },
});
console.log("routes?", !!data?.routes?.length);
