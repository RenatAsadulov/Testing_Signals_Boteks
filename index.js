// index.js (ESM)
import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/index.js";
import { NewMessage } from "telegram/events/index.js";

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION || "");
const joinTarget = process.env.JOIN_TARGET;

// --- helpers ---
function getText(m) {
  // В GramJS подпись к фото/видео тоже лежит в m.message
  return (m?.message || "").trim();
}

// Заголовок — первая непустая строка
function getHeaderLine(text) {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines[0] || "";
}

// Соотнести скрин: ищем подстроку "New Trending" в заголовке (регистр игнорим)
function hasNewTrendingHeader(text) {
  const header = getHeaderLine(text);
  return /new\s+trending/i.test(header);
}

// Достаём тикер вида $PEANUT / $ABC123 (2–12 симв.)
function extractTicker(text) {
  const m = text.match(/\$[A-Z0-9]{2,12}\b/);
  return m ? m[0] : null;
}

function logFound({ chatTitle, chatId, msgId, header, ticker }) {
  console.log(`[${new Date().toISOString()}] NewTrending detected`, {
    chatId: String(chatId),
    chatTitle,
    msgId,
    header,
    ticker,
  });
}

// --- join by @username или invite ---
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

async function main() {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: () => Promise.resolve(process.env.PHONE || ""),
    password: () => Promise.resolve(process.env.PASSWORD || ""),
    phoneCode: async () => {
      throw new Error(
        "Запусти первый вход без PHONE/PASSWORD, чтобы ввести данные интерактивно и получить SESSION"
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

  // слушаем все новые сообщения
  client.addEventHandler(async (event) => {
    try {
      const chat = await event.getChat();
      if (!/Chat|Channel/.test(chat?.className || "")) return; // только группы/каналы

      const txt = getText(event.message);
      if (!txt) return;

      if (!hasNewTrendingHeader(txt)) return;

      const ticker = extractTicker(txt);
      if (!ticker) return;

      const header = getHeaderLine(txt);
      logFound({
        chatTitle: chat?.title,
        chatId: event.chatId,
        msgId: event.message.id,
        header,
        ticker,
      });

      // здесь можно делать что угодно дальше:
      // - сохранить в БД
      // - отправить на вебхук
      // - переслать вашему боту/каналу и т.д.
      // пример: console.log только сам тикер:
      console.log("TICKER:", ticker);
    } catch (err) {
      console.error("Handler error:", err.message);
    }
  }, new NewMessage({}));

  console.log("Слушаю новые сообщения…");
}

main().catch(console.error);
