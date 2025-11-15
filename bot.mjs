import "dotenv/config";
import { Telegraf, Markup, session } from "telegraf";
import { Store } from "./store.mjs";
import { recordWalletSnapshot } from "./walletStatistics.mjs";
import { createTradingEngine } from "./tradingEngine.mjs";
import {
  initMongo,
  mongoConfigured,
  mongoIsActive,
  saveSettingsDocument,
  updateTokenAggregates,
  updateWalletAggregate,
  getTradingSummary,
} from "./mongoClient.mjs";
import {
  executeSwapQuote,
  fetchWalletTokens,
  getSwapQuote,
  resolveSymbolToMint,
  toRawAmount,
} from "./features/swapWithJupiter.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;
const SETTINGS_FILE = process.env.SETTINGS_FILE || "./data/settings.json";
const STATISTICS_FILE =
  process.env.STATISTICS_FILE || "./data/wallet-statistics.json";

if (!BOT_TOKEN) {
  console.error("Please set BOT_TOKEN in .env");
  process.exit(1);
}

const store = new Store(SETTINGS_FILE, {
  token: "",
  amount: 0,
  marketCapMinimum: 0,
  profitTargetPercent: 0,
});
await store.load();

const mongoReady = await initMongo();
if (!mongoReady) {
  if (mongoConfigured) {
    console.error(
      "MongoDB connection failed. Telemetry and analytics have been disabled."
    );
  } else {
    console.warn(
      "MongoDB is not configured. Telemetry and analytics will be skipped."
    );
  }
} else {
  await syncSettingsSnapshot("startup");
}

const bot = new Telegraf(BOT_TOKEN);

const tradingEngine = createTradingEngine({
  store,
  notifier: bot.telegram,
  logger: console,
});

bot.use(session());

function getUserContext(ctx) {
  const from = ctx?.from;
  if (!from) return null;
  return {
    id: from.id,
    isBot: from.is_bot ?? undefined,
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null,
    languageCode: from.language_code || null,
  };
}

