import { swapOneSolToCoinLiteral } from "./features/swapWithJupiter.js";

const res = await swapOneSolToCoinLiteral(process.env, "$BONK");
console.log("Swap tx signature:", res);
