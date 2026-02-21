/* =========================
   CONFIG
   ========================= */

// Base API prefix. If backend served on same origin, leave "".
const API = "";

/**
 * Files auth mode:
 * - "query_token"  -> keep current behavior: /files/:id?token=...
 * - "plain"        -> do not append token. Use only if backend supports public or cookie auth for /files/*
 *
 * IMPORTANT: For private files, professional solution is signed URLs or httpOnly cookie auth.
 */
const FILES_AUTH_MODE = "query_token";

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

// Presence/typing state for header
let _otherOnline = false;
let _isTyping = false;

// Poll capabilities
let _supportsAfterId = null; // unknown until tested

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

  if (FILES_AUTH_MODE === "query_token" && token) out += `${sep1}token=${encodeURIComponent(token)}`;

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

function clearNode(el) {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
}

function mk(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "html") el.innerHTML = v; // only for trusted static html
    else if (k === "dataset" && v && typeof v === "object") {
      for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = String(dv);
    } else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2), v);
    } else if (v !== null && v !== undefined) {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    if (typeof c === "string") el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }
  return el;
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

  function fillSelect(sel) {
    if (!sel) return;
    for (const y of years) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      sel.appendChild(opt);
    }
  }

  fillSelect(birthYear);
  fillSelect(profileBirthYear);
}

function bindAvatarPreviews() {
  if (avatarInput && avatarPreview) {
    avatarInput.addEventListener("change", () => {
      const f = avatarInput.files && avatarInput.files[0];
      if (!f) { avatarPreview.textContent = "👤"; return; }
      const url = URL.createObjectURL(f);
      clearNode(avatarPreview);
      const img = mk("img", { src: url, alt: "avatar" });
      avatarPreview.appendChild(img);
    });
  }

  if (profileAvatarInput && profileAvatar) {
    profileAvatarInput.addEventListener("change", () => {
      const f = profileAvatarInput.files && profileAvatarInput.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      clearNode(profileAvatar);
      const img = mk("img", { src: url, alt: "avatar" });
      profileAvatar.appendChild(img);
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

  revokeSelectedFileObjectUrl();
  clearNode(sfIcon);

  if (f.type && f.type.startsWith("image/")) {
    selectedFileObjectUrl = URL.createObjectURL(f);
    const img = mk("img", { src: selectedFileObjectUrl, alt: "preview" });
    sfIcon.appendChild(img);
  } else {
    sfIcon.textContent = icon;
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

  clearNode(mePill);

  const avSpan = mk("span", { class: "meMiniAv" });
  if (src) {
    const img = mk("img", { src, alt: "me" });
    img.addEventListener("error", () => {
      clearNode(avSpan);
      avSpan.textContent = "👤";
    });
    avSpan.appendChild(img);
  } else {
    avSpan.textContent = "👤";
  }

  mePill.appendChild(avSpan);
  mePill.appendChild(mk("span", { text: `@${me.username || ""}` }));
}

/* =========================
   Header status helpers
   ========================= */

function _paintHeaderStatus() {
  if (!onlineText) return;

  if (_isTyping) {
    onlineText.textContent = "typing…";
    if (onlineDot) onlineDot.classList.add("isHidden");
    return;
  }

  if (onlineDot) onlineDot.classList.remove("isHidden");
  onlineText.textContent = _otherOnline ? "online" : "offline";
}

function setOnlineUI(on) {
  _otherOnline = !!on;
  onlineDot && onlineDot.classList.toggle("online", _otherOnline);
  _paintHeaderStatus();
}

function setTypingUI(on) {
  _isTyping = !!on;
  if (typingText) typingText.textContent = ""; // legacy placeholder
  _paintHeaderStatus();
}

function isNearBottom() {
  if (!msgs) return true;
  const threshold = 80;
  return msgs.scrollHeight - (msgs.scrollTop + msgs.clientHeight) < threshold;
}

function getLastRenderedMessageId() {
  if (!msgs) return 0;
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
    clearNode(profileAvatar);
    if (src) {
      const img = mk("img", { src, alt: "avatar" });
      img.addEventListener("error", () => { profileAvatar.textContent = "👤"; });
      profileAvatar.appendChild(img);
    } else {
      profileAvatar.textContent = "👤";
    }
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
  if (!old) row.appendChild(mk("span", { class: "unreadBadge", text: "NEW" }));
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
  ws = null;

  if (!token) return;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    wsRetry = 0;
    // subscribe current chat if open
    if (currentChatId) wsSend({ type: "presence:subscribe", chat_id: currentChatId });
  };

  ws.onclose = () => {
    scheduleReconnect();
  };

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
        setTypingUI(true);
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => setTypingUI(false), 2200);
      }
    }

    if (data.type === "typing:stop") {
      const cid = normChatId(data.chat_id);
      if (cid && cid === currentChatId && isDialogVisible(currentChatId)) setTypingUI(false);
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
   Poll fallback (adaptive + after_id if supported)
   ========================= */

let _pollDelayMs = 2500;
let _pollNoNewCount = 0;

function startChatPoll() {
  stopChatPoll();
  _pollDelayMs = 2500;
  _pollNoNewCount = 0;

  pollTimer = setInterval(async () => {
    if (!token || !currentChatId) return;
    if (ws && ws.readyState === 1) return;

    await pollOnce();
  }, _pollDelayMs);
}

function stopChatPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollOnce() {
  const lastId = getLastRenderedMessageId();
  const url = new URL(API + `/chats/dm/${currentChatId}/messages`, location.origin);
  url.searchParams.set("limit", "50");

  // Try after_id if we already know it is supported
  if (_supportsAfterId === true) url.searchParams.set("after_id", String(lastId));

  try {
    const r = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });

    // If server rejects after_id, fallback and remember
    if (!r.ok) {
      if (_supportsAfterId === true) {
        _supportsAfterId = false;
      }
      return;
    }

    const j = await r.json();
    otherLastRead = j.read_state?.other_last_read || otherLastRead;

    const items = j.items || [];

    let appended = 0;
    for (const m of items) {
      if (!m?.id) continue;
      if (document.querySelector(`.msg[data-message-id="${m.id}"]`)) continue;
      // If after_id is not supported, items may include older messages too; only render new ones
      if (m.id <= lastId) continue;

      if (isDialogVisible(currentChatId)) {
        renderMessage(m);
        appended++;
      }
    }

    updateReadMarks();
    await maybeMarkRead();

    // Learn support: if we asked after_id and got only new, ok. If we didn't ask, do a one-time probe later.
    if (_supportsAfterId === null) {
      // quick probe: if server ignored after_id, we'd see older ids; but we didn't send it.
      // Do a single explicit probe next tick.
      _supportsAfterId = false;
      // Next time we open chat we can probe; keep conservative.
    }

    // Adaptive backoff
    if (appended === 0) {
      _pollNoNewCount++;
      if (_pollNoNewCount >= 3) {
        // increase interval up to 20s
        const next = Math.min(20000, Math.round(_pollDelayMs * 1.6));
        if (next !== _pollDelayMs) {
          _pollDelayMs = next;
          startChatPoll();
        }
      }
    } else {
      _pollNoNewCount = 0;
      // return to base if we were slow
      if (_pollDelayMs !== 2500) {
        _pollDelayMs = 2500;
        startChatPoll();
      }
    }
  } catch (_) {}
}

