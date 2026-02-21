/* =========================
   CONFIG
   ========================= */

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

const otherByChatId = new Map();

const unreadByChatId = new Map();
const draftsByChatId = new Map();

let dialogsReloadTimer = null;
let dialogsReloadInFlight = false;

let selectedFileObjectUrl = null;

let authMode = "login";

// upload cancel
let currentUploadXhr = null;

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
const avatarPreview = document.getElementById("avatarPreview");

const profileBox = document.getElementById("profileBox");
const authBox = document.getElementById("authBox");
const profileName = document.getElementById("profileName");
const profileAvatar = document.getElementById("profileAvatar");
const profileBirthYear = document.getElementById("profileBirthYear");
const profileAvatarInput = document.getElementById("profileAvatarInput");

const btnSaveProfile = document.getElementById("btnSaveProfile");
const btnLogout = document.getElementById("btnLogout");

const mePill = document.getElementById("mePill");

const chatTitle = document.getElementById("chatTitle");
const chatAvatar = document.getElementById("chatAvatar");
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

const btnBack = document.getElementById("btnBack");

const pageChats = document.getElementById("pageChats");
const pageAccount = document.getElementById("pageAccount");
const chatsLayout = document.getElementById("chatsLayout");
const tabChats = document.getElementById("tabChats");
const tabAccount = document.getElementById("tabAccount");

const chatPanel = document.getElementById("chatPanel");

// Selected file visual
const selectedFile = document.getElementById("selectedFile");
const sfIcon = document.getElementById("sfIcon");
const sfName = document.getElementById("sfName");
const sfSub = document.getElementById("sfSub");
const sfRemove = document.getElementById("sfRemove");

// auth switch
const authModeLogin = document.getElementById("authModeLogin");
const authModeRegister = document.getElementById("authModeRegister");
const registerFields = document.getElementById("registerFields");

/* =========================
   Viewport stability (mobile keyboard)
   ========================= */

let _isTextFocused = false;

function _clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function setViewportVars() {
  const vv = window.visualViewport;
  const vhPx = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--appVh", `${vhPx * 0.01}px`);

  let kb = 0;
  if (vv) {
    const layoutH = window.innerHeight;
    kb = Math.max(0, layoutH - vv.height - (vv.offsetTop || 0));
  }
  document.documentElement.style.setProperty("--kb", `${kb}px`);

  const isMobile = window.matchMedia && window.matchMedia("(max-width:980px)").matches;

  let lift = 0;
  if (_isTextFocused) {
    if (isMobile) {
      lift = _clamp(kb * 0.12, 10, 26);
      if (kb < 8) lift = 12;
    } else {
      lift = 12;
    }
  }
  document.documentElement.style.setProperty("--lift", `${lift}px`);
}

function applyComposerFocusUI(on) {
  if (!chatPanel) return;
  chatPanel.classList.toggle("kbdFocus", !!on);
}

(function bindViewportEvents() {
  setViewportVars();

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", () => requestAnimationFrame(setViewportVars));
    vv.addEventListener("scroll", () => requestAnimationFrame(setViewportVars));
  }
  window.addEventListener("resize", () => requestAnimationFrame(setViewportVars));
})();

/* =========================
   Helpers
   ========================= */

function authHeadersJson() {
  return { Authorization: "Bearer " + token, "Content-Type": "application/json" };
}

