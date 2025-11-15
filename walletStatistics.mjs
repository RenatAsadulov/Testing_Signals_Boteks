import fs from "node:fs/promises";
import path from "node:path";

function ensureDateKey(date) {
  if (typeof date === "string" && /\d{4}-\d{2}-\d{2}/.test(date)) {
    return date;
  }
  const d = date instanceof Date ? date : new Date(date || Date.now());
  if (Number.isNaN(d.getTime())) {
    throw new Error("Invalid date for statistics snapshot");
  }
  return d.toISOString().slice(0, 10);
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function loadWalletStats(filePath) {
  await ensureDir(filePath);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid statistics file structure");
    }
    parsed.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return parsed;
  } catch (e) {
    if (e.code === "ENOENT") {
      return { entries: [] };
    }
    throw e;
  }
}

async function saveWalletStats(filePath, payload) {
  await ensureDir(filePath);
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fs.rename(tmp, filePath);
}

export async function recordWalletSnapshot(filePath, snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Snapshot must be an object");
  }
  const now = new Date();
  const timestamp = snapshot.timestamp || now.toISOString();
  const date = ensureDateKey(snapshot.date || timestamp);
  const entry = {
    date,
    timestamp,
    totalValue: Number.isFinite(snapshot.totalValue)
      ? Number(snapshot.totalValue)
      : null,
    tokens: Array.isArray(snapshot.tokens) ? snapshot.tokens : [],
  };

  const stats = await loadWalletStats(filePath);
  const entries = Array.isArray(stats.entries) ? [...stats.entries] : [];
  const index = entries.findIndex((item) => item.date === date);
  if (index >= 0) {
    entries[index] = { ...entry };
  } else {
    entries.push({ ...entry });
  }

  entries.sort((a, b) => {
    const ta = Date.parse(a.date);
    const tb = Date.parse(b.date);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  });

  const next = { entries };
  await saveWalletStats(filePath, next);
  return { entry, stats: next };
}
