import { swapOneSolToCoinLiteral } from "./features/swapWithJupiter.js";
import fs from "fs";

try {
  const res = await swapOneSolToCoinLiteral("$VIBES", 0.01, "USDT");
} catch (e) {
  console.error("Swap error:", e);
  await fs.writeFileSync("./text.txt", e.toString());
}