function escapeHtml(s) {
  return (s || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function readError(r) {
  let txt = "";
  try { txt = await r.text(); } catch (_) {}
  try {
    const j = JSON.parse(txt);
    if (j && j.detail) return String(j.detail);
  } catch (_) {}
  return txt || `HTTP ${r.status}`;
}

function normChatId(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function hasDialogRowInDOM(chatId) {
  const cid = normChatId(chatId);
  if (!cid) return false;
  return !!document.querySelector(`.item[data-chatid="${cid}"]`);
}

function fileUrl(pathOrUrl, v = null) {
  if (!pathOrUrl) return "";
  const sep1 = pathOrUrl.includes("?") ? "&" : "?";
  let out = API + pathOrUrl;

  if (token) out += `${sep1}token=${encodeURIComponent(token)}`;

  if (v !== null && v !== undefined && v !== "") {
    const sep2 = out.includes("?") ? "&" : "?";
    out += `${sep2}v=${encodeURIComponent(String(v))}`;
  }

  return out;
}

function ensureAvatarPath(uobj) {
  if (!uobj) return null;
  if (uobj.avatar_url) return uobj.avatar_url;
  if (uobj.avatar_file_id) return `/files/${uobj.avatar_file_id}`;
  return null;
}

/* =========================
   Tabs / mobile layout
   ========================= */

function setTab(name) {
  const isChats = name === "chats";
  tabChats && tabChats.classList.toggle("active", isChats);
  tabAccount && tabAccount.classList.toggle("active", !isChats);

  tabChats && tabChats.setAttribute("aria-selected", isChats ? "true" : "false");
  tabAccount && tabAccount.setAttribute("aria-selected", !isChats ? "true" : "false");

  pageChats && pageChats.classList.toggle("active", isChats);
  pageAccount && pageAccount.classList.toggle("active", !isChats);

  if (!isChats) {
    chatsLayout && chatsLayout.classList.remove("chats-open-chat");
    document.body.classList.remove("chat-full");
  }
}

function showChatMobile() {
  chatsLayout && chatsLayout.classList.add("chats-open-chat");
  document.body.classList.add("chat-full");
}

function showListMobile() {
  chatsLayout && chatsLayout.classList.remove("chats-open-chat");
  document.body.classList.remove("chat-full");
}

function isChatsTabActive() {
  return !!(pageChats && pageChats.classList.contains("active"));
}

function isChatVisibleOnScreen() {
  if (!isChatsTabActive()) return false;

  const isMobile = window.matchMedia && window.matchMedia("(max-width:980px)").matches;
  if (!isMobile) return true;

  return !!(chatsLayout && chatsLayout.classList.contains("chats-open-chat"));
}

function isDialogVisible(chatId) {
  const cid = normChatId(chatId);
  return !!(cid && currentChatId === cid && isChatVisibleOnScreen());
}

/* =========================
   Auth mode UI
   ========================= */

function setAuthMode(mode) {
  authMode = mode === "register" ? "register" : "login";

  if (authModeLogin) {
    authModeLogin.classList.toggle("active", authMode === "login");
    authModeLogin.setAttribute("aria-selected", authMode === "login" ? "true" : "false");
  }
  if (authModeRegister) {
    authModeRegister.classList.toggle("active", authMode === "register");
    authModeRegister.setAttribute("aria-selected", authMode === "register" ? "true" : "false");
  }

  if (registerFields) {
    const open = authMode === "register";
    registerFields.classList.toggle("open", open);
    registerFields.setAttribute("aria-hidden", open ? "false" : "true");
  }

  if (btnLogin) btnLogin.style.display = authMode === "login" ? "inline-flex" : "none";
  if (btnRegister) btnRegister.style.display = authMode === "register" ? "inline-flex" : "none";

  if (p) p.autocomplete = authMode === "login" ? "current-password" : "new-password";
}

/* =========================
   Years + avatar previews
   ========================= */

function fillYears() {
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now - 10; y >= now - 90; y--) years.push(y);

  if (birthYear) {
    for (const y of years) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      birthYear.appendChild(opt);
    }
  }

  if (profileBirthYear) {
    for (const y of years) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      profileBirthYear.appendChild(opt);
    }
  }
}

function bindAvatarPreviews() {
  if (avatarInput && avatarPreview) {
    avatarInput.addEventListener("change", () => {
      const f = avatarInput.files && avatarInput.files[0];
      if (!f) { avatarPreview.innerHTML = "👤"; return; }
      const url = URL.createObjectURL(f);
      avatarPreview.innerHTML = `<img src="${url}" alt="avatar">`;
    });
  }

  if (profileAvatarInput && profileAvatar) {
    profileAvatarInput.addEventListener("change", () => {
      const f = profileAvatarInput.files && profileAvatarInput.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      profileAvatar.innerHTML = `<img src="${url}" alt="avatar">`;
    });
  }
}

/* =========================
   Debounced dialogs reload
   ========================= */

function scheduleDialogsReload() {
  if (!token) return;
  if (dialogsReloadTimer) return;

  dialogsReloadTimer = setTimeout(async () => {
    dialogsReloadTimer = null;
    if (dialogsReloadInFlight) return;

    dialogsReloadInFlight = true;
    try {
      await loadDialogs();
    } catch (_) {
      // ignore
    } finally {
      dialogsReloadInFlight = false;
    }
  }, 300);
}

