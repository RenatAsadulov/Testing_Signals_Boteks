// index.js
import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/index.js";
import { NewMessage } from "telegram/events/index.js";

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION || "");
const joinTarget = process.env.JOIN_TARGET;
const outboundChat = process.env.TELEGRAM_CHAT_ID || ""; // может быть @username или -100...

// ---------- helpers ----------
function getText(m) {
  return (m?.message || "").trim();
}
function getHeaderLine(text) {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines[0] || "";
}
function hasNewTrendingHeader(text) {
  return /new\s+trending/i.test(getHeaderLine(text));
}
function extractTicker(text) {
  const m = text.match(/\$[A-Z0-9]{2,12}\b/); // под твой формат $PEANUT
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

// Попробуем получить ссылку на сообщение (работает для каналов/супергрупп с публичным @)
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
    return null; // приватный чат/нет прав/нет username — просто молча пропустим
  }
}

// Универсальная отправка в чат из .env (поддерживает @username и числовой id)
async function sendOutbound(client, text) {
  if (!outboundChat) return;
  const target = outboundChat.startsWith("@")
    ? outboundChat
    : outboundChat.match(/^-?\d+$/)
    ? BigInt(outboundChat)
    : outboundChat; // -100... → BigInt
  await client.sendMessage(target, { message: text });
}

// ---------- main ----------
async function main() {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: () => Promise.resolve(process.env.PHONE || ""),
    password: () => Promise.resolve(process.env.PASSWORD || ""),
    phoneCode: async () => {
      throw new Error(
        "Первый запуск сделай интерактивно, чтобы получить SESSION; потом положи его в .env"
      );
    },
    onError: (e) => console.error(e),
  });

  console.log(
    "Успешный вход. SESSION:\n",
    client.session.save(),
    "\n— Сохрани эту строку в .env как SESSION."
  );

  if (joinTarget) {
    try {
      await joinTargetChat(client, joinTarget);
    } catch (e) {
      console.error("Не удалось присоединиться:", e.message);
    }
  }

  client.addEventHandler(async (event) => {
    try {
      const chat = await event.getChat();
      if (!/Chat|Channel/.test(chat?.className || "")) return;

      const txt = getText(event.message);
      if (!txt) return;

      if (!hasNewTrendingHeader(txt)) return;

      const ticker = extractTicker(txt);
      if (!ticker) return;

      const header = getHeaderLine(txt);
      const link = await tryExportMsgLink(client, chat, event.message.id);

      // лог в консоль
      console.log(`[${new Date().toISOString()}] NewTrending`, {
        chatTitle: chat?.title,
        chatId: String(event.chatId),
        msgId: event.message.id,
        ticker,
      });

      // отправка в чат из .env
      const outboundText =
        `🔥 New Trending\n` +
        `• Chat: ${chat?.title || ""}\n` +
        `• Ticker: ${ticker}\n` +
        (link ? `• Link: ${link}\n` : "") +
        `• MsgID: ${event.message.id}`;
      await sendOutbound(client, outboundText);
    } catch (err) {
      console.error("Handler error:", err.message);
    }
  }, new NewMessage({}));

  console.log("Слушаю новые сообщения…");
}

main().catch(console.error);
