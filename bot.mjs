import "dotenv/config";
import { Telegraf, Markup, session } from "telegraf";
import { Store } from "./store.mjs";
import path from "node:path";

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;
const SETTINGS_FILE = process.env.SETTINGS_FILE || "./data/settings.json";

if (!BOT_TOKEN) {
  console.error("Please set BOT_TOKEN in .env");
  process.exit(1);
}

const store = new Store(SETTINGS_FILE, { token: "", amount: 0 });
await store.load();

const bot = new Telegraf(BOT_TOKEN);

bot.use(session());

function makeKeyboard(settings) {
  const rows = [
    [
      Markup.button.callback(
        `token: ${settings.token || "<empty>"}`,
        "edit:token"
      ),
    ],
    [Markup.button.callback(`amount: ${settings.amount}`, "edit:amount")],
    [Markup.button.callback("📤 Export JSON", "export")],
  ];
  return Markup.inlineKeyboard(rows);
}

bot.start(async (ctx) => {
  await ctx.reply("Hello! Here you can config *token* и *amount*.", {
    parse_mode: "Markdown",
  });
  const s = await store.getAll();
  await ctx.reply("Current values:", makeKeyboard(s));
});

bot.command("settings", async (ctx) => {
  const s = await store.getAll();
  await ctx.reply("Current values:", makeKeyboard(s));
});

bot.command("get", async (ctx) => {
  const s = await store.getAll();
  await ctx.replyWithMarkdown(
    `\- token: \`${s.token}\`\n\- amount: \`${s.amount}\``
  );
});

bot.command("set", async (ctx) => {
  try {
    // assertOwner(ctx);
    const [, key, ...rest] = (ctx.message.text || "").split(/\s+/);
    const value = rest.join(" ");
    if (!key || !value) return ctx.reply("Use: /set <token|amount> <value>");
    if (key === "token") {
      await store.setToken(value);
    } else if (key === "amount") {
      const n = Number(value);
      if (!Number.isFinite(n)) return ctx.reply("amount should be a number");
      await store.setAmount(n);
    } else {
      return ctx.reply("Available keys: token, amount");
    }
    const s = await store.getAll();
    await ctx.reply("Saved ✅");
    await ctx.reply("Current values:", makeKeyboard(s));
  } catch (e) {
    await ctx.reply("Ошибка: " + e.message);
  }
});

bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data || "";
    if (data === "export") {
      await ctx.answerCbQuery();
      await ctx.replyWithDocument({
        source: path.resolve(SETTINGS_FILE),
        filename: "settings.json",
      });
      return;
    }
    if (!data.startsWith("edit:")) return;
    const key = data.split(":")[1];
    ctx.session ??= {};
    ctx.session.editKey = key;
    await ctx.answerCbQuery();
    await ctx.reply(`Insert value for \`${key}\`:`, {
      parse_mode: "Markdown",
    });
  } catch (e) {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("Error: " + e.message);
  }
});

bot.on("message", async (ctx, next) => {
  if (!("text" in ctx.message)) return next();
  ctx.session ??= {};
  const key = ctx.session.editKey;
  if (!key) return next();
  try {
    const raw = ctx.message.text.trim();
    if (key === "token") {
      await store.setToken(raw);
    } else if (key === "amount") {
      await store.setAmount(raw);
    }
    ctx.session.editKey = null;
    const s = await store.getAll();
    await ctx.reply("Saved ✅");
    await ctx.reply("Current values:", makeKeyboard(s));
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