async function syncSettingsSnapshot(reason, ctx) {
  if (!mongoIsActive()) return;
  try {
    const settings = await store.getAll();
    await saveSettingsDocument(settings, {
      reason,
      user: getUserContext(ctx),
      at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Failed to sync settings to MongoDB:", err);
  }
}

function normalizeTokenForAggregate(token) {
  const symbol =
    token?.symbol || token?.name || (token?.mint ? token.mint.slice(0, 6) : null);
  const uiAmount = Number(token?.uiAmount);
  const valueUsdt = Number(token?.valueUsdt);
  const priceUsdt = Number(token?.priceUsdt);
  return {
    mint: token?.mint || null,
    symbol,
    uiAmount: Number.isFinite(uiAmount) ? uiAmount : null,
    valueUsdt: Number.isFinite(valueUsdt) ? valueUsdt : null,
    priceUsdt: Number.isFinite(priceUsdt) ? priceUsdt : null,
    decimals: Number.isFinite(token?.decimals) ? Number(token.decimals) : null,
  };
}

async function updateWalletFromTokens(tokensRaw, context = {}) {
  if (!mongoIsActive()) return;
  try {
    const normalized = Array.isArray(tokensRaw)
      ? tokensRaw.map((token) => normalizeTokenForAggregate(token))
      : [];
    const totalValue = normalized.reduce((sum, token) => {
      return Number.isFinite(token.valueUsdt) ? sum + token.valueUsdt : sum;
    }, 0);
    await updateWalletAggregate({
      tokens: normalized,
      totalValue,
      context: {
        ...context,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("Failed to update wallet aggregate:", err);
  }
}

async function refreshWalletState(ctx, reason) {
  try {
    const tokensRaw = await fetchWalletTokens({ vsToken: SELL_PRICE_VS });
    await updateWalletFromTokens(tokensRaw, {
      reason,
      user: getUserContext(ctx),
    });
  } catch (err) {
    console.error("Failed to refresh wallet state:", err);
  }
}

async function trackTokenAction(ctx, payload) {
  if (!mongoIsActive()) return;
  if (!payload || !payload.tokenMint) return;
  try {
    const context = {
      ...(payload.context || {}),
      user: getUserContext(ctx),
    };
    await updateTokenAggregates({
      ...payload,
      context,
    });
  } catch (err) {
    console.error("Failed to update token aggregates:", err);
  }
}

function makeKeyboard(settings) {
  const currencyLabel = `Currency: ${settings.token || "not set"}`;
  const profitTargetLabel = `Profit target: ${formatPercent(
    settings.profitTargetPercent
  )}`;
  const amountParts = [`Amount: ${formatTradeAmount(settings.amount)}`];
  if (settings.token) {
    amountParts.push(settings.token);
  }
  const amountLabel = amountParts.join(" ");
  const rows = [
    [Markup.button.callback(currencyLabel, "edit:token")],
    [Markup.button.callback(profitTargetLabel, "edit:profitTargetPercent")],
    [Markup.button.callback(amountLabel, "edit:amount")],
    [Markup.button.callback("⬅️ Back", "settings:back")],
  ];
  return Markup.inlineKeyboard(rows);
}

function makeMainMenuKeyboard() {
  return Markup.keyboard(
    [["Sell", "Buy"], ["Statistics", "Trade-Bot"]],
    { columns: 2 }
  )
    .resize()
    .persistent();
}

function makeTradingMenuKeyboard(isRunning = false) {
  const actionLabel = isRunning ? "Stop trading" : "Start trading";
  return Markup.keyboard([["Configuration"], [actionLabel]])
    .resize()
    .persistent();
}

const SELL_PRICE_VS = "USDT";
const SELL_TARGET_CACHE = {};
const BUY_TARGET_CACHE = {};
const SOL_TARGET_INFO = {
  symbol: "SOL",
  mint: "So11111111111111111111111111111111111111112",
  decimals: 9,
};
SELL_TARGET_CACHE.SOL = SOL_TARGET_INFO;

const usdFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

const amountFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 6,
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatUsd(value) {
  if (!Number.isFinite(value)) return "≈$?";
  return `≈$${usdFormatter.format(value)}`;
}

function formatAmount(value) {
  if (!Number.isFinite(value)) return "?";
  return amountFormatter.format(value);
}

function formatTradeAmount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return amountFormatter.format(0);
  return amountFormatter.format(num);
}

function formatPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0%";
  return `${percentFormatter.format(num)}%`;
}

function formatUsdDetailed(value) {
  if (!Number.isFinite(value)) return "неизвестно";
  if (Math.abs(value) >= 1) return formatUsd(value);
  return `≈$${Number(value).toPrecision(4)}`;
}

function formatDateKey(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return d.toISOString().slice(0, 10);
}

function formatDateHuman(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return new Intl.DateTimeFormat("ru-RU", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatUsdChange(diff) {
  const sign = diff >= 0 ? "+" : "-";
  return `${sign}${formatUsdDetailed(Math.abs(diff))}`;
}

function formatChangeLine({ label, currentValue, referenceEntry }) {
  if (!Number.isFinite(currentValue)) return null;
  if (!referenceEntry || !Number.isFinite(referenceEntry.totalValue)) return null;
  const diff = currentValue - Number(referenceEntry.totalValue);
  const percent =
    Number(referenceEntry.totalValue) !== 0
      ? (diff / Number(referenceEntry.totalValue)) * 100
      : null;
  const parts = [`${label}: ${formatUsdChange(diff)}`];
  if (Number.isFinite(percent)) {
    const sign = diff >= 0 ? "+" : "-";
    parts.push(`(${sign}${Math.abs(percent).toFixed(2)}%)`);
  }
  parts.push(`(с ${formatDateHuman(referenceEntry.date)})`);
  return parts.join(" ");
}

function pickMetaNumber(meta, keys) {
  if (!meta || typeof meta !== "object") return null;
  for (const key of keys) {
    const parts = key.split(".");
    let value = meta;
    for (const part of parts) {
      if (!value || typeof value !== "object") {
        value = undefined;
        break;
      }
      value = value[part];
    }
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function formatTokenMetaInfo({ symbol, meta }) {
  const lines = [];
  const name = meta?.name || meta?.tokenName || null;
  lines.push(
    name ? `Токен: ${symbol} (${name})` : `Токен: ${symbol}`
  );

  const price =
    pickMetaNumber(meta, [
      "price",
      "usdPrice",
      "priceUsd",
      "priceInfo.price",
      "data.price",
    ]) ?? null;
  if (Number.isFinite(price)) {
    lines.push(`Цена: ${formatUsdDetailed(price)}`);
  }

  const liquidity =
    pickMetaNumber(meta, [
      "liquidity",
      "liquidityUsd",
      "liquidityUSD",
      "marketInfo.liquidity",
    ]) ?? null;
  if (Number.isFinite(liquidity)) {
    lines.push(`Ликвидность: ${formatUsdDetailed(liquidity)}`);
  }

  const marketCap =
    pickMetaNumber(meta, [
      "marketCap",
      "market_cap",
      "marketcap",
      "fullyDilutedValue",
    ]) ?? null;
  if (Number.isFinite(marketCap)) {
    lines.push(`Рыночная кап.: ${formatUsdDetailed(marketCap)}`);
  }

  const volume24h =
    pickMetaNumber(meta, [
      "volume24h",
      "volume24hUsd",
      "marketInfo.volume24h",
    ]) ?? null;
  if (Number.isFinite(volume24h)) {
    lines.push(`Объём 24ч: ${formatUsdDetailed(volume24h)}`);
  }

  const change24h =
    pickMetaNumber(meta, [
      "priceChange24h",
      "priceChangePct24h",
      "priceChangePercentage24h",
      "price24hChangePercent",
    ]) ?? null;
  if (Number.isFinite(change24h)) {
    let value = Number(change24h);
    if (Math.abs(value) <= 1) {
      value *= 100;
    }
    const suffix = "%";
    const formatted = value.toFixed(2);
    lines.push(`Изм. 24ч: ${formatted}${suffix}`);
  }

  return lines;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

async function getSellTarget(symbol) {
  const key = symbol.toUpperCase();
  if (SELL_TARGET_CACHE[key]) return SELL_TARGET_CACHE[key];
  const resolved = await resolveSymbolToMint(key);
  const info = { symbol: key, mint: resolved.mint, decimals: resolved.dec };
  SELL_TARGET_CACHE[key] = info;
  return info;
}

async function getBuyTarget(symbol) {
  const key = symbol.toUpperCase();
  if (BUY_TARGET_CACHE[key]) return BUY_TARGET_CACHE[key];
  const resolved = await resolveSymbolToMint(key);
  const info = {
    symbol: resolved.meta?.symbol || key,
    mint: resolved.mint,
    decimals: resolved.dec,
    meta: resolved.meta || {},
  };
  BUY_TARGET_CACHE[key] = info;
  return info;
}

function resetSellFlow(ctx) {
  if (!ctx.session) return;
  ctx.session.sellFlow = null;
}

function resetBuyFlow(ctx) {
  if (!ctx.session) return;
  ctx.session.buyFlow = null;
}

async function handleSellStart(ctx) {
  ctx.session ??= {};
  resetSellFlow(ctx);
  try {
    const tokensRaw = await fetchWalletTokens({ vsToken: SELL_PRICE_VS });
    await updateWalletFromTokens(tokensRaw, {
      reason: "sell:start",
      user: getUserContext(ctx),
    });
    const tokens = tokensRaw.filter((token) =>
      Number.isFinite(token?.priceUsdt)
    );
    if (!tokens.length) {
      await ctx.reply(
        "В кошельке нет токенов с доступной ценой для продажи."
      );
      return;
    }

    const tokenMap = {};
    const rows = tokens.map((token) => {
      const symbol = token.symbol || token.name || token.mint.slice(0, 6);
      const valueLabel = formatUsd(token.valueUsdt);
      tokenMap[token.mint] = { ...token, symbol };
      return Markup.button.callback(
        `${symbol} • ${valueLabel}`,
        `sell:token:${token.mint}`
      );
    });

    ctx.session.sellFlow = {
      stage: "chooseToken",
      tokens: tokenMap,
      priceVs: SELL_PRICE_VS,
    };

    const infoLines = tokens.map((token) => {
      const symbol = token.symbol || token.name || token.mint.slice(0, 6);
      const amount = formatAmount(token.uiAmount);
      const value = formatUsd(token.valueUsdt);
      return `${symbol}: ${amount} (${value})`;
    });

    await ctx.reply(`Баланс кошелька:\n${infoLines.join("\n")}`);

    await ctx.reply(
      "Выберите токен для продажи:",
      Markup.inlineKeyboard(chunk(rows, 1))
    );
  } catch (e) {
    console.error("Sell start error:", e);
    await ctx.reply("Не удалось получить список токенов: " + e.message);
  }
}

async function handleBuyStart(ctx) {
  ctx.session ??= {};
  resetBuyFlow(ctx);
  try {
    ctx.session.buyFlow = {
      stage: "awaiting_symbol",
    };
    await ctx.reply(
      "Введите символ токена, который хотите купить (например, $PEPE)."
    );
  } catch (e) {
    console.error("Buy start error:", e);
    await ctx.reply("Не удалось начать процесс покупки: " + e.message);
  }
}

async function ensureBuyPaymentTokens(flow, ctx) {
  if (flow.paymentTokens) return flow.paymentTokens;
  const tokensRaw = await fetchWalletTokens();
  await updateWalletFromTokens(tokensRaw, {
    reason: "buy:payment-tokens",
    user: getUserContext(ctx),
  });
  const tokenMap = {};
  for (const token of tokensRaw) {
    const symbol = token.symbol || token.name || token.mint.slice(0, 6);
    tokenMap[token.mint] = { ...token, symbol };
  }
  flow.paymentTokens = tokenMap;
  return tokenMap;
}

function makeBuyPaymentKeyboard(flow) {
  const tokens = Object.values(flow.paymentTokens || {});
  if (!tokens.length) return null;
  const rows = tokens.map((token) =>
    Markup.button.callback(
      `${token.symbol} • ${formatAmount(token.uiAmount)}`,
      `buy:pay:${token.mint}`
    )
  );
  rows.push(Markup.button.callback("Отмена", "buy:cancel"));
  return Markup.inlineKeyboard(chunk(rows, 1));
}

function formatBuyQuotePreview(flow) {
  const { quote, paymentToken, targetToken, amountUi } = flow;
  const lines = [
    "Предпросмотр сделки",
    `Отправляете: ${formatAmount(amountUi)} ${paymentToken.symbol}`,
  ];
  const outAmount = quote?.outAmount
    ? Number(quote.outAmount) / 10 ** targetToken.decimals
    : null;
  if (Number.isFinite(outAmount)) {
    lines.push(`Получите ≈ ${formatAmount(outAmount)} ${targetToken.symbol}`);
  }
  const minOut = quote?.otherAmountThreshold
    ? Number(quote.otherAmountThreshold) / 10 ** targetToken.decimals
    : null;
  if (Number.isFinite(minOut)) {
    lines.push(
      `Мин. получение: ${formatAmount(minOut)} ${targetToken.symbol}`
    );
  }
  const priceImpact = quote?.priceImpactPct
    ? Number(quote.priceImpactPct) * 100
    : null;
  if (Number.isFinite(priceImpact)) {
    lines.push(`Просадка: ${priceImpact.toFixed(2)}%`);
  }
  const totalFeesLamports = Number(
    quote?.fees?.totalFeeAndDeposits ?? quote?.fees?.signatureFee ?? 0
  );
  if (Number.isFinite(totalFeesLamports) && totalFeesLamports > 0) {
    const feeSol = totalFeesLamports / 10 ** SOL_TARGET_INFO.decimals;
    lines.push(`Сетевые комиссии: ${feeSol.toFixed(6)} SOL`);
  }
  lines.push("Подтвердите, чтобы выполнить обмен.");
  return lines;
}

async function handleSellCallback(ctx, data) {
  await ctx.answerCbQuery().catch(() => {});
  ctx.session ??= {};
  const flow = ctx.session.sellFlow;
  if (!flow) {
    await ctx.reply("Сессия продажи не активна. Нажмите Sell, чтобы начать заново.");
    return;
  }

  const parts = data.split(":");
  const action = parts[1];
  const payload = parts.slice(2).join(":");

  if (action === "token") {
    const token = flow.tokens?.[payload];
    if (!token) {
      await ctx.reply("Не удалось определить токен. Попробуйте снова начать процесс.");
      return;
    }
    if (!Number.isFinite(token.priceUsdt)) {
      await ctx.reply(
        "Для этого токена нет данных о цене. Повторите попытку позже или выберите другой токен."
      );
      return;
    }
    flow.selectedToken = token;
    flow.stage = "chooseTarget";
    const buttons = [
      Markup.button.callback("Получить SOL", "sell:target:SOL"),
      Markup.button.callback("Получить USDT", "sell:target:USDT"),
      Markup.button.callback("Отмена", "sell:cancel"),
    ];
    await ctx.reply(
      `Токен: ${token.symbol}. Выберите, что получить в обмен:`,
      Markup.inlineKeyboard(chunk(buttons, 1))
    );
    return;
  }

  if (action === "target") {
    if (!flow.selectedToken) {
      await ctx.reply("Сначала выберите токен для продажи.");
      return;
    }
    const targetSymbol = payload.toUpperCase();
    try {
      flow.target = await getSellTarget(targetSymbol);
    } catch (e) {
      await ctx.reply("Не удалось подготовить целевой токен: " + e.message);
      return;
    }
    flow.stage = "awaiting_amount";
    const availableAmount = formatAmount(flow.selectedToken.uiAmount);
    const availableValue = formatUsd(flow.selectedToken.valueUsdt);
    await ctx.reply(
      `Введите количество ${flow.selectedToken.symbol} для обмена (доступно ${availableAmount}, ${availableValue}). Вы можете ввести число или MAX.`
    );
    return;
  }

  if (action === "confirm") {
    if (flow.stage !== "awaiting_confirmation" || !flow.quote) {
      await ctx.reply("Нет данных для подтверждения. Начните заново.");
      return;
    }
    try {
      await ctx.reply("Выполняю обмен, пожалуйста подождите...");
      const sig = await executeSwapQuote(flow.quote);
      await ctx.reply(
        `Сделка выполнена!\nСсылка: https://solscan.io/tx/${sig}`
      );
      const amountUiNumber = Number(flow.amountUi);
      const estimatedValueUsd =
        Number.isFinite(flow.selectedToken?.priceUsdt) &&
        Number.isFinite(amountUiNumber)
          ? Number(flow.selectedToken.priceUsdt) * amountUiNumber
          : null;
      const outAmountUi =
        flow.quote?.outAmount && flow.target?.decimals != null
          ? Number(flow.quote.outAmount) / 10 ** flow.target.decimals
          : null;
      await Promise.allSettled([
        trackTokenAction(ctx, {
          tokenMint: flow.selectedToken?.mint,
          tokenSymbol: flow.selectedToken?.symbol,
          actionType: "sell",
          amountUi: amountUiNumber,
          valueUsd: estimatedValueUsd,
          context: {
            targetMint: flow.target?.mint,
            targetSymbol: flow.target?.symbol,
            transactionSignature: sig,
            amountOutUi: Number.isFinite(outAmountUi) ? outAmountUi : null,
          },
        }),
        refreshWalletState(ctx, "sell:executed"),
      ]);
    } catch (e) {
      console.error("Sell execution error", e);
      await ctx.reply(
        "Не удалось выполнить сделку. Подождите ~30 секунд и попробуйте снова."
      );
      return;
    } finally {
      resetSellFlow(ctx);
    }
    return;
  }

  if (action === "cancel") {
    resetSellFlow(ctx);
    await ctx.reply("Операция продажи отменена.");
    return;
  }

  await ctx.reply("Неизвестное действие. Попробуйте снова начать процесс продажи.");
}

async function handleBuyCallback(ctx, data) {
  await ctx.answerCbQuery().catch(() => {});
  ctx.session ??= {};
  const flow = ctx.session.buyFlow;
  if (!flow) {
    await ctx.reply("Сессия покупки не активна. Нажмите Buy, чтобы начать заново.");
    return;
  }

  const parts = data.split(":");
  const action = parts[1];
  const payload = parts.slice(2).join(":");

  if (action === "pay") {
    if (!flow.targetToken) {
      await ctx.reply("Сначала выберите токен для покупки.");
      return;
    }
    try {
      await ensureBuyPaymentTokens(flow, ctx);
    } catch (e) {
      await ctx.reply("Не удалось загрузить список токенов: " + e.message);
      return;
    }
    const token = flow.paymentTokens?.[payload];
    if (!token) {
      await ctx.reply("Не удалось определить токен оплаты. Попробуйте снова.");
      return;
    }
    flow.paymentToken = token;
    flow.stage = "awaiting_amount";
    const availableAmount = formatAmount(token.uiAmount);
    const availableValue = formatUsd(token.valueUsdt);
    await ctx.reply(
      `Введите количество ${token.symbol} для обмена (доступно ${availableAmount}, ${availableValue}). Вы можете ввести число или MAX.`
    );
    return;
  }

  if (action === "confirm") {
    if (flow.stage !== "awaiting_confirmation" || !flow.quote) {
      await ctx.reply("Нет данных для подтверждения. Начните заново.");
      return;
    }
    try {
      await ctx.reply("Выполняю обмен, пожалуйста подождите...");
      const sig = await executeSwapQuote(flow.quote);
      await ctx.reply(
        `Сделка выполнена!\nСсылка: https://solscan.io/tx/${sig}`
      );
      const paymentAmountUi = Number(flow.amountUi);
      const paymentValueUsd =
        Number.isFinite(flow.paymentToken?.priceUsdt) &&
        Number.isFinite(paymentAmountUi)
          ? Number(flow.paymentToken.priceUsdt) * paymentAmountUi
          : null;
      const receivedAmountUi =
        flow.quote?.outAmount && flow.targetToken?.decimals != null
          ? Number(flow.quote.outAmount) / 10 ** flow.targetToken.decimals
          : null;
      await Promise.allSettled([
        trackTokenAction(ctx, {
          tokenMint: flow.targetToken?.mint,
          tokenSymbol: flow.targetToken?.symbol,
          actionType: "buy",
          amountUi: receivedAmountUi,
          valueUsd: paymentValueUsd,
          context: {
            paymentMint: flow.paymentToken?.mint,
            paymentSymbol: flow.paymentToken?.symbol,
            paymentAmountUi: Number.isFinite(paymentAmountUi)
              ? paymentAmountUi
              : null,
            transactionSignature: sig,
          },
        }),
        trackTokenAction(ctx, {
          tokenMint: flow.paymentToken?.mint,
          tokenSymbol: flow.paymentToken?.symbol,
          actionType: "spend",
          amountUi: paymentAmountUi,
          valueUsd: paymentValueUsd,
          context: {
            targetMint: flow.targetToken?.mint,
            targetSymbol: flow.targetToken?.symbol,
            transactionSignature: sig,
          },
        }),
        refreshWalletState(ctx, "buy:executed"),
      ]);
    } catch (e) {
      console.error("Buy execution error", e);
      await ctx.reply(
        "Не удалось выполнить сделку. Подождите ~30 секунд и попробуйте снова."
      );
      return;
    } finally {
      resetBuyFlow(ctx);
    }
    return;
  }

  if (action === "cancel") {
    resetBuyFlow(ctx);
    await ctx.reply("Операция покупки отменена.");
    return;
  }

  await ctx.reply("Неизвестное действие. Попробуйте снова начать процесс покупки.");
}

async function processBuyMessage(ctx) {
  ctx.session ??= {};
  const flow = ctx.session.buyFlow;
  if (!flow) return false;

  const rawText = ctx.message.text?.trim();
  if (!rawText) {
    await ctx.reply("Введите текстовое значение.");
    return true;
  }

  if (flow.stage === "awaiting_symbol") {
    const symbol = rawText.replace(/^\$/, "").trim();
    if (!symbol) {
      await ctx.reply("Введите символ токена, например PEPE или $PEPE.");
      return true;
    }
    try {
      const target = await getBuyTarget(symbol);
      flow.targetToken = target;
      flow.stage = "choose_payment";

      const infoLines = formatTokenMetaInfo(target);
      await ctx.reply(infoLines.join("\n"));

      await ensureBuyPaymentTokens(flow, ctx);
      const keyboard = makeBuyPaymentKeyboard(flow);
      if (!keyboard) {
        await ctx.reply(
          "Не удалось найти токены в кошельке для оплаты. Пополните баланс и попробуйте снова."
        );
        resetBuyFlow(ctx);
        return true;
      }

      const balanceLines = Object.values(flow.paymentTokens).map((token) => {
        const amount = formatAmount(token.uiAmount);
        const value = formatUsd(token.valueUsdt);
        return `${token.symbol}: ${amount} (${value})`;
      });
      await ctx.reply(`Доступные токены в кошельке:\n${balanceLines.join("\n")}`);
      await ctx.reply("Выберите токен, которым будете платить:", keyboard);
    } catch (e) {
      await ctx.reply("Не удалось получить данные о токене: " + e.message);
    }
    return true;
  }

  if (
    flow.stage === "awaiting_amount" &&
    flow.paymentToken &&
    flow.targetToken
  ) {
    let amountRaw;
    let amountUi;

    if (rawText.toUpperCase() === "MAX") {
      amountRaw = flow.paymentToken.rawAmount;
      amountUi = Number(flow.paymentToken.uiAmount);
    } else {
      const normalized = rawText.replace(",", ".");
      const parsed = Number(normalized);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        await ctx.reply("Введите положительное число или MAX.");
        return true;
      }
      try {
        amountRaw = toRawAmount(parsed, flow.paymentToken.decimals);
      } catch (e) {
        await ctx.reply("Не удалось обработать количество: " + e.message);
        return true;
      }
      amountUi = parsed;
    }

    if (BigInt(amountRaw) > BigInt(flow.paymentToken.rawAmount)) {
      await ctx.reply("Недостаточно токенов на балансе.");
      return true;
    }

    try {
      const quote = await getSwapQuote({
        inputMint: flow.paymentToken.mint,
        outputMint: flow.targetToken.mint,
        amount: amountRaw,
      });
      flow.quote = quote;
      flow.stage = "awaiting_confirmation";
      flow.amountUi = amountUi;
      flow.amountRaw = amountRaw;

      const lines = formatBuyQuotePreview(flow);
      await ctx.reply(lines.join("\n"), {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ OK", "buy:confirm")],
          [Markup.button.callback("✖️ Cancel", "buy:cancel")],
        ]).reply_markup,
      });
    } catch (e) {
      console.error("Buy quote error", e);
      await ctx.reply("Не удалось получить котировку: " + e.message);
    }
    return true;
  }

  return false;
}

async function processSellAmount(ctx) {
  ctx.session ??= {};
  const flow = ctx.session.sellFlow;
  if (
    !flow ||
    flow.stage !== "awaiting_amount" ||
    !flow.selectedToken ||
    !flow.target
  ) {
    return false;
  }

  const rawText = ctx.message.text.trim();
  if (!rawText) {
    await ctx.reply("Введите количество токена или MAX.");
    return true;
  }

  let amountRaw;
  let amountUi;

  if (rawText.toUpperCase() === "MAX") {
    amountRaw = flow.selectedToken.rawAmount;
    amountUi = Number(flow.selectedToken.uiAmount);
  } else {
    const normalized = rawText.replace(",", ".");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      await ctx.reply("Введите положительное число или MAX.");
      return true;
    }
    try {
      amountRaw = toRawAmount(parsed, flow.selectedToken.decimals);
    } catch (e) {
      await ctx.reply("Не удалось обработать количество: " + e.message);
      return true;
    }
    amountUi = parsed;
  }

  if (BigInt(amountRaw) > BigInt(flow.selectedToken.rawAmount)) {
    await ctx.reply("Недостаточно токенов на балансе.");
    return true;
  }

  try {
    const quote = await getSwapQuote({
      inputMint: flow.selectedToken.mint,
      outputMint: flow.target.mint,
      amount: amountRaw,
    });
    flow.quote = quote;
    flow.stage = "awaiting_confirmation";
    flow.amountUi = amountUi;
    flow.amountRaw = amountRaw;

    const outAmount = quote?.outAmount
      ? Number(quote.outAmount) / 10 ** flow.target.decimals
      : null;
    const minOut = quote?.otherAmountThreshold
      ? Number(quote.otherAmountThreshold) / 10 ** flow.target.decimals
      : null;
    const priceImpact = quote?.priceImpactPct
      ? Number(quote.priceImpactPct) * 100
      : null;

    const lines = [
      "Предпросмотр сделки",
      `Отправляете: ${formatAmount(amountUi)} ${flow.selectedToken.symbol}`,
      `Получите ≈ ${formatAmount(outAmount)} ${flow.target.symbol}`,
    ];
    if (Number.isFinite(minOut)) {
      lines.push(
        `Мин. получение: ${formatAmount(minOut)} ${flow.target.symbol}`
      );
    }
    if (Number.isFinite(priceImpact)) {
      lines.push(`Просадка: ${priceImpact.toFixed(2)}%`);
    }
    lines.push("Подтвердите, чтобы выполнить обмен.");

    await ctx.reply(lines.join("\n"), {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("✅ OK", "sell:confirm")],
        [Markup.button.callback("✖️ Cancel", "sell:cancel")],
      ]).reply_markup,
    });
  } catch (e) {
    console.error("Quote error", e);
    await ctx.reply("Не удалось получить котировку: " + e.message);
  }

  return true;
}

function hasSettings(settings) {
  return Boolean(
    settings && typeof settings === "object" && Object.keys(settings).length
  );
}

async function replyWithSettings(ctx) {
  const s = await store.getAll();
  await ctx.reply(
    "⚙️ Настройте трейд-бота: выберите параметр ниже.",
    makeKeyboard(s)
  );
}

const NUMERIC_EDIT_FIELDS = {
  amount: {
    title: "Сумма сделки",
    toDisplay: (value) => String(value ?? 0),
    async persist(raw, ctx) {
      const n = Number(raw || 0);
      await store.setAmount(n);
      await syncSettingsSnapshot("update:amount", ctx);
      return n;
    },
  },
  profitTargetPercent: {
    title: "Цель по прибыли (%)",
    toDisplay: (value) => String(value ?? 0),
    async persist(raw, ctx) {
      const n = Number(raw || 0);
      await store.setProfitTargetPercent(n);
      await syncSettingsSnapshot("update:profitTargetPercent", ctx);
      return n;
    },
  },
};

function makeNumericKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("7", "num:7"),
      Markup.button.callback("8", "num:8"),
      Markup.button.callback("9", "num:9"),
    ],
    [
      Markup.button.callback("4", "num:4"),
      Markup.button.callback("5", "num:5"),
      Markup.button.callback("6", "num:6"),
    ],
    [
      Markup.button.callback("1", "num:1"),
      Markup.button.callback("2", "num:2"),
      Markup.button.callback("3", "num:3"),
    ],
    [
      Markup.button.callback("0", "num:0"),
      Markup.button.callback(".", "num:dot"),
      Markup.button.callback("⬅️", "num:back"),
    ],
    [
      Markup.button.callback("❌", "num:clear"),
      Markup.button.callback("✅ Save", "num:save"),
    ],
    [Markup.button.callback("✖️ Cancel", "num:cancel")],
  ]);
}

