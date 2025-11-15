import "dotenv/config";
import { createTradingEngine } from "./tradingEngine.mjs";
import settings from "./data/settings.json" with { type: "json" };

const staticStore = {
  async getAll() {
    return settings;
  },
};

const engine = createTradingEngine({
  store: staticStore,
  logger: console,
});

engine
  .start()
  .catch((err) => {
    console.error("Failed to start trading engine", err);
    process.exit(1);
  });
