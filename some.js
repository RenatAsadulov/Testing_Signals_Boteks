import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/index.js";
import { NewMessage } from "telegram/events/index.js";

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION || "");
const joinTarget = process.env.JOIN_TARGET; // @username или t.me/+hash

// ---------- helpers ----------
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

// Возвращает объект {id, text, date, senderId} последнего текстового сообщения
async function getLastTextMessage(client, target) {
  // 1) resolve peer
  const parsed = parseTMeLink(target);
  let peer;
  if (!parsed) throw new Error("JOIN_TARGET не распознан");
  if (parsed.type === "username") {
    peer = await client.getEntity(parsed.value);
  } else {
    // для приватной invite-ссылки нужно уже быть участником
    // импортируем (если ещё нет), затем найдём сущность через диалоги
    await client
      .invoke(new Api.messages.ImportChatInvite({ hash: parsed.value }))
      .catch(() => {});
    // быстрый способ: получить из списка диалогов
    const dialogs = await client.getDialogs({});
    const found = dialogs.find(
      (d) => d?.entity?.className && /Chat|Channel/.test(d.entity.className)
    );
    peer = found?.entity;
    if (!peer) throw new Error("Не удалось найти чат после инвайта");
  }

  // 2) взять историю (limit: 10, чтобы пропустить сервисные/медиа без текста)
  const res = await client.invoke(
    new Api.messages.GetHistory({
      peer,
      addOffset: 0,
      limit: 10,
      maxId: 0,
      minId: 0,
      hash: 0,
    })
  );

  const msgs = (res.messages || [])
    .map((m) => ("message" in m ? m : null))
    .filter(Boolean);
  const lastWithText = msgs.find((m) => (m.message || "").trim().length > 0);
  if (!lastWithText) return null;

  return {
    id: lastWithText.id,
    text: lastWithText.message.trim(),
    date: lastWithText.date, // unix timestamp (seconds)
    senderId: lastWithText.fromId?.userId?.toString?.() || null,
  };
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
        "Первый вход сделай интерактивно, чтобы получить SESSION и сохранить его в .env"
      );
    },
    onError: (e) => console.error(e),
  });

  console.log(
    "Успешный вход. SESSION:\n",
    client.session.save(),
    "\n— Сохрани эту строку в .env как SESSION."
  );

  // (опционально) вступим в источник
  if (joinTarget) {
    try {
      await joinTargetChat(client, joinTarget);
    } catch (e) {
      console.error("Не удалось присоединиться:", e.message);
    }
  }

  // ---- ВЫЗОВ: взять последнее сообщение и вывести в консоль ----
  try {
    const last = await getLastTextMessage(client, joinTarget);
    if (!last) {
      console.log("В истории нет текстовых сообщений (последние 10).");
    } else {
      console.log("Последнее текстовое сообщение:");
      console.log(
        "ID:",
        last.id,
        "Дата:",
        new Date(last.date * 1000).toISOString(),
        "От:",
        last.senderId
      );
      console.log("--- ТЕКСТ ---");
      console.log(last.text);
      console.log("-------------");
    }
  } catch (e) {
    console.error("Ошибка при получении последнего сообщения:", e.message);
  }

  // дальше можешь оставить «слушатель» или выйти
  // process.exit(0);

  // слушатель (как раньше) — на случай, если хочешь параллельно слушать новые
  client.addEventHandler(async (event) => {
    // ...
  }, new NewMessage({}));

  console.log("Слушаю новые сообщения…");
}

main().catch(console.error);