function numericPromptText(field, value) {
  const info = NUMERIC_EDIT_FIELDS[field];
  const visible = value === "" ? "0" : value;
  return `*${info.title}*\nТекущее значение: \`${visible}\`\nИспользуйте кнопки ниже.`;
}

async function beginNumericEdit(ctx, field) {
  const info = NUMERIC_EDIT_FIELDS[field];
  const s = await store.getAll();
  const initial = info.toDisplay(s[field]);
  ctx.session ??= {};
  ctx.session.editKey = null;
  ctx.session.numericEdit = {
    field,
    buffer: initial === "0" ? "" : initial,
    messageId: null,
  };
  const res = await ctx.reply(
    numericPromptText(field, ctx.session.numericEdit.buffer),
    {
      parse_mode: "Markdown",
      ...makeNumericKeyboard(),
    }
  );
  ctx.session.numericEdit.messageId = res.message_id;
}

async function handleNumericCallback(ctx, action) {
  await ctx.answerCbQuery().catch(() => {});
  ctx.session ??= {};
  const edit = ctx.session.numericEdit;
  if (!edit) return;
  const message = ctx.callbackQuery.message;
  if (!message || message.message_id !== edit.messageId) return;
  if (action === "cancel") {
    ctx.session.numericEdit = null;
    await ctx.editMessageText("Отменено").catch(() => {});
    return;
  }
  if (action === "clear") {
    edit.buffer = "";
  } else if (action === "back") {
    edit.buffer = edit.buffer.slice(0, -1);
  } else if (action === "dot") {
    if (!edit.buffer.includes(".")) {
      edit.buffer = edit.buffer === "" ? "0." : `${edit.buffer}.`;
    }
  } else if (action === "save") {
    try {
      const info = NUMERIC_EDIT_FIELDS[edit.field];
      const persisted = await info.persist(edit.buffer, ctx);
      ctx.session.numericEdit = null;
      await ctx.editMessageText(`Сохранено: ${info.title} = ${persisted}`, {
        parse_mode: "Markdown",
      });
      await replyWithSettings(ctx);
    } catch (e) {
      await ctx.reply("Error: " + e.message).catch(() => {});
    }
    return;
  } else if (/^\d$/.test(action)) {
    if (edit.buffer === "0") edit.buffer = "";
    edit.buffer = `${edit.buffer}${action}`;
  }

  const nextText = numericPromptText(edit.field, edit.buffer);
  await ctx
    .editMessageText(nextText, {
      parse_mode: "Markdown",
      ...makeNumericKeyboard(),
    })
    .catch(() => {});
}

