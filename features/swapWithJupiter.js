// ESM: "type": "module" в package.json
import axios from "axios";
import https from "node:https";
import bs58 from "bs58";
import { setDefaultResultOrder } from "node:dns";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";

setDefaultResultOrder?.("ipv4first");

const {
  RPC_URL,
  JUPITER_HOST,
  JUPITER_IP,
  WALLET_SECRET_KEY,
  SLIPPAGE_BBS,
  PRIORITY_MAX_LAMPORTS,
} = process.env;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;
const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

let __connection;
let __wallet;
let __jax;

function ensureConnection() {
  if (!RPC_URL) throw new Error("RPC_URL is not configured");
  if (!__connection) {
    __connection = new Connection(RPC_URL, { commitment: "confirmed" });
  }
  return __connection;
}

function ensureWallet() {
  if (!WALLET_SECRET_KEY) throw new Error("WALLET_SECRET_KEY is not configured");
  if (!__wallet) {
    __wallet = keypairFromAny(WALLET_SECRET_KEY);
  }
  return __wallet;
}

function ensureJax() {
  if (!__jax) {
    __jax = createJupClient({
      host: JUPITER_HOST || "quote-api.jup.ag",
      ip: JUPITER_IP,
    });
  }
  return __jax;
}

function getDefaultSlippageBps() {
  const fallback = 50;
  if (!SLIPPAGE_BBS) return fallback;
  const parsed = Number(SLIPPAGE_BBS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPriorityFeeLamports() {
  const fallback = 200_000;
  if (!PRIORITY_MAX_LAMPORTS) return fallback;
  const parsed = Number(PRIORITY_MAX_LAMPORTS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

async function fetchTokenMetadataMap(mints) {
  const uniqueMints = Array.from(
    new Set((mints || []).filter((mint) => typeof mint === "string" && mint))
  );
  if (!uniqueMints.length) return {};

  const out = {};

  await Promise.allSettled(
    uniqueMints.map(async (mint) => {
      try {
        const { data } = await TOKENS_AX.get("/tokens/v2/search", {
          params: { query: mint },
        });
        const match = (data || []).find((entry) => entry.id === mint);
        if (match) out[mint] = match;
      } catch (err) {
        console.warn("Failed to fetch token metadata", mint, err?.message || err);
      }
    })
  );

  return out;
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
const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function formatNumber(value) {
  return Number.isFinite(value)
    ? numberFormatter.format(value)
    : "unknown";
}

function pickPriceValue(info) {
  if (!info || typeof info !== "object") return null;
  const candidates = [
    info.price,
    info.priceUsd,
    info.usd,
    info.value,
    info.priceInfo?.price,
    info.data?.price,
  ];
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

export async function swapOneSolToCoinLiteral(
  coinLiteral,
  amountC,
  literl,
  marketCapMinimum
) {
  if (!amountC || !literl) {
    return {
      status: "error",
      text: "Complete configuration",
    };
  }
  try {
    const conn = ensureConnection();
    const wallet = ensureWallet();

    // HTTP клиент для Jupiter v6
    const JAX = ensureJax();

    // 1) mint по символу
    const outSym = normalizeLiteral(coinLiteral); // "$BONK" -> "BONK"
    const list = await jupSearchSymbol(outSym);
    let chosen = pickExactSymbolPreferVerified(list, outSym);
    let outputMint = chosen.id;
    const minMarketCap = Number(marketCapMinimum) || 0;
    const tokenMarketCap = Number(
      chosen.marketCap ?? chosen.market_cap ?? chosen.marketcap ?? 0
    );
    if (minMarketCap > 0) {
      if (!Number.isFinite(tokenMarketCap) || tokenMarketCap < minMarketCap) {
        return {
          status: "skipped",
          text: `Skipped ${outSym}: market cap ${formatNumber(
            tokenMarketCap
          )} < minimum ${formatNumber(minMarketCap)}`,
          marketCap: Number.isFinite(tokenMarketCap) ? tokenMarketCap : null,
          marketCapFormatted: Number.isFinite(tokenMarketCap)
            ? formatNumber(tokenMarketCap)
            : null,
          marketCapMinimum: minMarketCap,
        };
      }
    }
    const inToken = await resolveMintBySymbol(literl); // ← резолвим USDT
    const uiAmount = amountC; // ← 10 USDT
    const amount = toRawAmount(uiAmount, inToken.dec); // 10 * 10^6 -> "10000000"

    const params = {
      inputMint: inToken.mint,
      outputMint,
      amount,
      slippageBps: getDefaultSlippageBps(),
      swapMode: "ExactIn",
    };

    const { data: quoteRaw } = await JAX.get("/v6/quote", { params });

    const sig = await buildSignSendSwap({
      jax: JAX,
      q: quoteRaw,
      conn,
      wallet,
      priorityMaxLamports: getPriorityFeeLamports(),
    });

    const solcanLink = `https://solscan.io/tx/${sig}`;

    const hasMarketCap = Number.isFinite(tokenMarketCap);
    return {
      status: "success",
      text: solcanLink,
      marketCap: hasMarketCap ? tokenMarketCap : null,
      marketCapFormatted: hasMarketCap ? formatNumber(tokenMarketCap) : null,
    };
  } catch (error) {
    console.log("ERROR", error);
    return { status: "error", text: "Error: " + error.message };
  }
}

export async function resolveSymbolToMint(symbol) {
  return resolveMintBySymbol(symbol);
}

export async function fetchWalletTokens({ vsToken = "USDT" } = {}) {
  const conn = ensureConnection();
  const wallet = ensureWallet();

  const [solLamports, tokenAccounts] = await Promise.all([
    conn.getBalance(wallet.publicKey, "confirmed"),
    conn.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: SPL_TOKEN_PROGRAM_ID,
    }),
  ]);

  const tokens = [];

  if (solLamports > 0) {
    const solUi = solLamports / 10 ** SOL_DECIMALS;
    tokens.push({
      mint: SOL_MINT,
      decimals: SOL_DECIMALS,
      rawAmount: solLamports.toString(),
      uiAmount: solUi,
      uiAmountString: solUi.toString(),
      source: "sol",
    });
  }

  for (const acc of tokenAccounts.value || []) {
    const parsed = acc.account?.data?.parsed;
    const info = parsed?.info;
    const tokenAmount = info?.tokenAmount;
    if (!info || !tokenAmount) continue;
    const rawAmount = tokenAmount.amount;
    if (!rawAmount || rawAmount === "0") continue;
    const decimals = Number(tokenAmount.decimals ?? 0);
    const uiAmountString = tokenAmount.uiAmountString || String(tokenAmount.uiAmount || 0);
    const uiAmount = Number(uiAmountString);
    if (!Number.isFinite(uiAmount) || uiAmount <= 0) continue;
    tokens.push({
      mint: info.mint,
      decimals,
      rawAmount,
      uiAmount,
      uiAmountString,
      source: "spl",
    });
  }

  if (!tokens.length) return [];

  const aggregated = new Map();
  for (const token of tokens) {
    const key = token.mint;
    const existing = aggregated.get(key);
    if (!existing) {
      aggregated.set(key, { ...token });
      continue;
    }
    existing.rawAmount = (
      BigInt(existing.rawAmount) + BigInt(token.rawAmount)
    ).toString();
    existing.uiAmount = Number(existing.uiAmount) + Number(token.uiAmount);
    existing.uiAmountString = (
      Number(existing.uiAmountString) + Number(token.uiAmount)
    ).toString();
  }

  const consolidated = Array.from(aggregated.values());

  let priceByMint = {};
  const fallbackVsTokens = [];
  if (vsToken && vsToken.toUpperCase() !== "USDC") {
    fallbackVsTokens.push("USDC");
  }
  fallbackVsTokens.push(null);

  try {
    priceByMint = await getPricesByMint(consolidated.map((t) => t.mint), {
      vsToken,
      fallbackVsTokens,
    });
  } catch (e) {
    console.warn("Failed to load prices:", e.message);
  }

  let metaByMint = {};
  try {
    metaByMint = await fetchTokenMetadataMap(consolidated.map((t) => t.mint));
  } catch (e) {
    console.warn("Failed to load token metadata:", e.message);
  }

  const enriched = consolidated.map((token) => {
    const price = priceByMint[token.mint] || null;
    const priceUsdt = pickPriceValue(price);
    const valueUsdt =
      priceUsdt != null && Number.isFinite(priceUsdt)
        ? priceUsdt * Number(token.uiAmount)
        : null;
    const meta = metaByMint[token.mint] || {};
    return {
      ...token,
      symbol:
        meta.symbol ||
        price?.symbol ||
        (token.mint === SOL_MINT ? "SOL" : token.mint.slice(0, 6)),
      name: meta.name || price?.name || null,
      priceUsdt,
      valueUsdt,
    };
  });

  enriched.sort((a, b) => {
    const va = Number.isFinite(a.valueUsdt) ? a.valueUsdt : -1;
    const vb = Number.isFinite(b.valueUsdt) ? b.valueUsdt : -1;
    return vb - va;
  });

  return enriched;
}

export async function getSwapQuote({
  inputMint,
  outputMint,
  amount,
  slippageBps,
  swapMode = "ExactIn",
}) {
  const jax = ensureJax();
  const params = {
    inputMint,
    outputMint,
    amount,
    swapMode,
    slippageBps: slippageBps ?? getDefaultSlippageBps(),
  };
  try {
    const { data } = await jax.get("/v6/quote", { params });
    return data;
  } catch (err) {
    const { response } = err || {};
    const payload = response?.data || {};
    const code = payload.errorCode || payload.code;
    const rawMessage =
      payload.error || payload.message || response?.statusText || err?.message;

    if (code === "COULD_NOT_FIND_ANY_ROUTE") {
      throw new Error(
        "Jupiter не нашёл маршрут для этого обмена. Попробуйте уменьшить сумму или выбрать другую пару."
      );
    }

    if (rawMessage) {
      throw new Error(rawMessage);
    }

    throw err;
  }
}

export async function executeSwapQuote(quoteResponse, opt = {}) {
  if (!quoteResponse) throw new Error("quoteResponse is required");
  const conn = ensureConnection();
  const wallet = ensureWallet();
  const jax = ensureJax();
  return buildSignSendSwap({
    jax,
    q: quoteResponse,
    conn,
    wallet,
    priorityMaxLamports: opt.priorityMaxLamports ?? getPriorityFeeLamports(),
  });
}

export { toRawAmount };

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

const { PRICE_HOST = "price.jup.ag", PRICE_IP: PRICE_IP_ENV } = process.env;
const PRICE_IP = PRICE_IP_ENV || JUPITER_IP || undefined;

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
  const ids = Array.isArray(mintOrMints) ? mintOrMints : [mintOrMints];
  if (!ids.length) return {};

  const fallbackVsTokens = Array.isArray(opt.fallbackVsTokens)
    ? opt.fallbackVsTokens
    : [];

  const priceClients = PRICE_IP
    ? [
        { client: __createPriceClient({ host: PRICE_HOST, ip: PRICE_IP }), tag: "ip" },
        { client: __createPriceClient({ host: PRICE_HOST, ip: undefined }), tag: "host" },
      ]
    : [{ client: __createPriceClient({ host: PRICE_HOST, ip: undefined }), tag: "host" }];

  async function requestWithPriceClients(run, label) {
    let lastErr;
    for (let idx = 0; idx < priceClients.length; idx += 1) {
      const { client, tag } = priceClients[idx];
      try {
        return await run(client);
      } catch (err) {
        lastErr = err;
        const status = err?.response?.status;
        const retriable =
          !err?.response ||
          status === 0 ||
          status === 408 ||
          status === 425 ||
          status === 429 ||
          (status >= 500 && status < 600);
        const isLast = idx === priceClients.length - 1;
        if (!retriable || isLast) {
          throw err;
        }
        console.warn(
          `${label} failed on price client (${tag}); retrying with fallback:`,
          err?.message || err
        );
      }
    }
    throw lastErr;
  }

  async function fetchForVsToken(vsTokenSymbolOrMint) {
    if (!vsTokenSymbolOrMint) {
      const { data } = await requestWithPriceClients(
        (client) =>
          client.get("/v3/price", {
            params: { ids: ids.join(",") },
          }),
        "Primary price fetch"
      );
      return data?.data || {};
    }

    let vsTokenId = vsTokenSymbolOrMint;
    if (vsTokenId.length < 32) {
      try {
        const resolved = await __resolveMintBySymbol(vsTokenId);
        vsTokenId = resolved.mint;
      } catch {
        // если не получилось резолвнуть символ — пробуем как есть
      }
    }

    const { data } = await requestWithPriceClients(
      (client) =>
        client.get("/v3/price", {
          params: {
            ids: ids.join(","),
            vsToken: vsTokenId,
            ...(opt.vsAmount ? { vsAmount: opt.vsAmount } : {}),
            ...(opt.onlyVsToken ? { onlyVsToken: true } : {}),
          },
        }),
      `Fallback price fetch for ${vsTokenSymbolOrMint}`
    );

    return data?.data || {};
  }

  let priceMap = {};
  try {
    priceMap = await fetchForVsToken(opt.vsToken || "USDC");
  } catch (err) {
    console.warn("Primary price fetch failed:", err?.message || err);
  }

  let missing = ids.filter((id) => !priceMap[id]);
  if (missing.length && fallbackVsTokens.length) {
    for (const fallbackVs of fallbackVsTokens) {
      try {
        const extra = await fetchForVsToken(fallbackVs);
        for (const id of missing) {
          if (extra[id] && !priceMap[id]) {
            priceMap[id] = extra[id];
          }
        }
        missing = missing.filter((id) => !priceMap[id]);
        if (!missing.length) break;
      } catch (err) {
        console.warn(
          "Fallback price fetch failed for",
          fallbackVs,
          err?.message || err
        );
      }
    }
  }

  return priceMap;
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
