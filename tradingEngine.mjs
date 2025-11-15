import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/index.js";
import { NewMessage } from "telegram/events/index.js";
import {
  swapOneSolToCoinLiteral,
  fetchWalletTokens,
  getSwapQuote,
  executeSwapQuote,
} from "./features/swapWithJupiter.js";
import {
  loadTradingState,
  saveTradingState,
  mongoIsActive,
} from "./mongoClient.mjs";

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION || "");
const joinTarget = process.env.JOIN_TARGET;
const outboundChat = process.env.TELEGRAM_CHAT_ID || "";
const monitorIntervalMs =
  Number(process.env.TRADING_MONITOR_INTERVAL_MS) || 60_000;

function sanitize(text = "") {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u00A0\u202F\u2009]/g, " ")
    .normalize("NFKC");
}

function getText(message) {
  return sanitize(message?.message || "");
}

function getHeaderLine(text) {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines[0] || "";
}

function hasNewTrending(text) {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const head2 = (lines[0] || "") + " | " + (lines[1] || "");
  return /new\s+trending/i.test(head2);
}

function extractTickerFromDev(text) {
  const lines = text.split("\n");
  const devLine = lines.find((l) => /(^|[\s\W])dev\s*[:：]/i.test(l));
  if (!devLine) return null;
  const m = devLine.match(/\$[A-Z][A-Z0-9]{1,11}\b/);
  return m ? m[0] : null;
}

function extractTicker(text) {
  const m = text.match(/\$[A-Z0-9]{2,12}\b/);
  return m ? m[0] : null;
}

function parseTMeLink(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("@")) return { type: "username", value: s.slice(1) };
  if (/^https?:\/\/t\.me\/\+?[A-Za-z0-9_/-]+$/i.test(s)) {
    const tail = s.replace(/^https?:\/\/t\.me\//i, "");
    const inv = tail.match(/^(?:\+|joinchat\/)([A-Za-z0-9_-]+)$/);
    if (inv) return { type: "invite", value: inv[1] };
    return { type: "username", value: tail.split("/")[0] };
  }
  if (/^[A-Za-z0-9_]{5,}$/.test(s)) return { type: "username", value: s };
  return null;
}

async function joinTargetChat(client, target) {
  const parsed = parseTMeLink(target);
  if (!parsed) return;
  if (parsed.type === "username") {
    const entity = await client.getEntity(parsed.value);
    return client.invoke(new Api.channels.JoinChannel({ channel: entity }));
  }
  return client.invoke(
    new Api.messages.ImportChatInvite({ hash: parsed.value })
  );
}

async function tryExportMsgLink(client, chat, msgId) {
  try {
    const res = await client.invoke(
      new Api.channels.ExportMessageLink({
        channel: chat,
        id: msgId,
        grouped: false,
        thread: false,
      })
    );
    return res?.link || null;
  } catch {
    return null;
  }
}

async function sendOutbound(client, text) {
  if (!outboundChat || !client) return;
  const target = outboundChat.startsWith("@")
    ? outboundChat
    : outboundChat.match(/^-?\d+$/)
    ? BigInt(outboundChat)
    : outboundChat;
  await client.sendMessage(target, { message: text });
}

const DEFAULT_SUMMARY = Object.freeze({
  totalInvestedUsd: 0,
  totalReturnedUsd: 0,
  totalProfitUsd: 0,
  totalProfitPercent: 0,
  totalClosedTrades: 0,
  totalOpenPositions: 0,
  lastUpdatedAt: null,
  lastUpdateReason: null,
});

const MAX_HISTORY = 100;

function toSafeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function mergePosition(existing, patch) {
  if (!existing) return { ...patch };
  const next = { ...existing };
  if (patch.amountRaw != null) {
    try {
      next.amountRaw = (
        BigInt(existing.amountRaw || "0") + BigInt(patch.amountRaw)
      ).toString();
    } catch {
      next.amountRaw = patch.amountRaw;
    }
  }
  if (patch.amountUi != null && Number.isFinite(patch.amountUi)) {
    const current = Number(existing.amountUi || 0);
    next.amountUi = current + Number(patch.amountUi);
  }
  if (patch.costBaseAmount != null && Number.isFinite(patch.costBaseAmount)) {
    const current = Number(existing.costBaseAmount || 0);
    next.costBaseAmount = current + Number(patch.costBaseAmount);
    next.costUsd = next.costBaseAmount; // base assumed USD
  }
  next.lastUpdatedAt = new Date().toISOString();
  if (patch.marketCap != null) next.marketCap = patch.marketCap;
  if (patch.transactionSignature) {
    next.lastBuySignature = patch.transactionSignature;
  }
  if (patch.targetProfitPercent != null) {
    next.targetProfitPercent = Number(patch.targetProfitPercent) || 0;
  }
  return next;
}