bot.start(async (ctx) => {
  await ctx.reply(
    "Привет! Используй меню для управления сделками. Нажми *Trade-Bot*, чтобы настроить валюту, цель по прибыли и сумму сделки.",
    {
      parse_mode: "Markdown",
      ...makeMainMenuKeyboard(),
    }
  );
  await replyWithSettings(ctx);
});

bot.command("settings", async (ctx) => {
  await replyWithSettings(ctx);
});

bot.hears("Sell", async (ctx) => {
  await handleSellStart(ctx);
});

bot.hears("Buy", async (ctx) => {
  await handleBuyStart(ctx);
});

bot.hears("Statistics", async (ctx) => {
  try {
    await ctx.sendChatAction?.("typing");
    const tokensRaw = await fetchWalletTokens({ vsToken: SELL_PRICE_VS });
    await updateWalletFromTokens(tokensRaw, {
      reason: "statistics",
      user: getUserContext(ctx),
    });
    if (!tokensRaw.length) {
      await ctx.reply("В кошельке нет токенов для отображения статистики.");
      return;
    }

    const tokens = tokensRaw.map((token) => {
      const uiAmount = Number(token.uiAmount);
      const valueUsdt = Number(token.valueUsdt);
      const priceUsdt = Number(token.priceUsdt);
      return {
        mint: token.mint,
        symbol: token.symbol || token.name || token.mint.slice(0, 6),
        uiAmount: Number.isFinite(uiAmount) ? uiAmount : null,
        valueUsdt: Number.isFinite(valueUsdt) ? valueUsdt : null,
        priceUsdt: Number.isFinite(priceUsdt) ? priceUsdt : null,
        decimals: token.decimals,
      };
    });

    const valuedTokens = tokens.filter((token) =>
      Number.isFinite(token.valueUsdt)
    );

    if (!valuedTokens.length) {
      await ctx.reply(
        "Не удалось определить стоимость токенов. Попробуйте позже."
      );
      return;
    }

    const totalValue = valuedTokens.reduce(
      (sum, token) => sum + Number(token.valueUsdt),
      0
    );

    const { stats } = await recordWalletSnapshot(STATISTICS_FILE, {
      totalValue,
      tokens,
    });

    const now = new Date();
    const todayKey = formatDateKey(now);
    const yesterdayKey = formatDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const weekKey = formatDateKey(
      new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    );

    const prevDayEntry = stats.entries.find((entry) => entry.date === yesterdayKey);
    const prevWeekEntry = stats.entries.find((entry) => entry.date === weekKey);

    const lines = [
      `📊 Статистика кошелька (${formatDateHuman(todayKey)})`,
      `Текущий баланс: ${formatUsdDetailed(totalValue)}`,
    ];

    try {
      const tradingSummary = await getTradingSummary();
      if (tradingSummary) {
        const profitUsd = Number(tradingSummary.totalProfitUsd || 0);
        const profitPercent = Number(tradingSummary.totalProfitPercent || 0);
        const profitUsdText = `${profitUsd >= 0 ? "" : "-"}$${Math.abs(
          profitUsd
        ).toFixed(2)}`;
        const profitPercentText = `${profitPercent >= 0 ? "" : "-"}${Math.abs(
          profitPercent
        ).toFixed(2)}%`;
        lines.push(`trading results: ${profitUsdText} / ${profitPercentText}`);
      }
    } catch (err) {
      console.error("Failed to load trading summary", err);
    }

    const dayLine = formatChangeLine({
      label: "Изменение за 24ч",
      currentValue: totalValue,
      referenceEntry: prevDayEntry,
    });
    if (dayLine) {
      lines.push(dayLine);
    }

    const weekLine = formatChangeLine({
      label: "Изменение за 7д",
      currentValue: totalValue,
      referenceEntry: prevWeekEntry,
    });
    if (weekLine) {
      lines.push(weekLine);
    }

    const tokensSorted = [...tokens].sort((a, b) => {
      const av = Number.isFinite(a.valueUsdt) ? a.valueUsdt : -1;
      const bv = Number.isFinite(b.valueUsdt) ? b.valueUsdt : -1;
      return bv - av;
    });

    if (tokensSorted.length) {
      lines.push("", "Токены:");
      for (const token of tokensSorted) {
        const amountText = Number.isFinite(token.uiAmount)
          ? formatAmount(token.uiAmount)
          : "?";
        const valueText = Number.isFinite(token.valueUsdt)
          ? formatUsdDetailed(token.valueUsdt)
          : "≈$?";
        lines.push(`- ${token.symbol}: ${amountText} (${valueText})`);
      }
    }

    await ctx.reply(lines.join("\n"));
  } catch (e) {
    console.error("Statistics error", e);
    await ctx.reply("Не удалось получить статистику: " + e.message);
  }
});

