// ESM: "type": "module" в package.json
import axios from "axios";
import https from "node:https";
import bs58 from "bs58";
import { setDefaultResultOrder } from "node:dns";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

setDefaultResultOrder?.("ipv4first");

const {
  RPC_URL,
  JUPITER_HOST,
  JUPITER_IP,
  WALLET_SECRET_KEY,
  SLIPPAGE_BBS,
  PRIORITY_MAX_LAMPORTS,
} = process.env;

// -----------------------------
// Константы / заголовки
// -----------------------------
const COMMON_HEADERS = {
  accept: "application/json",
  "user-agent": "riichard-swap-bot/1.0",
  origin: "https://jup.ag",
  referer: "https://jup.ag/",
};

async function resolveMintBySymbol(symbol) {
  const query = symbol.trim().toUpperCase();
  const list = await jupSearchSymbol(query);
  const want = list.filter((t) => (t.symbol || "").toUpperCase() === query);
  if (!want.length) throw new Error(`No token found for ${symbol}`);

  want.sort(
    (a, b) =>
      Number(!!b.verified) - Number(!!a.verified) ||
      Number((b.tokenProgram || "") === "spl-token") -
        Number((a.tokenProgram || "") === "spl-token")
  );

  const picked = want[0];
  return { mint: picked.id, dec: picked.decimals, meta: picked };
}

// -----------------------------
// HTTP клиенты (Jupiter v6 и Tokens v2)
// -----------------------------
function createJupClient({ host = "quote-api.jup.ag", ip }) {
  if (ip) {
    return axios.create({
      baseURL: `https://${ip}`,
      httpsAgent: new https.Agent({
        family: 4,
        keepAlive: false,
        servername: host,
      }),
      headers: { ...COMMON_HEADERS, host }, // Host header обязателен при работе по IP
      timeout: 15000,
    });
  }
  return axios.create({
    baseURL: `https://${host}`,
    httpsAgent: new https.Agent({ family: 4, keepAlive: false }),
    headers: { ...COMMON_HEADERS },
    timeout: 15000,
  });
}

// Tokens v2 (обычно резолвится нормально; при желании можно сделать IP-аналог)
const TOKENS_AX = axios.create({
  baseURL: "https://lite-api.jup.ag",
  httpsAgent: new https.Agent({ family: 4, keepAlive: false }),
  headers: { ...COMMON_HEADERS },
  timeout: 15000,
});

// -----------------------------
// Утилиты
// -----------------------------
function normalizeLiteral(lit) {
  return String(lit || "")
    .replace(/^\$/, "")
    .trim(); // "$BONK" -> "BONK"
}

async function buildSignSendSwap({
  jax,
  q,
  conn,
  wallet,
  priorityMaxLamports = 200_000,
}) {
  // 1) Сборка транзакции на стороне Jupiter
  const { data } = await jax.post("/v6/swap", {
    quoteResponse: q, // ← передаём ВЕСЬ объект котировки
    userPublicKey: wallet.publicKey.toBase58(),
    asLegacyTransaction: false,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        priorityLevel: "high", // "low" | "medium" | "high" | "veryHigh" | "extreme"
        maxLamports: priorityMaxLamports,
      },
    },
  });

  const { swapTransaction } = data; // base64
  if (!swapTransaction)
    throw new Error("No swapTransaction in Jupiter response");

  // 2) Подписать и отправить с твоего кошелька
  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapTransaction, "base64")
  );
  tx.sign([wallet]);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  const conf = await conn.confirmTransaction(sig, "confirmed");
  if (conf.value?.err) {
    throw new Error(`Tx failed: https://solscan.io/tx/${sig}`);
  }
  return sig;
}

function toRawAmount(ui, decimals) {
  if (!Number.isFinite(ui) || ui <= 0) throw new Error("Invalid UI amount");
  return BigInt(Math.round(ui * 10 ** decimals)).toString();
}

