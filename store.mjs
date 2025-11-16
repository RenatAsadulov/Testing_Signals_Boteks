import fs from "node:fs/promises";
import path from "node:path";

export class Store {
  constructor(
    filePath,
    defaults = {
      token: "",
      amount: 0,
      marketCapMinimum: 0,
      profitTargetPercent: 0,
    }
  ) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.cache = null;
    this.queue = Promise.resolve();
  }

  async ensureDir() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  async load() {
    await this.ensureDir();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data = JSON.parse(raw);
      this.cache = {
        token: "",
        amount: 0,
        marketCapMinimum: 0,
        profitTargetPercent: 0,
        ...data,
      };
      return this.cache;
    } catch (e) {
      if (e.code === "ENOENT") {
        await this.save(this.defaults);
        this.cache = structuredClone(this.defaults);
        return this.cache;
      }
      throw e;
    }
  }

  async save(next) {
    await this.ensureDir();
    const tmp = this.filePath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(next, null, 2));
    await fs.rename(tmp, this.filePath);
    this.cache = next;
    return next;
  }

  async getAll() {
    if (!this.cache) await this.load();
    return this.cache;
  }

  async setToken(value) {
    const token = String(value).trim().toUpperCase();
    const current = await this.getAll();
    const changed = (current.token || "") !== token;

    const next = {
      ...current,
      token,
      ...(changed ? { amount: 0 } : {}), // <- reset to 0 (you can provide your own value)
    };

    return this.enqueue(next);
  }

  async setAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error("amount must be a number");
    const current = await this.getAll();
    const next = { ...current, amount: n };
    return this.enqueue(next);
  }

  async setMarketCapMinimum(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0)
      throw new Error("marketCapMinimum must be a non-negative number");
    const current = await this.getAll();
    const next = { ...current, marketCapMinimum: n };
    return this.enqueue(next);
  }

  async setProfitTargetPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0)
      throw new Error("profitTargetPercent must be a non-negative number");
    const current = await this.getAll();
    const next = { ...current, profitTargetPercent: n };
    return this.enqueue(next);
  }

  enqueue(payload) {
    this.queue = this.queue.then(() => this.save(payload));
    return this.queue;
  }
}