/* =========================
   Avatars in dialogs
   ========================= */

function renderAvatarNode(userObj, sizePx = 22) {
  const path = ensureAvatarPath(userObj);
  const v = userObj && userObj.avatar_file_id ? userObj.avatar_file_id : Date.now();
  const src = path ? fileUrl(path, v) : "";

  const boxStyle =
    `width:${sizePx}px;height:${sizePx}px;border-radius:999px;` +
    `overflow:hidden;display:inline-flex;align-items:center;justify-content:center;` +
    `border:1px solid rgba(255,255,255,.12);flex:0 0 auto;`;

  const span = mk("span", { style: boxStyle });

  if (!src) {
    span.style.color = "rgba(255,255,255,.35)";
    span.style.fontWeight = "900";
    span.style.fontSize = "12px";
    span.textContent = "?";
    return span;
  }

  const img = mk("img", {
    src,
    alt: "avatar",
    style: "width:100%;height:100%;object-fit:cover;display:block",
  });

  img.addEventListener("error", () => {
    clearNode(span);
    span.style.color = "rgba(255,255,255,.35)";
    span.style.fontWeight = "900";
    span.style.fontSize = "12px";
    span.style.display = "inline-flex";
    span.style.alignItems = "center";
    span.style.justifyContent = "center";
    span.textContent = "?";
  });

  span.appendChild(img);
  return span;
}

