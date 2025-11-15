import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "";
const ACTIONS_COLLECTION =
  process.env.MONGODB_ACTIONS_COLLECTION || "botUserActions";
const STATE_COLLECTION =
  process.env.MONGODB_STATE_COLLECTION || "botState";

export const mongoConfigured = Boolean(MONGODB_URI && MONGODB_DB);

let clientPromise = null;
let cachedDb = null;
let disabled = !mongoConfigured;

async function getDb() {
  if (disabled) return null;
  if (cachedDb) return cachedDb;
  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 5,
    });
    clientPromise = client
      .connect()
      .then((connected) => {
        cachedDb = connected.db(MONGODB_DB);
        return cachedDb;
      })
      .catch((err) => {
        disabled = true;
        throw err;
      });
  }
  try {
    const db = await clientPromise;
    return db;
  } catch (err) {
    disabled = true;
    throw err;
  }
}

export async function initMongo() {
  if (disabled) return false;
  try {
    const db = await getDb();
    if (!db) return false;
    await Promise.all([
      db.collection(ACTIONS_COLLECTION).createIndex({ createdAt: -1 }),
      db.collection(STATE_COLLECTION).createIndex({ updatedAt: -1 }),
      db
        .collection(STATE_COLLECTION)
        .createIndex({ "tokens.mint": 1 }, { sparse: true }),
    ]);
    return true;
  } catch (err) {
    disabled = true;
    console.error("Mongo initialization failed:", err);
    return false;
  }
}

function withMongoGuard(fn) {
  return async (...args) => {
    if (disabled) return null;
    try {
      const db = await getDb();
      if (!db) return null;
      return await fn(db, ...args);
    } catch (err) {
      console.error("Mongo operation failed:", err);
      disabled = true;
      return null;
    }
  };
}

export const logUserAction = withMongoGuard(async (db, payload) => {
  if (!payload || typeof payload !== "object") return null;
  const entry = {
    ...payload,
    createdAt: payload.createdAt ? new Date(payload.createdAt) : new Date(),
  };
  return db.collection(ACTIONS_COLLECTION).insertOne(entry);
});

const HISTORY_LIMIT = 50;

export const saveSettingsDocument = withMongoGuard(
  async (db, settings, meta = {}) => {
    const doc = {
      _id: "settings",
      data: settings || {},
      meta,
      updatedAt: new Date(),
    };
    return db
      .collection(STATE_COLLECTION)
      .replaceOne({ _id: "settings" }, doc, { upsert: true });
  }
);

export const updateTokenAggregates = withMongoGuard(
  async (db, update) => {
    if (!update || !update.tokenMint) return null;
    const collection = db.collection(STATE_COLLECTION);
    const existing =
      (await collection.findOne({ _id: "tokenActions" })) || {
        _id: "tokenActions",
        tokens: {},
        history: [],
      };

    const tokens = existing.tokens || {};
    const mint = update.tokenMint;
    const now = new Date();
    const entry = { ...tokens[mint] };
    entry.mint = mint;
    entry.symbol = update.tokenSymbol || entry.symbol || mint.slice(0, 6);
    entry.counts = { ...(entry.counts || {}) };
    entry.volumes = { ...(entry.volumes || {}) };
    entry.valuesUsd = { ...(entry.valuesUsd || {}) };

    const actionKey = update.actionType || "unknown";
    entry.counts[actionKey] = (entry.counts[actionKey] || 0) + 1;

    if (Number.isFinite(update.amountUi)) {
      entry.volumes[actionKey] =
        (entry.volumes[actionKey] || 0) + Number(update.amountUi);
    }

    if (Number.isFinite(update.valueUsd)) {
      entry.valuesUsd[actionKey] =
        (entry.valuesUsd[actionKey] || 0) + Number(update.valueUsd);
    }

    entry.lastActionAt = now.toISOString();
    entry.lastAction = {
      actionType: actionKey,
      amountUi: Number.isFinite(update.amountUi)
        ? Number(update.amountUi)
        : null,
      valueUsd: Number.isFinite(update.valueUsd)
        ? Number(update.valueUsd)
        : null,
      context: update.context || null,
    };

    tokens[mint] = entry;

    const history = Array.isArray(existing.history)
      ? existing.history.slice(-HISTORY_LIMIT + 1)
      : [];
    history.push({
      mint,
      symbol: entry.symbol,
      actionType: actionKey,
      amountUi: entry.lastAction.amountUi,
      valueUsd: entry.lastAction.valueUsd,
      context: entry.lastAction.context,
      at: now.toISOString(),
    });

    const nextDoc = {
      _id: "tokenActions",
      tokens,
      history,
      updatedAt: now,
    };

    return collection.replaceOne({ _id: "tokenActions" }, nextDoc, {
      upsert: true,
    });
  }
);

export const updateWalletAggregate = withMongoGuard(
  async (db, payload) => {
    if (!payload) return null;
    const now = new Date();
    const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
    const normalizedTokens = tokens.map((token) => ({
      mint: token.mint,
      symbol: token.symbol,
      uiAmount: Number.isFinite(token.uiAmount) ? Number(token.uiAmount) : null,
      valueUsdt: Number.isFinite(token.valueUsdt)
        ? Number(token.valueUsdt)
        : null,
      priceUsdt: Number.isFinite(token.priceUsdt)
        ? Number(token.priceUsdt)
        : null,
      decimals: Number.isFinite(token.decimals) ? Number(token.decimals) : null,
    }));

    const totalValue = Number.isFinite(payload.totalValue)
      ? Number(payload.totalValue)
      : normalizedTokens.reduce((sum, token) => {
          return Number.isFinite(token.valueUsdt) ? sum + token.valueUsdt : sum;
        }, 0);

    const doc = {
      _id: "wallet",
      totalValue,
      tokens: normalizedTokens,
      context: payload.context || null,
      updatedAt: now,
    };

    return db
      .collection(STATE_COLLECTION)
      .replaceOne({ _id: "wallet" }, doc, { upsert: true });
  }
);

export function mongoIsActive() {
  return !disabled;
}