bot.hears("Trade-Bot", async (ctx) => {
  await ctx.reply(
    "🧠 Trading bot controls:",
    makeTradingMenuKeyboard(tradingEngine.isRunning())
  );
});

bot.hears("Configuration", async (ctx) => {
  await replyWithSettings(ctx);
});

bot.hears("Start trading", async (ctx) => {
  try {
    const chatId = ctx.chat?.id ?? null;
    const result = await tradingEngine.start({ notifyChatId: chatId });
    if (result?.alreadyRunning) {
      await ctx.reply(
        "Trading engine уже запущен.",
        makeTradingMenuKeyboard(tradingEngine.isRunning())
      );
    } else {
      await ctx.reply(
        "Trading engine started ✅",
        makeTradingMenuKeyboard(true)
      );
    }
  } catch (err) {
    console.error("Start trading error", err);
    await ctx.reply(
      "Не удалось запустить трейдинг: " + err.message,
      makeTradingMenuKeyboard(tradingEngine.isRunning())
    );
  }
});

bot.hears("Stop trading", async (ctx) => {
  try {
    if (!tradingEngine.isRunning()) {
      await ctx.reply(
        "Trading engine уже остановлен.",
        makeTradingMenuKeyboard(false)
      );
      return;
    }
    await tradingEngine.stop();
    await ctx.reply(
      "Trading engine stopped ⛔",
      makeTradingMenuKeyboard(false)
    );
  } catch (err) {
    console.error("Stop trading error", err);
    await ctx.reply(
      "Не удалось остановить трейдинг: " + err.message,
      makeTradingMenuKeyboard(tradingEngine.isRunning())
    );
  }
});