/* =========================
   Telegram-like Send visibility
   ========================= */

function hasComposerContent() {
  const t = (text && text.value ? text.value.trim() : "");
  const hasText = !!t;
  const hasFile = !!(file && file.files && file.files[0]);
  return hasText || hasFile;
}

function updateSendVisibility() {
  if (!btnSend) return;
  const show = hasComposerContent();
  btnSend.classList.toggle("isHidden", !show);
}

function disableSend(disabled) {
  if (!btnSend) return;
  btnSend.disabled = !!disabled;
  btnSend.style.opacity = disabled ? "0.7" : "";
}

/* =========================
   Selected file preview + progress on X button
   ========================= */

function fmtBytes(n) {
  const v = Number(n || 0);
  if (!v) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function extOf(name) {
  const s = String(name || "");
  const i = s.lastIndexOf(".");
  if (i <= 0) return "";
  return s.slice(i + 1).toLowerCase();
}

function typeLabelAndIcon(f) {
  const mime = (f && f.type) ? String(f.type) : "";
  if (mime.startsWith("image/")) return { label: "Фото", icon: "🖼️" };
  if (mime.startsWith("video/")) return { label: "Видео", icon: "🎥" };
  if (mime.startsWith("audio/")) return { label: "Аудио", icon: "🎵" };
  return { label: "Файл", icon: "📎" };
}

function revokeSelectedFileObjectUrl() {
  if (selectedFileObjectUrl) {
    try { URL.revokeObjectURL(selectedFileObjectUrl); } catch (_) {}
    selectedFileObjectUrl = null;
  }
}

function setBtnProgress(pct) {
  if (!sfRemove) return;
  const v = Math.max(0, Math.min(100, pct || 0));
  sfRemove.style.setProperty("--p", String(v));
}

function clearSelectedFileUI({ keepInput = false } = {}) {
  revokeSelectedFileObjectUrl();

  if (!keepInput && file) file.value = "";

  if (selectedFile) selectedFile.style.display = "none";
  if (sfIcon) sfIcon.textContent = "📎";
  if (sfName) sfName.textContent = "Файл";
  if (sfSub) sfSub.textContent = "—";

  if (sfRemove) {
    sfRemove.classList.remove("uploading", "done");
    sfRemove.title = "Cancel upload";
    setBtnProgress(0);
  }

  updateSendVisibility();
}

function showSelectedFileUI(f) {
  if (!selectedFile || !sfIcon || !sfName || !sfSub) return;
  if (!f) { clearSelectedFileUI(); return; }

  const { label, icon } = typeLabelAndIcon(f);

  sfName.textContent = label;

  const e = extOf(f.name);
  const mimeShort = f.type ? f.type : (e ? `.${e}` : "file");
  sfSub.textContent = `${fmtBytes(f.size)} • ${mimeShort}`;

  selectedFile.title = f.name || "";

  sfIcon.textContent = icon;
  revokeSelectedFileObjectUrl();

  if (f.type && f.type.startsWith("image/")) {
    selectedFileObjectUrl = URL.createObjectURL(f);
    sfIcon.innerHTML = `<img src="${selectedFileObjectUrl}" alt="preview">`;
  }

  selectedFile.style.display = "flex";

  if (sfRemove) {
    sfRemove.classList.remove("uploading", "done");
    setBtnProgress(0);
  }

  updateSendVisibility();
}

/* =========================
   Mini pill
   ========================= */

function renderMiniMePill() {
  if (!mePill) return;

  if (!me) {
    mePill.innerHTML = `<small>not logged in</small>`;
    return;
  }

  const path = ensureAvatarPath(me);
  const src = path ? fileUrl(path, me.avatar_file_id || Date.now()) : "";
  const av = src
    ? `<span class="meMiniAv"><img src="${src}" alt="me" onerror="this.onerror=null;this.parentElement.innerHTML='👤'"></span>`
    : `<span class="meMiniAv">👤</span>`;

  mePill.innerHTML = `${av}<span>@${escapeHtml(me.username)}</span>`;
}

function setOnlineUI(on) {
  onlineDot && onlineDot.classList.toggle("online", !!on);
  if (onlineText) onlineText.textContent = on ? "online" : "offline";
}

function setTypingUI(txt) {
  if (!typingText) return;
  typingText.textContent = txt || "";
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

/* =========================
   Account UI state
   ========================= */

function setAccountMode(loggedIn) {
  if (authBox) authBox.style.display = loggedIn ? "none" : "block";
  if (profileBox) profileBox.style.display = loggedIn ? "block" : "none";
}

function paintProfile() {
  if (!me) {
    setAccountMode(false);
    renderMiniMePill();
    return;
  }

  setAccountMode(true);

  if (profileName) profileName.textContent = `@${me.username || "—"}`;

  if (profileAvatar) {
    const path = ensureAvatarPath(me);
    const src = path ? fileUrl(path, me.avatar_file_id || Date.now()) : "";
    profileAvatar.innerHTML = src ? `<img src="${src}" alt="avatar" />` : `👤`;
  }

  if (profileBirthYear) {
    const by = me.birth_year ? String(me.birth_year) : "";
    profileBirthYear.value = by;
  }

  renderMiniMePill();
}

/* =========================
   Persist unread + drafts
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
      const cid = normChatId(k);
      if (cid) unreadByChatId.set(cid, !!v);
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

function paintUnreadBadge(chatId, show) {
  const cid = normChatId(chatId);
  if (!cid) return;

  const el = document.querySelector(`.item[data-chatid="${cid}"]`);
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

function setUnread(chatId, val) {
  const cid = normChatId(chatId);
  if (!cid) return;
  unreadByChatId.set(cid, !!val);
  savePersistedUnread();

  paintUnreadBadge(cid, !!val);

  if (!!val && !hasDialogRowInDOM(cid)) scheduleDialogsReload();
}

function loadPersistedDrafts() {
  try {
    const raw = localStorage.getItem(LS_DRAFTS);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const cid = normChatId(k);
      if (cid && typeof v === "string") draftsByChatId.set(cid, v);
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
  updateSendVisibility();
}

function restoreDraftForChat(chatId) {
  if (!text) return;
  const cid = normChatId(chatId);
  if (!cid) return;
  const v = draftsByChatId.get(cid) || "";
  text.value = v;
  updateSendVisibility();
}

/* =========================
   Upload progress (ONLY on X button)
   ========================= */

function showUploadUI() {
  disableSend(true);
  if (sfRemove) {
    sfRemove.classList.add("uploading");
    setBtnProgress(0);
  }
}

function setUploadProgress(pct) {
  setBtnProgress(pct);
}

function hideUploadUI() {
  disableSend(false);
  if (sfRemove) {
    sfRemove.classList.remove("uploading");
    sfRemove.classList.add("done");
    setTimeout(() => sfRemove && sfRemove.classList.remove("done"), 350);
  }
}

/* =========================
   Auth / Me
   ========================= */

async function register() {
  const username = (u?.value || "").trim();
  const password = (p?.value || "").trim();
  const by = birthYear ? (birthYear.value || "").trim() : "";
  const av = avatarInput && avatarInput.files ? avatarInput.files[0] : null;

  if (!username || !password) return alert("Введите username и password");

  const form = new FormData();
  form.append("username", username);
  form.append("password", password);
  if (by) form.append("birth_year", by);
  if (av) form.append("avatar", av);

  const r = await fetch(API + "/auth/register_form", { method: "POST", body: form });
  if (!r.ok) return alert("Register failed: " + (await readError(r)));

  const j = await r.json();
  if (j && j.access_token) {
    token = j.access_token;
    localStorage.setItem("token", token);

    await loadMe();
    connectWS();
    await loadDialogs();

    setTab("account");
  } else {
    alert("Registered. Now login.");
    setAuthMode("login");
  }
}

async function login() {
  const username = (u?.value || "").trim();
  const password = (p?.value || "").trim();

  if (!username || !password) return alert("Введите username и password");

  const r = await fetch(API + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!r.ok) return alert("Login failed: " + (await readError(r)));

  const j = await r.json();
  token = j.access_token;
  localStorage.setItem("token", token);

  await loadMe();
  connectWS();
  await loadDialogs();

  setTab("account");
}

async function loadMe() {
  if (!token) {
    me = null;
    paintProfile();
    return;
  }

  const r = await fetch(API + "/auth/me", { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) {
    me = null;
    paintProfile();
    return;
  }
  me = await r.json();
  paintProfile();
}

function logout() {
  token = "";
  me = null;
  localStorage.removeItem("token");

  try { if (ws) ws.close(); } catch (_) {}
  ws = null;

  setAccountMode(false);
  renderMiniMePill();

  clearSelectedFileUI();

  setTab("account");
  setAuthMode("login");
}

async function saveProfile() {
  if (!token || !me) return;

  const by = profileBirthYear ? (profileBirthYear.value || "").trim() : "";
  const av = profileAvatarInput && profileAvatarInput.files ? profileAvatarInput.files[0] : null;

  const byInt = by ? parseInt(by, 10) : null;
  const sameBirth = (me.birth_year || null) === (Number.isFinite(byInt) ? byInt : null);
  const hasAvatar = !!av;

  if (sameBirth && !hasAvatar) return;

  const form = new FormData();
  if (by) form.append("birth_year", by);
  if (av) form.append("avatar", av);

  const r = await fetch(API + "/auth/profile_update_form", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: form,
  });

  if (!r.ok) return alert("Save failed: " + (await readError(r)));

  const j = await r.json();
  me = j;
  if (profileAvatarInput) profileAvatarInput.value = "";
  paintProfile();
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
  try { if (ws) ws.close(); } catch (_) {}

  if (!token) return;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    wsRetry = 0;
    if (currentChatId) wsSend({ type: "presence:subscribe", chat_id: currentChatId });
  };

  ws.onclose = () => { scheduleReconnect(); };

  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };

  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (_) { return; }

    if (data.type === "message:new") {
      const cid = normChatId(data.chat_id);
      const msg = data.message;
      if (!cid || !msg) return;

      const senderId = msg?.sender_id;

      if (isDialogVisible(cid)) {
        if (msg?.id && !document.querySelector(`.msg[data-message-id="${msg.id}"]`)) {
          renderMessage(msg);
        }
        maybeMarkRead();
      } else {
        if (!(me && senderId && senderId === me.id)) {
          setUnread(cid, true);
        }
        if (!hasDialogRowInDOM(cid)) scheduleDialogsReload();
      }
    }

    if (data.type === "presence:state") {
      const cid = normChatId(data.chat_id);
      if (cid && cid === currentChatId && data.user_id === currentOtherId) {
        if (isDialogVisible(currentChatId)) setOnlineUI(!!data.online);
      }
    }

    if (data.type === "typing:start") {
      const cid = normChatId(data.chat_id);
      if (cid && cid === currentChatId && isDialogVisible(currentChatId)) {
        setTypingUI("typing…");
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => setTypingUI(""), 2000);
      }
    }

    if (data.type === "typing:stop") {
      const cid = normChatId(data.chat_id);
      if (cid && cid === currentChatId && isDialogVisible(currentChatId)) setTypingUI("");
    }

    if (data.type === "message:read") {
      const cid = normChatId(data.chat_id);
      if (cid && cid === currentChatId) {
        otherLastRead = Math.max(otherLastRead, data.last_read_message_id || 0);
        updateReadMarks();
      }
    }
  };
}

