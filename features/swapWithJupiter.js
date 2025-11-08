// swapOneSolToCoinLiteral.js
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import axios from "axios";
import https from "node:https";
import bs58 from "bs58";
import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder?.("ipv4first");

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

// ---------- константы ----------
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DEC = 9;

const JUP_HEADERS = {
  accept: "application/json",
  "user-agent": "riichard-swap-bot/1.0",
  origin: "https://jup.ag",
  referer: "https://jup.ag/",
};

// ---------- утилиты ----------
function normalizeLiteral(lit) {
  return String(lit || "")
    .replace(/^\$/, "")
    .trim(); // "$BONK" -> "BONK"
}
function toRawAmount(ui, decimals) {
  if (!Number.isFinite(ui) || ui <= 0) throw new Error("Invalid amount UI");
  return BigInt(Math.round(ui * 10 ** decimals)).toString();
}

// кошелёк: принимает base58 ИЛИ JSON-массив байт
function keypairFromAny(secret) {
  const s = typeof secret === "string" ? secret.trim() : JSON.stringify(secret);

  // JSON-массив
  if (s.startsWith("[")) {
    const arr = JSON.parse(s);
    const bytes = Uint8Array.from(arr);
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    throw new Error(`Unexpected byte array length=${bytes.length}`);
  }
  // base58
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) {
    const bytes = bs58.decode(s);
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    throw new Error(`Unexpected base58 length=${bytes.length}`);
  }
  // hex (на всякий)
  if (/^[0-9a-fA-F]+$/.test(s)) {
    const bytes = new Uint8Array(
      s.match(/.{1,2}/g).map((h) => parseInt(h, 16))
    );
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    throw new Error(`Unexpected hex length=${bytes.length}`);
  }
  throw new Error("Unsupported WALLET_SECRET_KEY format");
}

// Jupiter Tokens API v2
async function jupSearch(query) {
  const url = `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(
    query
  )}`;
  const res = await AX.get(url);
  return res.data;
}

// --- новый getJupQuote на axios + fallback ---
async function getJupQuote(qUrl) {
  // 1) основной
  try {
    const res = await AX.get(qUrl.toString());
    return res.data;
  } catch (e) {
    // если не 401/403 — пробрасываем дальше
    const status = e?.response?.status;
    if (status !== 401 && status !== 403) throw e;

    // 2) fallback-домен
    try {
      const alt = new URL("https://quote-api.jup.ag/v6/quote");
      for (const [k, v] of qUrl.searchParams.entries())
        alt.searchParams.set(k, v);
      const res2 = await AX.get(alt.toString());
      return res2.data;
    } catch (e2) {
      throw e2; // если DNS не резолвит quote-api.jup.ag — увидим явную ошибку
    }
  }
}
// точное совпадение по символу, приоритет verified
function pickExactSymbol(results, wantSym) {
  const want = wantSym.toUpperCase();
  const exact = (results || []).filter(
    (t) => (t.symbol || "").toUpperCase() === want
  );
  if (!exact.length) throw new Error(`No exact symbol match for "${wantSym}".`);
  exact.sort((a, b) => Number(!!b.verified) - Number(!!a.verified));
  return exact[0];
}

// ---------- Jupiter V6: quote + build с заголовками и fallback ----------
// async function getJupQuote(qUrl) {
//   // основной хост
//   let res;
//   try {
//     res = await fetch(qUrl, { headers: JUP_HEADERS });
//   } catch (e) {
//     res = { ok: false, status: 0, _neterr: e };
//   }

//   // при 401/403/сетевой ошибке пробуем fallback
//   if (res.status === 401 || res.status === 403 || res.ok === false) {
//     try {
//       const alt = new URL("https://quote-api.jup.ag/v6/quote");
//       for (const [k, v] of qUrl.searchParams.entries())
//         alt.searchParams.set(k, v);
//       res = await fetch(alt, { headers: JUP_HEADERS });
//     } catch (e2) {
//       if (res._neterr) throw res._neterr;
//       // если DNS не резолвит fallback — отдадим исходную ошибку
//     }
//   }

//   if (!res.ok) {
//     const body = await res.text().catch(() => "");
//     throw new Error(`/quote failed: ${res.status} ${body}`);
//   }
//   return res.json();
// }

async function buildJupSwap(route, userPub, jupBase, priorityMaxLamports) {
  const body = {
    quoteResponse: route,
    userPublicKey: userPub,
    asLegacyTransaction: false,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: { maxLamports: priorityMaxLamports },
    },
  };

  try {
    const res = await AX.post(`${jupBase}/swap/v1/swap`, body);
    return res.data;
  } catch (e) {
    const status = e?.response?.status;
    if (status !== 401 && status !== 403) throw e;

    const res2 = await AX.post("https://quote-api.jup.ag/v6/swap", body);
    return res2.data;
  }
}

// ---------- основной экспорт ----------
/**
 * Свапает 1 SOL -> токен по литералу (напр. "$BONK")
 * @param {Object} env
 * @param {string} env.rpcUrl
 * @param {string|number[]} env.walletSecretKey  base58 ИЛИ JSON-массив байт
 * @param {string} [env.jupBase]                 default "https://api.jup.ag"
 * @param {number} [env.slippageBps]             default 50
 * @param {number} [env.priorityMaxLamports]     default 200_000
 * @param {string} coinLiteral                   "$BONK" | "BONK"
 * @returns {Promise<string>} signature
 */
export async function swapOneSolToCoinLiteral(env, coinLiteral) {
  const jupBase = env.jupBase || "https://api.jup.ag";
  const slippageBps = env.slippageBps ?? 50;
  const priorityMaxLamports = env.priorityMaxLamports ?? 200_000;

  // RPC/кошелёк
  const conn = new Connection(env.rpcUrl, { commitment: "confirmed" });
  const wallet = keypairFromAny(env.walletSecretKey);

  // 1) mint по символу
  const outSym = normalizeLiteral(coinLiteral); // "$BONK" -> "BONK"
  const list = await jupSearch(outSym);
  const chosen = pickExactSymbol(list, outSym);
  const outputMint = chosen.id;

  // 2) quote (1 SOL)
  const amount = toRawAmount(1, SOL_DEC); // "1000000000"
  const q = new URL("https://api.jup.ag/swap/v1/quote");
  q.searchParams.set("inputMint", WSOL_MINT);
  q.searchParams.set("outputMint", outputMint);
  q.searchParams.set("amount", amount);
  q.searchParams.set("slippageBps", String(slippageBps));

  const quote = await getJupQuote(q);
  const route = quote?.routes?.[0];
  if (!route)
    throw new Error(
      "No route found for 1 SOL. Try higher slippage or another token."
    );

  // 3) build swap tx
  const { swapTransaction } = await buildJupSwap(
    route,
    wallet.publicKey.toBase58(),
    jupBase,
    priorityMaxLamports
  );

  // 4) sign & send
  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapTransaction, "base64")
  );
  tx.sign([wallet]);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  // 5) confirm
  const conf = await conn.confirmTransaction(sig, "confirmed");
  if (conf.value?.err)
    throw new Error(`Transaction error. See: https://solscan.io/tx/${sig}`);
  return sig;
}