bot.command("get", async (ctx) => {
  const s = await store.getAll();
  await ctx.replyWithMarkdown(
    `\- token: \`${s.token}\`\n` +
      `\- amount: \`${s.amount}\`\n` +
      `\- profitTargetPercent: \`${s.profitTargetPercent ?? 0}\`\n` +
      `\- marketCapMinimum: \`${s.marketCapMinimum ?? 0}\``
  );
});

bot.command("set", async (ctx) => {
  try {
    // assertOwner(ctx);
    const [, key, ...rest] = (ctx.message.text || "").split(/\s+/);
    const value = rest.join(" ");
    if (!key || !value)
      return ctx.reply(
        "Use: /set <token|amount|profitTargetPercent|marketCapMinimum> <value>"
      );
    if (key === "token") {
      await store.setToken(value);
      await syncSettingsSnapshot("update:token", ctx);
    } else if (key === "amount") {
      const n = Number(value);
      if (!Number.isFinite(n)) return ctx.reply("amount should be a number");
      await store.setAmount(n);
      await syncSettingsSnapshot("update:amount", ctx);
    } else if (key === "profitTargetPercent") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0)
        return ctx.reply(
          "profitTargetPercent should be a non-negative number"
        );
      await store.setProfitTargetPercent(n);
      await syncSettingsSnapshot("update:profitTargetPercent", ctx);
    } else if (key === "marketCapMinimum") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0)
        return ctx.reply("marketCapMinimum should be a non-negative number");
      await store.setMarketCapMinimum(n);
      await syncSettingsSnapshot("update:marketCapMinimum", ctx);
    } else {
      return ctx.reply(
        "Available keys: token, amount, profitTargetPercent, marketCapMinimum"
      );
    }
    await ctx.reply("Saved ✅");
    await replyWithSettings(ctx);
  } catch (e) {
    await ctx.reply("Ошибка: " + e.message);
  }
});

bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data || "";
    if (data === "settings:back") {
      await ctx.answerCbQuery();
      try {
        await ctx.editMessageReplyMarkup();
      } catch (err) {
        if (err?.response?.error_code !== 400) {
          console.warn("Failed to clear settings keyboard:", err);
        }
      }
      await ctx.reply(
        "🧠 Trading bot controls:",
        makeTradingMenuKeyboard(tradingEngine.isRunning())
      );
      return;
    }
    if (data.startsWith("sell:")) {
      await handleSellCallback(ctx, data);
      return;
    }
    if (data.startsWith("buy:")) {
      await handleBuyCallback(ctx, data);
      return;
    }
    if (data.startsWith("num:")) {
      await handleNumericCallback(ctx, data.slice(4));
      return;
    }
    if (!data.startsWith("edit:")) return;
    const key = data.split(":")[1];
    if (NUMERIC_EDIT_FIELDS[key]) {
      await ctx.answerCbQuery();
      await beginNumericEdit(ctx, key);
      return;
    }
    if (key === "token") {
      ctx.session ??= {};
      ctx.session.editKey = key;
      await ctx.answerCbQuery();
      await ctx.reply(`Insert value for \`${key}\`:`, {
        parse_mode: "Markdown",
      });
      return;
    }
    await ctx.answerCbQuery("Unknown field", { show_alert: true });
  } catch (e) {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("Error: " + e.message);
  }
});

bot.on("message", async (ctx, next) => {
  if (!("text" in ctx.message)) return next();
  ctx.session ??= {};
  if (await processBuyMessage(ctx)) {
    return;
  }
  if (await processSellAmount(ctx)) {
    return;
  }
  const key = ctx.session.editKey;
  if (!key) return next();
  try {
    const raw = ctx.message.text.trim();
    if (key === "token") {
      await store.setToken(raw);
      await syncSettingsSnapshot("update:token", ctx);
    }
    ctx.session.editKey = null;
    await ctx.reply("Saved ✅");
    await replyWithSettings(ctx);
  } catch (e) {
    await ctx.reply("Error: " + e.message + "\n Try again or use /settings");
  }
});

bot.use(async (ctx, next) => {
  ctx.session ??= {};
  return next();
});

bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  ctx.reply("Unexpected error: " + err.message).catch(() => {});
});

bot.launch();
console.log("Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
