/* =========================
   CONFIG
   ========================= */

// Если фронт и бек на одном домене/порту — оставь "".
const API = "";

/* =========================
   STATE
   ========================= */

let token = localStorage.getItem("token") || "";
let me = null;

let ws = null;
let wsRetry = 0;
let wsReconnectTimer = null;

let currentChatId = null;
let currentOtherId = null;
let nextBeforeId = null;
let otherLastRead = 0;

let typingTimer = null;
let pollTimer = null;

let isComposing = false;
let isSending = false;

// для аватаров/ников и NEW
const otherByChatId = new Map();

// unread NEW
const unreadByChatId = new Map();
const draftsByChatId = new Map();

/* =========================
   DOM
   ========================= */

const u = document.getElementById("u");
const p = document.getElementById("p");
const q = document.getElementById("q");
const text = document.getElementById("text");
const file = document.getElementById("file");

const birthYear = document.getElementById("birthYear");
const avatarInput = document.getElementById("avatar");

const mePill = document.getElementById("mePill");
const mePill2 = document.getElementById("mePill2");

const chatTitle = document.getElementById("chatTitle");
const msgs = document.getElementById("msgs");
const dialogs = document.getElementById("dialogs");
const searchRes = document.getElementById("searchRes");

const onlineDot = document.getElementById("onlineDot");
const onlineText = document.getElementById("onlineText");
const typingText = document.getElementById("typingText");

const btnRegister = document.getElementById("btnRegister");
const btnLogin = document.getElementById("btnLogin");
const btnFind = document.getElementById("btnFind");
const btnReloadDialogs = document.getElementById("btnReloadDialogs");
const btnSend = document.getElementById("btnSend");

const uploadBar = document.getElementById("uploadBar");
const uploadName = document.getElementById("uploadName");
const uploadPct = document.getElementById("uploadPct");
const uploadFill = document.getElementById("uploadFill");

const btnBack = document.getElementById("btnBack");

/* =========================
   Helpers
   ========================= */

function authHeadersJson() {
  return { Authorization: "Bearer " + token, "Content-Type": "application/json" };
}

function setMeUI() {
  const html = me ? `@${escapeHtml(me.username)}` : `<small>not logged in</small>`;
  if (mePill) mePill.innerHTML = html;
  if (mePill2) mePill2.innerHTML = html;
}

function setOnlineUI(on) {
  onlineDot && onlineDot.classList.toggle("online", !!on);
  if (onlineText) onlineText.textContent = on ? "online" : "offline";
}

function setTypingUI(txt) {
  if (!typingText) return;
  typingText.textContent = txt || "";
}

async function readError(r) {
  let txt = "";
  try {
    txt = await r.text();
  } catch (_) {}
  try {
    const j = JSON.parse(txt);
    if (j && j.detail) return String(j.detail);
  } catch (_) {}
  return txt || `HTTP ${r.status}`;
}

