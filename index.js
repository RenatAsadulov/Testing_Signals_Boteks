import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/index.js";
import { NewMessage } from "telegram/events/index.js";

// --- ENV ---
const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION || "");
const joinTarget = process.env.JOIN_TARGET; // @username или https://t.me/+hash
const outboundChat = process.env.TELEGRAM_CHAT_ID || ""; // @username или -100...

// --- helpers ---
function sanitize(text = "") {
  return text
    .replace(/https?:\/\/\S+/g, "") // убрать URL
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width/BOM
    .replace(/[\u00A0\u202F\u2009]/g, " ") // NBSP/узкие пробелы -> пробел
    .normalize("NFKC");
}
function getText(m) {
  return sanitize(m?.message || "");
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

  // Берём первый $TICKER из ЭТОЙ строки (2–12 символов, буква сначала)
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
  if (!outboundChat) return;
  const target = outboundChat.startsWith("@")
    ? outboundChat
    : outboundChat.match(/^-?\d+$/)
    ? BigInt(outboundChat)
    : outboundChat;
  await client.sendMessage(target, { message: text });
}

async function main() {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
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
    onError: (e) => console.error(e),
  });

  console.log(
    "SESSION:\n",
    client.session.save(),
    "\n— положи в .env как SESSION."
  );

  if (joinTarget) {
    try {
      await joinTargetChat(client, joinTarget);
    } catch (e) {
      console.error("Join error:", e.message);
    }
  }

  // (Необязательно) прогреть кэш диалогов — помогает event.getChat()
  await client.getDialogs({}).catch(() => {});

  // --- Надёжный слушатель ---
  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;

      // Резолвим чат без зависимости от кэша:
      const inputPeer = await client.getInputEntity(msg.peerId);
      const chat = await client.getEntity(inputPeer);
      if (!/Chat|Channel/.test(chat.className || "")) return; // только группы/каналы

      const txt = getText(msg);
      if (!txt) return;
      if (!hasNewTrending(txt)) return;

      const ticker = extractTickerFromDev(txt);
      console.log("ticker", ticker);
      if (!ticker) return;

      const header = getHeaderLine(txt);
      const link = await tryExportMsgLink(client, chat, msg.id);

      // лог
      console.log(`[${new Date().toISOString()}] NewTrending`, {
        chatTitle: chat.title,
        chatId: String(event.chatId),
        msgId: msg.id,
        header,
        ticker,
      });

      // отправка результата в целевой чат
      const out =
        `🔥 *New Trending*\n` +
        `• Chat: ${chat.title}\n` +
        `• Header: ${header}\n` +
        `• Ticker: \`${ticker}\`\n` +
        (link ? `• Link: ${link}\n` : "") +
        `• MsgID: ${msg.id}`;
      await client.sendMessage(
        outboundChat.startsWith("@") ? outboundChat : BigInt(outboundChat),
        { message: out, parseMode: "Markdown" }
      );
    } catch (e) {
      console.error("Handler error:", e.message);
    }
  }, new NewMessage({}));

  console.log("Слушаю новые сообщения…");
}

main().catch(console.error);