/* =========================
   Search / Dialogs (SAFE DOM RENDER)
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
  clearNode(searchRes);

  for (const uu of (list || [])) {
    const row = mk("div", {
      class: "item",
      dataset: { userid: uu.id, username: uu.username || "" },
    }, [
      mk("span", { text: `@${uu.username || ""}` })
    ]);

    row.addEventListener("click", () => startDM(uu.id, uu.username || ""));
    searchRes.appendChild(row);
  }
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
  clearNode(dialogs);

  for (const d of (list || [])) {
    const cid = normChatId(d.chat_id);
    const other = d.other || {};
    const online = !!d.other_online;

    if (cid && other) otherByChatId.set(cid, other);

    const hasUnread = cid ? unreadByChatId.get(cid) === true : false;

    const row = mk("div", {
      class: "item",
      dataset: { chatid: cid ?? "" },
    });

    const dialogRow = mk("div", { class: "dialogRow", style: "display:flex;align-items:center;gap:8px" });

    const dot = mk("span", { class: `dot ${online ? "online" : ""}` });
    const av = renderAvatarNode(other, 22);
    const name = mk("div", { style: "font-weight:600", text: `@${other.username || ""}` });

    dialogRow.appendChild(dot);
    dialogRow.appendChild(av);
    dialogRow.appendChild(name);

    if (hasUnread) dialogRow.appendChild(mk("span", { class: "unreadBadge", text: "NEW" }));

    row.appendChild(dialogRow);
    row.appendChild(mk("small", { text: `chat_id: ${cid ?? "—"}` }));

    row.addEventListener("click", () => openChat(cid, other.id, other.username || ""));
    dialogs.appendChild(row);
  }

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

    clearNode(chatAvatar);
    if (src) {
      const img = mk("img", { src, alt: "avatar" });
      img.addEventListener("error", () => { chatAvatar.textContent = "👤"; });
      chatAvatar.appendChild(img);
    } else {
      chatAvatar.textContent = "👤";
    }
  }
}

function _parseServerISO(iso) {
  if (!iso) return null;
  let s = String(iso).trim();
  if (!/[zZ]$/.test(s) && !/[+-]\d\d:\d\d$/.test(s)) s += "Z";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

const _mskFmt = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  hour: "2-digit",
  minute: "2-digit",
});

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
  if (!msgs) return;
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
  if (!msgs) return;
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

function renderAttachmentsNode(atts) {
  if (!atts || !atts.length) return null;

  const box = mk("div", { class: "attachment" });

  for (const a of atts) {
    const url = fileUrl(a.url, a.id || Date.now());

    if (a.mime && a.mime.startsWith("image/")) {
      const wrap = mk("div");
      const img = mk("img", { src: url, alt: a.name || "image", loading: "lazy", decoding: "async" });
      // avoid scroll jump: if user is at bottom, keep bottom after image load
      img.addEventListener("load", () => {
        if (isNearBottom() && msgs) msgs.scrollTop = msgs.scrollHeight;
      });
      wrap.appendChild(img);
      box.appendChild(wrap);
      continue;
    }

    if (a.mime && a.mime.startsWith("video/")) {
      const wrap = mk("div");
      const v = mk("video", { src: url, controls: "true", preload: "metadata" });
      wrap.appendChild(v);
      box.appendChild(wrap);
      continue;
    }

    const linkWrap = mk("div", { style: "margin-top:8px" });
    const link = mk("a", { href: url, target: "_blank", rel: "noopener" }, [
      `📎 ${a.name || "file"}`
    ]);
    linkWrap.appendChild(link);
    box.appendChild(linkWrap);
  }

  return box;
}

function renderMessageNode(m) {
  const isMe = me && m.sender_id === me.id;
  const cls = isMe ? "msg me" : "msg";

  const d = _parseServerISO(m.created_at);
  const ts = d ? d.getTime() : 0;
  const time = formatTimeMSK(m.created_at);

  const root = mk("div", {
    class: cls,
    dataset: { messageId: m.id, senderId: m.sender_id, ts: ts },
  });

  if (m.text) {
    root.appendChild(mk("div", { class: "msgText", text: m.text }));
  }

  const attsNode = renderAttachmentsNode(m.attachments);
  if (attsNode) root.appendChild(attsNode);

  const meta = mk("div", {
    class: "msgMeta",
    style: "display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:6px",
  });

  if (time) meta.appendChild(mk("small", { class: "msgTime", text: time }));

  if (isMe) {
    const mark = mk("span", { class: "readmark", dataset: { msgid: m.id } });
    mark.appendChild(mk("small", { text: "✓" }));
    meta.appendChild(mark);
  }

  root.appendChild(meta);
  return root;
}

function renderMessage(m) {
  if (!msgs) return;
  const shouldStickBottom = isNearBottom();

  msgs.appendChild(renderMessageNode(m));

  if (shouldStickBottom) msgs.scrollTop = msgs.scrollHeight;

  updateReadMarks();
  applyGroupingTail();
}

function updateReadMarks() {
  if (!me) return;
  document.querySelectorAll(".readmark").forEach((el) => {
    const id = parseInt(el.getAttribute("data-msgid") || el.dataset.msgid || "0", 10);
    const s = (otherLastRead >= id) ? "✓✓" : "✓";
    const small = el.querySelector("small");
    if (small) small.textContent = s;
    else el.textContent = s;
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
   Scroll anchoring for prepend (prevents jumps)
   ========================= */