function keypairFromAny(secret) {
  const s = typeof secret === "string" ? secret.trim() : JSON.stringify(secret);

  // JSON-массив байт
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

  // hex
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

// -----------------------------
// Tokens API v2
// -----------------------------
async function jupSearchSymbol(symbol) {
  const { data } = await TOKENS_AX.get("/tokens/v2/search", {
    params: { query: symbol },
  });

  return data;
}
// -----------------------------
// Jupiter v6 (через IP/SNI при необходимости)
// -----------------------------

function pickExactSymbolPreferVerified(results, wantSym) {
  const want = wantSym.toUpperCase();
  const exact = (results || []).filter(
    (t) => (t.symbol || "").toUpperCase() === want
  );
  if (!exact.length) throw new Error(`No exact symbol match for "${wantSym}".`);
  // только verified сначала
  const verified = exact.filter((t) => !!t.verified);
  if (verified.length) return verified[0];
  // иначе берём с наибольшей ликвидностью/объёмом если есть такое поле, иначе первый
  exact.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
  return exact[0];
}

// -----------------------------
// Основная функция
// -----------------------------
/**
 * Свап 1 SOL -> токен по литералу (например "$BONK"), Jupiter v6
 * @param {Object} env
 * @param {string} env.RPC_URL                    - Solana mainnet RPC
 * @param {string|number[]} env.walletSecretKey - base58 или JSON-массив байт
 * @param {number} [env.slippageBps=50]
 * @param {number} [env.priorityMaxLamports=200_000]
 * @param {string} [env.jupHost="quote-api.jup.ag"]
 * @param {string} [env.jupIp]                   - если указан, используем IP + SNI (обход DNS)
 * @param {string} coinLiteral                   - "$BONK" | "BONK"
 * @returns {Promise<string>} подпись транзакции
 */
export async function swapOneSolToCoinLiteral(coinLiteral, amountC, literl) {
  if (!amountC || !literl) {
    return {
      status: "error",
      text: "Complete configuration",
    };
  }
  try {
    const conn = new Connection(RPC_URL, { commitment: "confirmed" });
    const wallet = keypairFromAny(WALLET_SECRET_KEY);

    // HTTP клиент для Jupiter v6
    const JAX = createJupClient({
      host: JUPITER_HOST || "quote-api.jup.ag",
      ip: JUPITER_IP,
    });

    // 1) mint по символу
    const outSym = normalizeLiteral(coinLiteral); // "$BONK" -> "BONK"
    const list = await jupSearchSymbol(outSym);
    let chosen = pickExactSymbolPreferVerified(list, outSym);
    let outputMint = chosen.id;
    const inToken = await resolveMintBySymbol(literl); // ← резолвим USDT
    const uiAmount = amountC; // ← 10 USDT
    const amount = toRawAmount(uiAmount, inToken.dec); // 10 * 10^6 -> "10000000"

    const params = {
      inputMint: inToken.mint,
      outputMint,
      amount,
      slippageBps: SLIPPAGE_BBS,
      swapMode: "ExactIn",
    };

    const { data: quoteRaw } = await JAX.get("/v6/quote", { params });

    const sig = await buildSignSendSwap({
      jax: JAX,
      q: quoteRaw,
      conn,
      wallet,
      priorityMaxLamports: PRIORITY_MAX_LAMPORTS,
    });

    const solcanLink = `https://solscan.io/tx/${sig}`;

    return { status: "success", text: solcanLink };
  } catch (error) {
    console.log("ERROR", error);
    return { status: "error", text: "Error: " + error.message };
  }
}

// ====== Jupiter Price API (drop-in) ========================================
// Требуются axios и https уже импортированные в файле.
// Опциональные ENV: PRICE_HOST=price.jup.ag, PRICE_IP=<ip>

const __PRICE_HEADERS =
  typeof COMMON_HEADERS !== "undefined"
    ? COMMON_HEADERS
    : {
        accept: "application/json",
        "user-agent": "riichard-swap-bot/1.0",
        origin: "https://jup.ag",
        referer: "https://jup.ag/",
      };

const { PRICE_HOST = "price.jup.ag", PRICE_IP } = process.env;

function __createPriceClient({ host = PRICE_HOST, ip = PRICE_IP } = {}) {
  if (ip) {
    return axios.create({
      baseURL: `https://${ip}`,
      httpsAgent: new https.Agent({
        family: 4,
        keepAlive: false,
        servername: host,
      }),
      headers: { ...__PRICE_HEADERS, host },
      timeout: 15000,
    });
  }
  return axios.create({
    baseURL: `https://${host}`,
    httpsAgent: new https.Agent({ family: 4, keepAlive: false }),
    headers: { ...__PRICE_HEADERS },
    timeout: 15000,
  });
}

// ---- Tokens v2 search (используем существующий TOKENS_AX, если он есть)
const __TOK_AX =
  typeof TOKENS_AX !== "undefined"
    ? TOKENS_AX
    : axios.create({
        baseURL: "https://lite-api.jup.ag",
        httpsAgent: new https.Agent({ family: 4, keepAlive: false }),
        headers: { ...__PRICE_HEADERS },
        timeout: 15000,
      });

async function __jupSearchSymbol(symbol) {
  const { data } = await __TOK_AX.get("/tokens/v2/search", {
    params: { query: symbol },
  });
  return data || [];
}

function __pickExactSymbolPreferVerified(results, wantSym) {
  const want = wantSym.toUpperCase();
  const exact = (results || []).filter(
    (t) => (t.symbol || "").toUpperCase() === want
  );
  if (!exact.length) throw new Error(`No exact symbol match for "${wantSym}".`);
  const verified = exact.filter((t) => !!t.verified);
  if (verified.length) return verified[0];
  exact.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
  return exact[0];
}

async function __resolveMintBySymbol(symbol) {
  const list = await __jupSearchSymbol(symbol.trim());
  const picked = __pickExactSymbolPreferVerified(list, symbol);
  return { mint: picked.id, dec: picked.decimals ?? 0, meta: picked };
}

// ---------------- PUBLIC API ----------------

/** Цена(ы) по mint(ам). По умолчанию в USDC. */
export async function getPricesByMint(mintOrMints, opt = {}) {
  const jax = __createPriceClient({});
  const ids = Array.isArray(mintOrMints) ? mintOrMints : [mintOrMints];

  // vsToken может быть символом — попробуем резолвнуть в mint
  let vsTokenId = opt.vsToken || "USDC";
  if (vsTokenId && vsTokenId.length < 32) {
    try {
      const vs = await __resolveMintBySymbol(vsTokenId);
      vsTokenId = vs.mint;
    } catch {
      /* игнор, Jupiter вернёт дефолтные валюты */
    }
  }

  const { data } = await jax.get("/v3/price", {
    params: {
      ids: ids.join(","),
      ...(vsTokenId ? { vsToken: vsTokenId } : {}),
      ...(opt.vsAmount ? { vsAmount: opt.vsAmount } : {}),
      ...(opt.onlyVsToken ? { onlyVsToken: true } : {}),
    },
  });

  return data?.data || {};
}

/** Цена по символу (например 'SOL'/'BONK'). */
export async function getPriceBySymbol(symbol, opt = {}) {
  const { mint } = await __resolveMintBySymbol(symbol);
  const res = await getPricesByMint(mint, opt);
  return res[mint] || null;
}

/** Батч-цены по символам — вернёт массив в исходном порядке. */
export async function getPricesBySymbols(symbols, opt = {}) {
  const mints = await Promise.all(symbols.map(__resolveMintBySymbol));
  const byMint = await getPricesByMint(
    mints.map((m) => m.mint),
    opt
  );
  return mints.map(({ mint, meta }) => ({
    symbol: meta.symbol,
    mint,
    ...(byMint[mint] || {}),
  }));
}

/** Изменение цены за период: "24h" | "7d" | "30d". */
export async function getPriceChanges(mints, interval = "24h") {
  const jax = __createPriceClient({});
  const { data } = await jax.get("/v3/price-changes", {
    params: {
      ids: (Array.isArray(mints) ? mints : [mints]).join(","),
      interval,
    },
  });
  return data?.data || {};
}
// ============================================================================
// Примеры вызова:
// const p1 = await getPriceBySymbol("BONK", { vsToken: "USDC", onlyVsToken: true });
// const p2 = await getPricesBySymbols(["SOL","USDT","BONK"], { vsToken: "USDC" });
// const ch = await getPriceChanges(["So11111111111111111111111111111111111111112"], "24h");
