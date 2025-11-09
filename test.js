import { swapOneSolToCoinLiteral } from "./features/swapWithJupiter.js";
import fs from "fs";

try {
  const res = await swapOneSolToCoinLiteral(process.env, "$SATNOTE", 0.05);
} catch (e) {
  console.error("Swap error:", e);
  await fs.writeFileSync("./text.txt", e.toString());
}