function createSummaryFromDoc(doc) {
  if (!doc || typeof doc !== "object") return { ...DEFAULT_SUMMARY };
  const base = { ...DEFAULT_SUMMARY };
  return {
    ...base,
    ...doc,
    totalInvestedUsd: Number(doc.totalInvestedUsd || 0),
    totalReturnedUsd: Number(doc.totalReturnedUsd || 0),
    totalProfitUsd: Number(doc.totalProfitUsd || 0),
    totalProfitPercent: Number(doc.totalProfitPercent || 0),
    totalClosedTrades: Number(doc.totalClosedTrades || 0),
    totalOpenPositions: Number(doc.totalOpenPositions || 0),
  };
}

export function createTradingEngine({ store, notifier, logger } = {}) {
  const safeStore = store || {
    async getAll() {
      return {};
    },
  };
  const log = logger && typeof logger.log === "function" ? logger : console;
  const notifyInterface = notifier || null;

  let client = null;
  let running = false;
  let monitorTimer = null;
  let monitorPromise = null;
  let handler = null;
  let eventBuilder = null;

  let positions = new Map();
  let history = [];
  let summary = { ...DEFAULT_SUMMARY };

  const notifyChatIds = new Set();

  function addHistory(event) {
    if (!event) return;
    history.push({ ...event, at: new Date().toISOString() });
    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }
  }

  async function persistState(reason) {
    summary.lastUpdateReason = reason || summary.lastUpdateReason || null;
    summary.lastUpdatedAt = new Date().toISOString();
    summary.totalProfitUsd =
      Number(summary.totalReturnedUsd || 0) -
      Number(summary.totalInvestedUsd || 0);
    summary.totalProfitPercent =
      summary.totalInvestedUsd > 0
        ? (summary.totalProfitUsd / summary.totalInvestedUsd) * 100
        : 0;
    summary.totalOpenPositions = positions.size;
    if (!mongoIsActive()) return;
    try {
      await saveTradingState({
        positions: Array.from(positions.values()),
        history,
        summary,
      });
    } catch (err) {
      log.error?.("Failed to persist trading state", err);
    }
  }

  async function notifyAll(message) {
    if (!message) return;
    const tasks = [];
    for (const chatId of notifyChatIds) {
      if (notifyInterface?.sendMessage) {
        tasks.push(
          notifyInterface.sendMessage(chatId, message).catch(() => undefined)
        );
      }
    }
    if (tasks.length) {
      await Promise.allSettled(tasks);
    }
  }

  async function handleBuySuccess({
    ticker,
    swapResult,
    header,
    chat,
    msg,
  }) {
    const now = new Date().toISOString();
    const mint = swapResult.purchasedMint || null;
    const amountRaw = swapResult.purchasedAmountRaw || null;
    const amountUi = toSafeNumber(swapResult.purchasedAmountUi);
    const costBaseAmount = toSafeNumber(swapResult.spentAmountUi);
    const marketCap = swapResult.marketCap ?? null;
    const settings = await safeStore.getAll();
    const targetProfitPercent = Number(settings?.profitTargetPercent || 0);

    if (mint && amountRaw) {
      const existing = positions.get(mint);
      const next = mergePosition(existing, {
        mint,
        symbol: swapResult.purchasedSymbol || ticker,
        amountRaw,
        amountUi,
        baseMint: swapResult.baseMint || settings?.tokenMint || null,
        baseSymbol: swapResult.baseSymbol || settings?.token || null,
        baseDecimals: swapResult.baseDecimals ?? null,
        costBaseAmount,
        marketCap,
        transactionSignature: swapResult.transactionSignature || null,
        targetProfitPercent,
      });
      if (!existing) {
        next.createdAt = now;
      }
      next.lastUpdatedAt = now;
      next.costUsd = Number(next.costBaseAmount || 0);
      positions.set(mint, next);
    }

    addHistory({
      type: "buy",
      mint,
      symbol: swapResult.purchasedSymbol || ticker,
      amountUi,
      costUsd: costBaseAmount ?? null,
      marketCap,
      transactionSignature: swapResult.transactionSignature || null,
    });

    await persistState("buy");

    const parts = [
      `• Bought: \`${ticker}\``,
    ];
    if (swapResult.marketCapFormatted) {
      parts.push(`Market cap: ${swapResult.marketCapFormatted}`);
    }
    if (swapResult.text) {
      parts.push(`Link: ${swapResult.text}`);
    }
    await notifyAll(parts.join("\n"));

    if (client) {
      const link = await tryExportMsgLink(client, chat, msg.id);
      const outbound =
        `• Bought: \`${ticker}\`\n` +
        (header ? `Header: ${header}\n` : "") +
        (link ? `Source: ${link}\n` : "") +
        (swapResult.text ? `Tx: ${swapResult.text}` : "");
      await sendOutbound(client, outbound.trim());
    }
  }

  async function handleSellPosition({ position, walletToken, baseToken }) {
    try {
      const rawAmount = walletToken?.rawAmount || position.amountRaw;
      if (!rawAmount) return false;
      if (!position.baseMint) return false;
      const quote = await getSwapQuote({
        inputMint: position.mint,
        outputMint: position.baseMint,
        amount: rawAmount,
      });
      const signature = await executeSwapQuote(quote);
      const outRaw = quote?.outAmount || null;
      const baseDecimals =
        baseToken?.decimals ?? position.baseDecimals ?? 0;
      const outUi =
        outRaw && baseDecimals != null
          ? Number(outRaw) / 10 ** Number(baseDecimals)
          : null;
      const costBaseAmount = Number(position.costBaseAmount || 0);
      const receivedBaseAmount = Number.isFinite(outUi) ? outUi : null;
      const profitBase =
        receivedBaseAmount != null ? receivedBaseAmount - costBaseAmount : null;
      const profitPercent =
        profitBase != null && costBaseAmount > 0
          ? (profitBase / costBaseAmount) * 100
          : null;

      positions.delete(position.mint);

      summary.totalClosedTrades += 1;
      if (costBaseAmount > 0) {
        summary.totalInvestedUsd += costBaseAmount;
      }
      if (receivedBaseAmount != null) {
        summary.totalReturnedUsd += receivedBaseAmount;
      }

      addHistory({
        type: "sell",
        mint: position.mint,
        symbol: position.symbol,
        costUsd: costBaseAmount,
        receivedUsd: receivedBaseAmount,
        profitUsd: profitBase,
        profitPercent,
        buySignature: position.lastBuySignature || null,
        sellSignature: signature,
      });

      await persistState("sell");

      const lines = [
        `• Sold: ${position.symbol || position.mint}`,
        `Tx: https://solscan.io/tx/${signature}`,
      ];
      if (profitBase != null) {
        const sign = profitBase >= 0 ? "+" : "-";
        const abs = Math.abs(profitBase).toFixed(4);
        lines.push(`Profit: ${sign}$${abs}`);
      }
      if (profitPercent != null) {
        const sign = profitPercent >= 0 ? "+" : "-";
        lines.push(`Δ: ${sign}${Math.abs(profitPercent).toFixed(2)}%`);
      }
      await notifyAll(lines.join("\n"));
      if (client) {
        await sendOutbound(client, lines.join("\n"));
      }
      return true;
    } catch (err) {
      log.error?.("Failed to execute auto sell", err);
      return false;
    }
  }

  async function monitorPositions() {
    if (!positions.size) return;
    if (monitorPromise) return monitorPromise;
    monitorPromise = (async () => {
      try {
        const settings = await safeStore.getAll();
        const profitTarget = Number(settings?.profitTargetPercent || 0);
        if (!profitTarget || profitTarget <= 0) return;
        const tokens = await fetchWalletTokens({ vsToken: settings.token });
        for (const position of positions.values()) {
          const token = tokens.find((t) => t.mint === position.mint);
          if (!token) continue;
          const baseToken = tokens.find((t) => t.mint === position.baseMint);
          const currentValue = Number(token.valueUsdt);
          const cost = Number(position.costUsd);
          if (!Number.isFinite(cost) || cost <= 0) continue;
          if (!Number.isFinite(currentValue)) continue;
          const profit = currentValue - cost;
          const profitPercent = (profit / cost) * 100;
          if (profitPercent >= profitTarget) {
            await handleSellPosition({
              position,
              walletToken: token,
              baseToken,
            });
          }
        }
      } catch (err) {
        log.error?.("Trading monitor error", err);
      }
    })()
      .catch((err) => log.error?.("Monitor failure", err))
      .finally(() => {
        monitorPromise = null;
      });
    return monitorPromise;
  }

  async function handleEvent(event) {
    try {
      const msg = event.message;
      if (!msg) return;
      const inputPeer = await client.getInputEntity(msg.peerId);
      const chat = await client.getEntity(inputPeer);
      if (!/Chat|Channel/.test(chat.className || "")) return;
      const txt = getText(msg);
      if (!txt) return;
      if (!hasNewTrending(txt)) return;
      let ticker = extractTickerFromDev(txt) || extractTicker(txt);
      if (!ticker) return;
      const settings = await safeStore.getAll();
      const amount = Number(settings?.amount);
      const token = settings?.token;
      if (!amount || amount <= 0 || !token) {
        await notifyAll(
          `Skipping signal ${ticker}: configure token and amount first.`
        );
        return;
      }
      const swapResult = await swapOneSolToCoinLiteral(
        ticker,
        amount,
        token,
        settings?.marketCapMinimum
      );
      if (swapResult.status !== "success") {
        const message =
          swapResult.text || `Swap ${swapResult.status} for ${ticker}`;
        await notifyAll(message);
        return;
      }
      const header = getHeaderLine(txt);
      await handleBuySuccess({
        ticker,
        swapResult,
        header,
        chat,
        msg,
      });
    } catch (err) {
      log.error?.("Trading handler error", err);
    }
  }

  async function start({ notifyChatId } = {}) {
    if (notifyChatId != null) {
      notifyChatIds.add(notifyChatId);
    }
    if (running) {
      return { alreadyRunning: true };
    }
    if (!apiId || !apiHash || !process.env.SESSION) {
      throw new Error("Trading client is not configured");
    }

    if (mongoIsActive()) {
      try {
        const doc = await loadTradingState();
        if (doc) {
          positions = new Map(
            (doc.positions || []).map((entry) => [entry.mint, { ...entry }])
          );
          history = Array.isArray(doc.history) ? [...doc.history] : [];
          summary = createSummaryFromDoc(doc.summary);
        } else {
          positions = new Map();
          history = [];
          summary = { ...DEFAULT_SUMMARY };
        }
      } catch (err) {
        log.error?.("Failed to load trading state", err);
        positions = new Map();
        history = [];
        summary = { ...DEFAULT_SUMMARY };
      }
    } else {
      positions = new Map();
      history = [];
      summary = { ...DEFAULT_SUMMARY };
    }

    client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });
    await client.start({
      phoneNumber: () => Promise.resolve(process.env.PHONE || ""),
      password: () => Promise.resolve(process.env.PASSWORD || ""),
      phoneCode: async () => {
        throw new Error(
          "Первый вход сделай интерактивно, получи SESSION и сохрани его в .env"
        );
      },
      onError: (e) => log.error?.(e),
    });

    log.log?.(
      "SESSION:\n",
      client.session.save(),
      "\n— положи в .env как SESSION."
    );

    if (joinTarget) {
      try {
        await joinTargetChat(client, joinTarget);
      } catch (e) {
        log.error?.("Join error:", e.message);
      }
    }

    await client.getDialogs({}).catch(() => undefined);

    eventBuilder = new NewMessage({});
    handler = (event) => {
      handleEvent(event).catch((err) => log.error?.("Handler failure", err));
    };
    client.addEventHandler(handler, eventBuilder);

    monitorTimer = setInterval(() => {
      monitorPositions();
    }, monitorIntervalMs);

    running = true;
    log.log?.("Trading engine started. Listening for new messages…");
    await notifyAll("Trading engine started");
    return { started: true };
  }

  async function stop() {
    if (!running) return;
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
    if (handler && client) {
      try {
        client.removeEventHandler(handler, eventBuilder);
      } catch {
        // ignore
      }
    }
    handler = null;
    eventBuilder = null;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
      client = null;
    }
    running = false;
    await notifyAll("Trading engine stopped");
  }

  function isRunning() {
    return running;
  }

  function getSummary() {
    return { ...summary };
  }

  function addNotifyChat(chatId) {
    if (chatId != null) {
      notifyChatIds.add(chatId);
    }
  }

  return {
    start,
    stop,
    isRunning,
    getSummary,
    addNotifyChat,
  };
}