function getTopVisibleMessageAnchor() {
  if (!msgs) return null;
  const list = Array.from(msgs.querySelectorAll(".msg[data-message-id]"));
  if (!list.length) return null;

  const containerTop = msgs.getBoundingClientRect().top;
  for (const el of list) {
    const r = el.getBoundingClientRect();
    if (r.bottom > containerTop + 4) {
      return { id: el.getAttribute("data-message-id"), top: r.top };
    }
  }
  // fallback to first
  const el = list[0];
  return { id: el.getAttribute("data-message-id"), top: el.getBoundingClientRect().top };
}

function restoreAnchor(anchor) {
  if (!msgs || !anchor?.id) return;
  const el = msgs.querySelector(`.msg[data-message-id="${anchor.id}"]`);
  if (!el) return;
  const newTop = el.getBoundingClientRect().top;
  const delta = newTop - anchor.top;
  msgs.scrollTop += delta;
}

/* =========================
   Open chat + load messages
   ========================= */

async function openChat(chatId, otherId, title) {
  const cid = normChatId(chatId);
  if (!cid) return;

  saveDraftForCurrentChat();

  // Unsubscribe previous chat presence (if backend supports it)
  if (currentChatId && currentChatId !== cid) {
    wsSend({ type: "presence:unsubscribe", chat_id: currentChatId });
  }

  currentChatId = cid;
  currentOtherId = otherId;
  nextBeforeId = null;
  otherLastRead = 0;

  // reset header presence/typing state
  _otherOnline = false;
  _isTyping = false;
  setOnlineUI(false);
  setTypingUI(false);

  setUnread(cid, false);
  restoreDraftForChat(cid);

  const other = otherByChatId.get(cid) || { id: otherId, username: title, avatar_url: null, avatar_file_id: null };
  setChatHeaderUser(other);

  if (msgs) {
    clearNode(msgs);
    msgs.appendChild(mk("div", { class: "loading", text: "Loading…" }));
  }

  wsSend({ type: "presence:subscribe", chat_id: cid });

  await loadMessagesPage();

  if (msgs) msgs.scrollTop = msgs.scrollHeight;
  await maybeMarkRead();

  if (msgs) {
    msgs.onscroll = async () => {
      if (msgs.scrollTop < 40 && nextBeforeId) {
        const anchor = getTopVisibleMessageAnchor();
        await loadMessagesPage(nextBeforeId, true);
        // restore
        requestAnimationFrame(() => restoreAnchor(anchor));
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

  if (!msgs) return;

  if (!prepend) {
    clearNode(msgs);
  } else {
    // remove old "loadmore" hint if exists (we'll re-add it)
    const old = document.getElementById("loadmore");
    if (old) old.remove();
  }

  if (nextBeforeId) {
    const topHint = mk("div", { class: "loading", id: "loadmore", text: "Scroll up to load more…" });
    if (prepend) msgs.insertAdjacentElement("afterbegin", topHint);
    else msgs.appendChild(topHint);
  }

  if (prepend) {
    // Insert new messages after loadmore
    const lm = document.getElementById("loadmore");
    const frag = document.createDocumentFragment();
    for (const m of items) frag.appendChild(renderMessageNode(m));
    if (lm && lm.parentNode === msgs) msgs.insertBefore(frag, lm.nextSibling);
    else msgs.insertBefore(frag, msgs.firstChild);
  } else {
    const frag = document.createDocumentFragment();
    for (const m of items) frag.appendChild(renderMessageNode(m));
    msgs.appendChild(frag);
  }

  updateReadMarks();
  applyGroupingAll();
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
   Typing sender (debounced)
   ========================= */

let _typingStartSentAt = 0;
let _typingStopTimer = null;

function sendTypingStartDebounced() {
  if (!ws || ws.readyState !== 1 || !currentChatId) return;
  if (!isDialogVisible(currentChatId)) return;

  const now = Date.now();
  // send start at most once per 1200ms
  if (now - _typingStartSentAt > 1200) {
    wsSend({ type: "typing:start", chat_id: currentChatId });
    _typingStartSentAt = now;
  }

  if (_typingStopTimer) clearTimeout(_typingStopTimer);
  _typingStopTimer = setTimeout(() => {
    wsSend({ type: "typing:stop", chat_id: currentChatId });
  }, 1100);
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
      sendTypingStartDebounced();
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