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

const store = new Store(SETTINGS_FILE, {
  token: "",
  amount: 0,
  marketCapMinimum: 0,
});
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
    [
      Markup.button.callback(
        `market cap ≥ ${settings.marketCapMinimum ?? 0}`,
        "edit:marketCapMinimum"
      ),
    ],
    [Markup.button.callback("📤 Export JSON", "export")],
  ];
  return Markup.inlineKeyboard(rows);
}

function makeMainMenuKeyboard() {
  return Markup.keyboard(
    [["Sell", "Buy"], ["Statistics", "Configuration"], ["Trade-Bot"]],
    { columns: 2 }
  )
    .resize()
    .persistent();
}

function hasSettings(settings) {
  return Boolean(
    settings && typeof settings === "object" && Object.keys(settings).length
  );
}

async function replyWithSettings(ctx) {
  const s = await store.getAll();
  await ctx.reply("Trade-Bot", makeMainMenuKeyboard());
}

const NUMERIC_EDIT_FIELDS = {
  amount: {
    title: "Swap amount",
    toDisplay: (value) => String(value ?? 0),
    async persist(raw) {
      const n = Number(raw || 0);
      await store.setAmount(n);
      return n;
    },
  },
  marketCapMinimum: {
    title: "Minimum market cap",
    toDisplay: (value) => String(value ?? 0),
    async persist(raw) {
      const n = Number(raw || 0);
      await store.setMarketCapMinimum(n);
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
      const persisted = await info.persist(edit.buffer);
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
    "Hello! Here you can config *token*, *amount* и *market cap*.", // TODO update text
    {
      parse_mode: "Markdown",
    }
  );
  await replyWithSettings(ctx);
});

bot.command("settings", async (ctx) => {
  await replyWithSettings(ctx);
});

bot.command("get", async (ctx) => {
  const s = await store.getAll();
  await ctx.replyWithMarkdown(
    `\- token: \`${s.token}\`\n` +
      `\- amount: \`${s.amount}\`\n` +
      `\- marketCapMinimum: \`${s.marketCapMinimum ?? 0}\``
  );
});

bot.command("set", async (ctx) => {
  try {
    // assertOwner(ctx);
    const [, key, ...rest] = (ctx.message.text || "").split(/\s+/);
    const value = rest.join(" ");
    if (!key || !value)
      return ctx.reply("Use: /set <token|amount|marketCapMinimum> <value>");
    if (key === "token") {
      await store.setToken(value);
    } else if (key === "amount") {
      const n = Number(value);
      if (!Number.isFinite(n)) return ctx.reply("amount should be a number");
      await store.setAmount(n);
    } else if (key === "marketCapMinimum") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0)
        return ctx.reply("marketCapMinimum should be a non-negative number");
      await store.setMarketCapMinimum(n);
    } else {
      return ctx.reply("Available keys: token, amount, marketCapMinimum");
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
    if (data.startsWith("num:")) {
      await handleNumericCallback(ctx, data.slice(4));
      return;
    }
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
  const key = ctx.session.editKey;
  if (!key) return next();
  try {
    const raw = ctx.message.text.trim();
    if (key === "token") {
      await store.setToken(raw);
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