function escapeHtml(s) {
  return (s || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Делает URL до файла с добавлением ?token=...
 * и опциональным cache-bust параметром v=...
 */
function fileUrl(pathOrUrl, v = null) {
  if (!pathOrUrl) return "";
  const sep1 = pathOrUrl.includes("?") ? "&" : "?";
  let out = API + pathOrUrl;

  if (token) out += `${sep1}token=${encodeURIComponent(token)}`;

  // cache-bust (важно для <img>, чтобы не держать старый 401/404 в кеше)
  if (v !== null && v !== undefined && v !== "") {
    const sep2 = out.includes("?") ? "&" : "?";
    out += `${sep2}v=${encodeURIComponent(String(v))}`;
  }

  return out;
}

/**
 * Возвращает относительный путь к аватару, если бек не дал avatar_url.
 */
function ensureAvatarPath(u) {
  if (!u) return null;
  if (u.avatar_url) return u.avatar_url;
  if (u.avatar_file_id) return `/files/${u.avatar_file_id}`;
  return null;
}

/**
 * Рендер аватара: если URL есть — рисуем img с onerror,
 * иначе — fallback "?".
 */
function renderAvatarSpan(userObj, sizePx = 22) {
  const path = ensureAvatarPath(userObj);
  const v = userObj && userObj.avatar_file_id ? userObj.avatar_file_id : Date.now(); // v — сброс кеша
  const src = path ? fileUrl(path, v) : "";

  const boxStyle =
    `width:${sizePx}px;height:${sizePx}px;border-radius:999px;` +
    `overflow:hidden;display:inline-flex;align-items:center;justify-content:center;` +
    `border:1px solid rgba(255,255,255,.12);flex:0 0 auto;`;

  if (!src) {
    return `<span style="${boxStyle};color:rgba(255,255,255,.35);font-weight:900;font-size:12px">?</span>`;
  }

  // onerror → показать fallback
  // (Важно: часть браузеров кэшируют неудачные загрузки img, v= помогает)
  return `
    <span style="${boxStyle}">
      <img
        src="${src}"
        alt="avatar"
        style="width:100%;height:100%;object-fit:cover;display:block"
        onerror="this.onerror=null; this.parentElement.innerHTML='?'; this.parentElement.style.color='rgba(255,255,255,.35)'; this.parentElement.style.fontWeight='900'; this.parentElement.style.fontSize='12px'; this.parentElement.style.display='inline-flex'; this.parentElement.style.alignItems='center'; this.parentElement.style.justifyContent='center';"
      />
    </span>
  `;
}

function isNearBottom() {
  const threshold = 80;
  return msgs.scrollHeight - (msgs.scrollTop + msgs.clientHeight) < threshold;
}

function getLastRenderedMessageId() {
  const nodes = msgs.querySelectorAll("[data-message-id]");
  if (!nodes.length) return 0;
  const lastId = parseInt(nodes[nodes.length - 1].getAttribute("data-message-id") || "0", 10);
  return Number.isFinite(lastId) ? lastId : 0;
}

function disableSend(disabled) {
  if (!btnSend) return;
  btnSend.disabled = !!disabled;
  btnSend.style.opacity = disabled ? "0.7" : "1";
}

/* =========================
   Persist unread
   ========================= */

const LS_UNREAD = "unreadByChatId_v1";
const LS_DRAFTS = "draftsByChatId_v1";

function loadPersistedUnread() {
  try {
    const raw = localStorage.getItem(LS_UNREAD);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const cid = parseInt(k, 10);
      if (Number.isFinite(cid)) unreadByChatId.set(cid, !!v);
    }
  } catch (_) {}
}

function savePersistedUnread() {
  try {
    const obj = {};
    for (const [cid, v] of unreadByChatId.entries()) obj[String(cid)] = !!v;
    localStorage.setItem(LS_UNREAD, JSON.stringify(obj));
  } catch (_) {}
}

function setUnread(chatId, val) {
  const cid = Number(chatId);
  if (!Number.isFinite(cid)) return;
  unreadByChatId.set(cid, !!val);
  savePersistedUnread();
  paintUnreadBadge(cid, !!val);
}

function loadPersistedDrafts() {
  try {
    const raw = localStorage.getItem(LS_DRAFTS);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const cid = parseInt(k, 10);
      if (Number.isFinite(cid) && typeof v === "string") draftsByChatId.set(cid, v);
    }
  } catch (_) {}
}

function savePersistedDrafts() {
  try {
    const obj = {};
    for (const [cid, v] of draftsByChatId.entries()) obj[String(cid)] = String(v || "");
    localStorage.setItem(LS_DRAFTS, JSON.stringify(obj));
  } catch (_) {}
}

function saveDraftForCurrentChat() {
  if (!text || !currentChatId) return;
  draftsByChatId.set(currentChatId, text.value || "");
  savePersistedDrafts();
}

function restoreDraftForChat(chatId) {
  if (!text) return;
  const v = draftsByChatId.get(chatId) || "";
  text.value = v;
}