function wsSend(obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {}
}

/* =========================
   Poll fallback
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
        if (isDialogVisible(currentChatId)) {
          if (m?.id && m.id > lastId && !document.querySelector(`.msg[data-message-id="${m.id}"]`)) {
            renderMessage(m);
          }
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
   Avatars in dialogs
   ========================= */

function renderAvatarSpan(userObj, sizePx = 22) {
  const path = ensureAvatarPath(userObj);
  const v = userObj && userObj.avatar_file_id ? userObj.avatar_file_id : Date.now();
  const src = path ? fileUrl(path, v) : "";

  const boxStyle =
    `width:${sizePx}px;height:${sizePx}px;border-radius:999px;` +
    `overflow:hidden;display:inline-flex;align-items:center;justify-content:center;` +
    `border:1px solid rgba(255,255,255,.12);flex:0 0 auto;`;

  if (!src) {
    return `<span style="${boxStyle};color:rgba(255,255,255,.35);font-weight:900;font-size:12px">?</span>`;
  }

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

/* =========================
   Search / Dialogs
   ========================= */

async function search() {
  if (!token) return alert("Login first");
  const query = (q?.value || "").trim();

  const r = await fetch(API + `/users/search?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: "Bearer " + token },
  });

  if (!r.ok) return alert("Search failed: " + (await readError(r)));

  const list = await r.json();

  if (!searchRes) return;
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

  if (!r.ok) return alert("Start DM failed: " + (await readError(r)));

  const j = await r.json();
  const cid = normChatId(j.chat_id);

  if (j.with && cid) otherByChatId.set(cid, j.with);

  await loadDialogs();
  if (cid) openChat(cid, otherId, username);
}

async function loadDialogs() {
  if (!token) return;

  const r = await fetch(API + "/chats/dm/list", { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) return alert("Load dialogs failed: " + (await readError(r)));

  const list = await r.json();

  if (!dialogs) return;
  dialogs.innerHTML = list
    .map((d) => {
      const cid = normChatId(d.chat_id);
      const other = d.other || {};
      const online = d.other_online ? "online" : "";

      if (cid && other) otherByChatId.set(cid, other);

      const hasUnread = cid ? unreadByChatId.get(cid) === true : false;
      const safeName = String(other.username || "").replaceAll("'", "");

      const av = renderAvatarSpan(other, 22);

      return `<div class="item" data-chatid="${cid ?? ""}" onclick="openChat(${cid}, ${other.id}, '${safeName}')">
        <div class="dialogRow" style="display:flex;align-items:center;gap:8px">
          <span class="dot ${online}"></span>
          ${av}
          <div style="font-weight:600">@${escapeHtml(other.username || "")}</div>
          ${hasUnread ? `<span class="unreadBadge">NEW</span>` : ``}
        </div>
        <small>chat_id: ${cid ?? "—"}</small>
      </div>`;
    })
    .join("");

  for (const [cid, v] of unreadByChatId.entries()) {
    paintUnreadBadge(cid, v === true);
  }
}

/* =========================
   Messages
   ========================= */

function setChatHeaderUser(other) {
  const username = other?.username ? String(other.username) : "—";

  if (chatTitle) chatTitle.textContent = `@${username}`;

  if (chatAvatar) {
    const path = ensureAvatarPath(other);
    const v = other && other.avatar_file_id ? other.avatar_file_id : Date.now();
    const src = path ? fileUrl(path, v) : "";
    chatAvatar.innerHTML = src
      ? `<img src="${src}" alt="avatar" onerror="this.onerror=null;this.parentElement.innerHTML='👤'">`
      : "👤";
  }
}

async function openChat(chatId, otherId, title) {
  const cid = normChatId(chatId);
  if (!cid) return;

  saveDraftForCurrentChat();

  currentChatId = cid;
  currentOtherId = otherId;
  nextBeforeId = null;
  otherLastRead = 0;

  setUnread(cid, false);
  restoreDraftForChat(cid);

  const other = otherByChatId.get(cid) || { id: otherId, username: title, avatar_url: null, avatar_file_id: null };

  setChatHeaderUser(other);

  setTypingUI("");
  setOnlineUI(false);

  if (msgs) msgs.innerHTML = `<div class="loading">Loading…</div>`;

  wsSend({ type: "presence:subscribe", chat_id: cid });

  await loadMessagesPage();

  if (msgs) msgs.scrollTop = msgs.scrollHeight;
  await maybeMarkRead();

  if (msgs) {
    msgs.onscroll = async () => {
      if (msgs.scrollTop < 40 && nextBeforeId) {
        const prevHeight = msgs.scrollHeight;
        await loadMessagesPage(nextBeforeId, true);
        msgs.scrollTop = msgs.scrollHeight - prevHeight + msgs.scrollTop;
      }
      await maybeMarkRead();
    };
  }

  showChatMobile();
  startChatPoll();

  updateSendVisibility();
}

async function loadMessagesPage(beforeId = null, prepend = false) {
  if (!currentChatId) return;

  const url = new URL(API + `/chats/dm/${currentChatId}/messages`, location.origin);
  url.searchParams.set("limit", "50");
  if (beforeId) url.searchParams.set("before_id", String(beforeId));

  const r = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) return alert("Load messages failed: " + (await readError(r)));

  const j = await r.json();
  nextBeforeId = j.next_before_id;
  otherLastRead = j.read_state?.other_last_read || otherLastRead;

  const items = j.items || [];
  if (!prepend && msgs) msgs.innerHTML = "";

  if (msgs && nextBeforeId) {
    const topHint = `<div class="loading" id="loadmore">Scroll up to load more…</div>`;
    if (prepend) msgs.insertAdjacentHTML("afterbegin", topHint);
    else msgs.insertAdjacentHTML("beforeend", topHint);
  }

  if (!msgs) return;

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
  if (!isDialogVisible(currentChatId)) return;
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

  showUploadUI();

  const form = new FormData();
  form.append("file", f);

  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    currentUploadXhr = xhr;

    xhr.open("POST", API + "/files/upload");
    xhr.setRequestHeader("Authorization", "Bearer " + token);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setUploadProgress(pct);
      }
    };

    xhr.onload = () => {
      currentUploadXhr = null;
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

    xhr.onerror = () => {
      currentUploadXhr = null;
      reject(new Error("Network error"));
    };

    xhr.onabort = () => {
      currentUploadXhr = null;
      reject(new Error("Upload cancelled"));
    };

    xhr.send(form);
  }).finally(() => {
    hideUploadUI();
    setBtnProgress(0);
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

  const hasFile = !!(file && file.files && file.files[0]);
  if (!msgText && !hasFile) return;

  if (hasFile) {
    try {
      const up = await uploadSelectedFile();
      if (up && up.file_id) fileIds.push(up.file_id);
    } catch (e) {
      alert("Upload failed: " + String(e && e.message ? e.message : e));
      return;
    }
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
    updateSendVisibility();
    return;
  }

  isSending = false;
  disableSend(false);

  if (!r.ok) {
    text.value = prevText;
    saveDraftForCurrentChat();
    alert("Send failed: " + (await readError(r)));
    updateSendVisibility();
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

  clearSelectedFileUI();
  updateSendVisibility();
}

/* =========================
   Wire buttons + inputs
   ========================= */

function bindUI() {
  tabChats && tabChats.addEventListener("click", () => setTab("chats"));
  tabAccount && tabAccount.addEventListener("click", () => setTab("account"));

  btnBack && btnBack.addEventListener("click", showListMobile);

  authModeLogin && authModeLogin.addEventListener("click", () => setAuthMode("login"));
  authModeRegister && authModeRegister.addEventListener("click", () => setAuthMode("register"));

  btnRegister && (btnRegister.onclick = register);
  btnLogin && (btnLogin.onclick = login);

  btnFind && (btnFind.onclick = search);
  btnReloadDialogs && (btnReloadDialogs.onclick = async () => await loadDialogs());
  btnSend && (btnSend.onclick = () => sendMessage());

  btnLogout && (btnLogout.onclick = logout);
  btnSaveProfile && (btnSaveProfile.onclick = saveProfile);

  if (file) {
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      showSelectedFileUI(f || null);
      updateSendVisibility();
    });
  }

  // cancel upload or remove file
  sfRemove && sfRemove.addEventListener("click", () => {
    if (currentUploadXhr) {
      try { currentUploadXhr.abort(); } catch (_) {}
    }
    clearSelectedFileUI();
    updateSendVisibility();
  });

  if (text) {
    text.addEventListener("compositionstart", () => { isComposing = true; });
    text.addEventListener("compositionend", () => {
      isComposing = false;
      saveDraftForCurrentChat();
    });

    text.addEventListener("input", () => {
      saveDraftForCurrentChat();
      updateSendVisibility();

      if (!ws || ws.readyState !== 1 || !currentChatId) return;
      if (!isDialogVisible(currentChatId)) return;

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
      _isTextFocused = true;
      applyComposerFocusUI(true);
      requestAnimationFrame(() => {
        setViewportVars();
        try {
          if (msgs && isNearBottom()) msgs.scrollTop = msgs.scrollHeight;
        } catch (_) {}
      });
    });

    text.addEventListener("blur", () => {
      _isTextFocused = false;
      applyComposerFocusUI(false);
      requestAnimationFrame(setViewportVars);
    });
  }
}

/* =========================
   Boot
   ========================= */

(async () => {
  loadPersistedUnread();
  loadPersistedDrafts();

  fillYears();
  bindAvatarPreviews();
  bindUI();

  setTab("account");
  setAuthMode("login");

  if (token) {
    await loadMe();
    if (me) {
      connectWS();
      await loadDialogs();
    } else {
      logout();
    }
  } else {
    paintProfile();
  }

  setViewportVars();
  updateSendVisibility();
})();

window.startDM = startDM;
window.openChat = openChat;