/* =========================
   Upload progress helpers
   ========================= */

function showUpload(name) {
  if (!uploadBar) return;
  uploadBar.style.display = "block";
  if (uploadName) uploadName.textContent = name ? `Uploading: ${name}` : "Uploading…";
  if (uploadPct) uploadPct.textContent = "0%";
  if (uploadFill) uploadFill.style.width = "0%";
  disableSend(true);
}

function setUploadProgress(pct) {
  const v = Math.max(0, Math.min(100, pct || 0));
  if (uploadPct) uploadPct.textContent = `${v}%`;
  if (uploadFill) uploadFill.style.width = `${v}%`;
}

function hideUpload() {
  if (!uploadBar) return;
  uploadBar.style.display = "none";
  disableSend(false);
}

/* =========================
   Auth
   ========================= */

async function register() {
  // ✅ регистрация через multipart/form-data
  const username = (u.value || "").trim();
  const password = (p.value || "").trim();
  const by = birthYear ? (birthYear.value || "").trim() : "";
  const av = avatarInput && avatarInput.files ? avatarInput.files[0] : null;

  if (!username || !password) {
    alert("Введите username и password");
    return;
  }

  const form = new FormData();
  form.append("username", username);
  form.append("password", password);
  if (by) form.append("birth_year", by);
  if (av) form.append("avatar", av);

  const r = await fetch(API + "/auth/register_form", {
    method: "POST",
    body: form,
  });

  if (!r.ok) {
    alert("Register failed: " + (await readError(r)));
    return;
  }

  const j = await r.json();

  // ✅ авто-логин
  if (j && j.access_token) {
    token = j.access_token;
    localStorage.setItem("token", token);

    await loadMe();
    connectWS();
    await loadDialogs();

    // чтобы сразу увидеть — переключим на чаты
    if (window.ui && typeof window.ui.setTab === "function") window.ui.setTab("chats");

    alert("Registered & logged in ✅");
  } else {
    alert("Registered. Now login.");
  }
}

async function login() {
  const username = (u.value || "").trim();
  const password = (p.value || "").trim();

  const r = await fetch(API + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!r.ok) {
    alert("Login failed: " + (await readError(r)));
    return;
  }

  const j = await r.json();
  token = j.access_token;
  localStorage.setItem("token", token);

  await loadMe();
  connectWS();
  await loadDialogs();

  if (window.ui && typeof window.ui.setTab === "function") window.ui.setTab("chats");
}

async function loadMe() {
  const r = await fetch(API + "/auth/me", { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) {
    me = null;
    setMeUI();
    return;
  }
  me = await r.json();
  setMeUI();
}

/* =========================
   WS (stable + reconnect)
   ========================= */

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  const delay = Math.min(8000, 800 * Math.pow(1.6, wsRetry));
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsRetry++;
    connectWS();
  }, delay);
}

function connectWS() {
  try {
    if (ws) ws.close();
  } catch (_) {}

  if (!token) return;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    wsRetry = 0;
    if (currentChatId) wsSend({ type: "presence:subscribe", chat_id: currentChatId });
  };

  ws.onclose = () => {
    scheduleReconnect();
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch (_) {}
  };

  ws.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch (_) {
      return;
    }

    if (data.type === "message:new") {
      const cid = data.chat_id;
      const msg = data.message;

      if (cid === currentChatId) {
        if (msg?.id && !document.querySelector(`.msg[data-message-id="${msg.id}"]`)) {
          renderMessage(msg);
        }
        maybeMarkRead();
      } else {
        const senderId = msg?.sender_id;
        if (!(me && senderId && senderId === me.id)) {
          setUnread(cid, true);
        }
      }
    }

    if (data.type === "presence:state" && data.chat_id === currentChatId && data.user_id === currentOtherId) {
      setOnlineUI(!!data.online);
    }

    if (data.type === "typing:start" && data.chat_id === currentChatId) {
      setTypingUI("typing…");
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => setTypingUI(""), 2000);
    }
    if (data.type === "typing:stop" && data.chat_id === currentChatId) {
      setTypingUI("");
    }

    if (data.type === "message:read" && data.chat_id === currentChatId) {
      otherLastRead = Math.max(otherLastRead, data.last_read_message_id || 0);
      updateReadMarks();
    }
  };
}

function wsSend(obj) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

/* =========================
   Poll fallback (when WS is not open)
   ========================= */

function startChatPoll() {
  stopChatPoll();
  pollTimer = setInterval(async () => {
    if (!token || !currentChatId) return;
    if (ws && ws.readyState === 1) return;

    const lastId = getLastRenderedMessageId();
    const url = new URL(API + `/chats/dm/${currentChatId}/messages`, location.origin);
    url.searchParams.set("limit", "50");

    try {
      const r = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
      if (!r.ok) return;

      const j = await r.json();
      otherLastRead = j.read_state?.other_last_read || otherLastRead;

      const items = j.items || [];
      for (const m of items) {
        if (m?.id && m.id > lastId && !document.querySelector(`.msg[data-message-id="${m.id}"]`)) {
          renderMessage(m);
        }
      }

      updateReadMarks();
      await maybeMarkRead();
    } catch (_) {}
  }, 2500);
}

function stopChatPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* =========================
   Search / Dialogs
   ========================= */

async function search() {
  if (!token) return alert("Login first");
  const query = (q.value || "").trim();

  const r = await fetch(API + `/users/search?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: "Bearer " + token },
  });

  if (!r.ok) {
    alert("Search failed: " + (await readError(r)));
    return;
  }

  const list = await r.json();

  searchRes.innerHTML = list
    .map((uu) => {
      const safeName = String(uu.username || "").replaceAll("'", "");
      return `<div class="item" onclick="startDM(${uu.id}, '${safeName}')">@${escapeHtml(uu.username)}</div>`;
    })
    .join("");
}

async function startDM(otherId, username) {
  const r = await fetch(API + "/chats/dm/start", {
    method: "POST",
    headers: authHeadersJson(),
    body: JSON.stringify({ other_user_id: otherId }),
  });

  if (!r.ok) {
    alert("Start DM failed: " + (await readError(r)));
    return;
  }

  const j = await r.json();

  if (j.with && j.chat_id) {
    // ✅ сохраняем аватар/ник в map
    otherByChatId.set(j.chat_id, j.with);
  }

  await loadDialogs();
  openChat(j.chat_id, otherId, username);
}

function paintUnreadBadge(chatId, show) {
  const el = document.querySelector(`.item[data-chatid="${chatId}"]`);
  if (!el) return;

  const row = el.querySelector(".dialogRow");
  if (!row) return;

  const old = row.querySelector(".unreadBadge");
  if (!show) {
    if (old) old.remove();
    return;
  }

  if (!old) row.insertAdjacentHTML("beforeend", `<span class="unreadBadge">NEW</span>`);
}

async function loadDialogs() {
  if (!token) return;

  const r = await fetch(API + "/chats/dm/list", { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) {
    alert("Load dialogs failed: " + (await readError(r)));
    return;
  }

  const list = await r.json();

  dialogs.innerHTML = list
    .map((d) => {
      const other = d.other || {};
      const online = d.other_online ? "online" : "";

      if (d.chat_id && other) otherByChatId.set(d.chat_id, other);

      const hasUnread = unreadByChatId.get(d.chat_id) === true;
      const safeName = String(other.username || "").replaceAll("'", "");

      // ✅ аватар: берём avatar_url ИЛИ строим из avatar_file_id
      const av = renderAvatarSpan(other, 22);

      return `<div class="item" data-chatid="${d.chat_id}" onclick="openChat(${d.chat_id}, ${other.id}, '${safeName}')">
        <div class="dialogRow" style="display:flex;align-items:center;gap:8px">
          <span class="dot ${online}"></span>
          ${av}
          <div style="font-weight:600">@${escapeHtml(other.username || "")}</div>
          ${hasUnread ? `<span class="unreadBadge">NEW</span>` : ``}
        </div>
        <small>chat_id: ${d.chat_id}</small>
      </div>`;
    })
    .join("");
}

/* =========================
   Messages
   ========================= */

async function openChat(chatId, otherId, title) {
  saveDraftForCurrentChat();

  currentChatId = chatId;
  currentOtherId = otherId;
  nextBeforeId = null;
  otherLastRead = 0;

  setUnread(chatId, false);
  restoreDraftForChat(chatId);

  const other = otherByChatId.get(chatId) || { id: otherId, username: title, avatar_url: null, avatar_file_id: null };
  const username = other?.username || title || "—";

  // ✅ аватар в шапке — тоже через общий рендер
  const av = renderAvatarSpan(other, 30);

  if (chatTitle) {
    chatTitle.innerHTML = `<span style="display:flex;align-items:center;gap:10px;min-width:0">
      ${av}
      <span style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">@${escapeHtml(username)}</span>
    </span>`;
  }

  setTypingUI("");
  setOnlineUI(false);

  msgs.innerHTML = `<div class="loading">Loading…</div>`;

  wsSend({ type: "presence:subscribe", chat_id: chatId });

  await loadMessagesPage();

  msgs.scrollTop = msgs.scrollHeight;
  await maybeMarkRead();

  msgs.onscroll = async () => {
    if (msgs.scrollTop < 40 && nextBeforeId) {
      const prevHeight = msgs.scrollHeight;
      await loadMessagesPage(nextBeforeId, true);
      msgs.scrollTop = msgs.scrollHeight - prevHeight + msgs.scrollTop;
    }
    await maybeMarkRead();
  };

  if (window.ui && typeof window.ui.showChatMobile === "function") window.ui.showChatMobile();
  startChatPoll();
}

async function loadMessagesPage(beforeId = null, prepend = false) {
  if (!currentChatId) return;

  const url = new URL(API + `/chats/dm/${currentChatId}/messages`, location.origin);
  url.searchParams.set("limit", "50");
  if (beforeId) url.searchParams.set("before_id", String(beforeId));

  const r = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) {
    alert("Load messages failed: " + (await readError(r)));
    return;
  }

  const j = await r.json();
  nextBeforeId = j.next_before_id;
  otherLastRead = j.read_state?.other_last_read || otherLastRead;

  const items = j.items || [];
  if (!prepend) msgs.innerHTML = "";

  if (nextBeforeId) {
    const topHint = `<div class="loading" id="loadmore">Scroll up to load more…</div>`;
    if (prepend) msgs.insertAdjacentHTML("afterbegin", topHint);
    else msgs.insertAdjacentHTML("beforeend", topHint);
  }

  if (prepend) {
    const html = items.map((m) => renderMessageHTML(m)).join("");
    const lm = document.getElementById("loadmore");
    if (lm) lm.insertAdjacentHTML("afterend", html);
    else msgs.insertAdjacentHTML("afterbegin", html);
  } else {
    items.forEach((m) => renderMessage(m));
  }

  updateReadMarks();
  applyGroupingAll();
}

function renderAttachments(atts) {
  if (!atts || !atts.length) return "";
  return (
    `<div class="attachment">` +
    atts
      .map((a) => {
        const url = fileUrl(a.url, a.id || Date.now());
        if (a.mime && a.mime.startsWith("image/")) {
          return `<div><img src="${url}" alt="${escapeHtml(a.name || "image")}" /></div>`;
        }
        if (a.mime && a.mime.startsWith("video/")) {
          return `<div><video src="${url}" controls></video></div>`;
        }
        return `<div style="margin-top:8px">
          <a href="${url}" target="_blank" rel="noopener">📎 ${escapeHtml(a.name || "file")}</a>
        </div>`;
      })
      .join("") +
    `</div>`
  );
}

/* --- Time helpers (MSK) --- */
const _mskFmt = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  hour: "2-digit",
  minute: "2-digit",
});

function _parseServerISO(iso) {
  if (!iso) return null;
  let s = String(iso).trim();
  if (!/[zZ]$/.test(s) && !/[+-]\d\d:\d\d$/.test(s)) s += "Z";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function formatTimeMSK(iso) {
  const d = _parseServerISO(iso);
  if (!d) return "";
  return _mskFmt.format(d);
}

function _setMetaVisible(node, visible) {
  const meta = node.querySelector(".msgMeta");
  if (!meta) return;
  meta.style.display = visible ? "flex" : "none";
}

function applyGroupingAll() {
  const nodes = Array.from(msgs.querySelectorAll(".msg[data-message-id]"));
  nodes.forEach((n) => _setMetaVisible(n, true));

  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const cur = nodes[i];

    const prevSender = prev.getAttribute("data-sender-id");
    const curSender = cur.getAttribute("data-sender-id");
    if (!prevSender || !curSender || prevSender !== curSender) continue;

    const prevTs = parseInt(prev.getAttribute("data-ts") || "0", 10);
    const curTs = parseInt(cur.getAttribute("data-ts") || "0", 10);
    if (!prevTs || !curTs) continue;

    if (Math.abs(curTs - prevTs) <= 120000) {
      _setMetaVisible(prev, false);
      _setMetaVisible(cur, true);
    }
  }
}

function applyGroupingTail() {
  const nodes = Array.from(msgs.querySelectorAll(".msg[data-message-id]"));
  if (nodes.length < 2) return;

  const start = Math.max(0, nodes.length - 3);
  const slice = nodes.slice(start);

  slice.forEach((n) => _setMetaVisible(n, true));

  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const cur = slice[i];

    const prevSender = prev.getAttribute("data-sender-id");
    const curSender = cur.getAttribute("data-sender-id");
    if (!prevSender || !curSender || prevSender !== curSender) continue;

    const prevTs = parseInt(prev.getAttribute("data-ts") || "0", 10);
    const curTs = parseInt(cur.getAttribute("data-ts") || "0", 10);
    if (!prevTs || !curTs) continue;

    if (Math.abs(curTs - prevTs) <= 120000) {
      _setMetaVisible(prev, false);
      _setMetaVisible(cur, true);
    }
  }
}

function renderMessageHTML(m) {
  const isMe = me && m.sender_id === me.id;
  const cls = isMe ? "me" : "";

  const d = _parseServerISO(m.created_at);
  const ts = d ? d.getTime() : 0;
  const time = formatTimeMSK(m.created_at);
  const atts = renderAttachments(m.attachments);

  const readMark = isMe ? `<span data-msgid="${m.id}" class="readmark"><small>✓</small></span>` : "";
  const textPart = m.text ? `<div class="msgText">${escapeHtml(m.text)}</div>` : "";

  return `<div class="msg ${cls}" data-message-id="${m.id}" data-sender-id="${m.sender_id}" data-ts="${ts}">
    ${textPart}
    ${atts}
    <div class="msgMeta" style="display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:6px">
      ${time ? `<small class="msgTime">${escapeHtml(time)}</small>` : ""}
      ${readMark}
    </div>
  </div>`;
}

function renderMessage(m) {
  msgs.insertAdjacentHTML("beforeend", renderMessageHTML(m));
  if (isNearBottom()) msgs.scrollTop = msgs.scrollHeight;
  updateReadMarks();
  applyGroupingTail();
}

function updateReadMarks() {
  if (!me) return;
  document.querySelectorAll(".readmark").forEach((el) => {
    const id = parseInt(el.getAttribute("data-msgid") || "0", 10);
    el.innerHTML = `<small>${otherLastRead >= id ? "✓✓" : "✓"}</small>`;
  });
}

async function maybeMarkRead() {
  if (!currentChatId || !me) return;
  if (!isNearBottom()) return;

  const lastId = getLastRenderedMessageId();
  if (!lastId) return;

  try {
    await fetch(API + `/chats/dm/${currentChatId}/read`, {
      method: "POST",
      headers: authHeadersJson(),
      body: JSON.stringify({ last_read_message_id: lastId }),
    });
    setUnread(currentChatId, false);
  } catch (_) {}
}

/* =========================
   Send message + typing
   ========================= */

async function uploadSelectedFile() {
  const f = file && file.files && file.files[0];
  if (!f) return null;

  showUpload(f.name);

  const form = new FormData();
  form.append("file", f);

  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", API + "/files/upload");
    xhr.setRequestHeader("Authorization", "Bearer " + token);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setUploadProgress(pct);
      }
    };

    xhr.onload = () => {
      try {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
        }
      } catch (e) {
        reject(e);
      }
    };

    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(form);
  }).finally(() => {
    hideUpload();
    if (file) file.value = "";
  });
}

async function fetchWithTimeout(url, opts, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function sendMessage() {
  if (!token) return alert("Login first");
  if (!currentChatId) return alert("Select dialog");
  if (!me) return alert("Login first");
  if (isSending) return;

  const msgText = (text.value || "").trim();
  let fileIds = [];

  try {
    const up = await uploadSelectedFile();
    if (up && up.file_id) fileIds.push(up.file_id);
  } catch (e) {
    alert("Upload failed: " + String(e && e.message ? e.message : e));
    return;
  }

  if (!msgText && !fileIds.length) return;

  const prevText = text.value || "";
  text.value = "";
  saveDraftForCurrentChat();

  isSending = true;
  disableSend(true);

  let r;
  try {
    r = await fetchWithTimeout(API + `/chats/dm/${currentChatId}/send`, {
      method: "POST",
      headers: authHeadersJson(),
      body: JSON.stringify({ text: msgText || null, file_ids: fileIds }),
    });
  } catch (_) {
    text.value = prevText;
    saveDraftForCurrentChat();
    isSending = false;
    disableSend(false);
    alert("Send failed: network/timeout");
    return;
  }

  isSending = false;
  disableSend(false);

  if (!r.ok) {
    text.value = prevText;
    saveDraftForCurrentChat();
    alert("Send failed: " + (await readError(r)));
    return;
  }

  try {
    const msg = await r.json();
    if (msg && msg.id && !document.querySelector(`.msg[data-message-id="${msg.id}"]`)) {
      renderMessage(msg);
    }
    await maybeMarkRead();
  } catch (_) {}

  setUnread(currentChatId, false);
}

/* =========================
   Wire buttons + stable mobile input
   ========================= */

btnRegister && (btnRegister.onclick = register);
btnLogin && (btnLogin.onclick = login);
btnFind && (btnFind.onclick = search);
btnReloadDialogs && (btnReloadDialogs.onclick = async () => await loadDialogs());
btnSend && (btnSend.onclick = () => sendMessage());

if (text) {
  text.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  text.addEventListener("compositionend", () => {
    isComposing = false;
    saveDraftForCurrentChat();
  });

  text.addEventListener("input", () => {
    saveDraftForCurrentChat();

    if (!ws || ws.readyState !== 1 || !currentChatId) return;
    wsSend({ type: "typing:start", chat_id: currentChatId });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      wsSend({ type: "typing:stop", chat_id: currentChatId });
    }, 900);
  });

  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (isComposing) return;
      e.preventDefault();
      sendMessage();
    }
  });

  text.addEventListener("focus", () => {
    setTimeout(() => {
      try {
        text.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (_) {}
    }, 120);
  });
}

btnBack &&
  btnBack.addEventListener("click", () => {
    if (window.ui && typeof window.ui.showListMobile === "function") window.ui.showListMobile();
  });

/* =========================
   Boot
   ========================= */

(async () => {
  loadPersistedUnread();
  loadPersistedDrafts();

  if (token) {
    await loadMe();
    connectWS();
    await loadDialogs();
  } else {
    setMeUI();
  }
})();

window.startDM = startDM;
window.openChat = openChat;