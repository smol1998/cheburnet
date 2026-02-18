// IMPORTANT: when frontend is served by FastAPI, use relative API
const API = ""

let token = localStorage.getItem("token") || "";
let me = null;
let ws = null;

let currentChatId = null;
let currentOtherId = null;
let nextBeforeId = null;
let otherLastRead = 0;

let typingTimer = null;
let typingActive = false;
let typingStopTimer = null;

function authHeaders() {
  return { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
}
function setMeUI() {
  document.getElementById("me").innerHTML = me ? `@${me.username}` : `<small>not logged in</small>`;
}
function setOnlineUI(on) {
  const dot = document.getElementById("onlineDot");
  dot.classList.toggle("online", !!on);
}
function setTypingUI(txt) {
  document.getElementById("typingText").textContent = txt || "";
}

async function readError(r) {
  let txt = "";
  try { txt = await r.text(); } catch (_) {}
  // FastAPI often returns {"detail": "..."}; try parse
  try {
    const j = JSON.parse(txt);
    if (j && j.detail) return String(j.detail);
  } catch (_) {}
  return txt || `HTTP ${r.status}`;
}

async function register() {
  const username = u.value.trim(), password = p.value.trim();
  const r = await fetch(API + "/auth/register", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!r.ok) {
    alert("Register failed: " + await readError(r));
    return;
  }
  alert("Registered. Now login.");
}

async function login() {
  const username = u.value.trim(), password = p.value.trim();
  const r = await fetch(API + "/auth/login", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!r.ok) {
    alert("Login failed: " + await readError(r));
    return;
  }
  const j = await r.json();
  token = j.access_token;
  localStorage.setItem("token", token);
  await loadMe();
  connectWS();
  await loadDialogs();
}

async function loadMe() {
  const r = await fetch(API + "/auth/me", { headers: { "Authorization":"Bearer " + token }});
  if (!r.ok) {
    me = null;
    setMeUI();
    return;
  }
  me = await r.json();
  setMeUI();
}

function connectWS() {
  if (ws) ws.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);



  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);

    if (data.type === "message:new") {
      if (data.chat_id === currentChatId) {
        renderMessage(data.message);
        maybeMarkRead();
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

  ws.onopen = () => console.log("ws connected");
  ws.onerror = (e) => console.log("ws error", e);
}

function wsSend(obj) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

async function search() {
  if (!token) return alert("Login first");
  const query = q.value.trim();
  const r = await fetch(API + `/users/search?q=${encodeURIComponent(query)}`, {
    headers: { "Authorization":"Bearer " + token }
  });
  if (!r.ok) {
    alert("Search failed: " + await readError(r));
    return;
  }
  const list = await r.json();
  searchRes.innerHTML = list.map(u =>
    `<div class="list-item" onclick="startDM(${u.id}, '${u.username.replaceAll("'","")}')">@${u.username}</div>`
  ).join("");
}

async function startDM(otherId, username) {
  const r = await fetch(API + "/chats/dm/start", {
    method:"POST",
    headers: authHeaders(),
    body: JSON.stringify({ other_user_id: otherId })
  });
  if (!r.ok) {
    alert("Start DM failed: " + await readError(r));
    return;
  }
  const j = await r.json();
  await loadDialogs();
  openChat(j.chat_id, otherId, username);
}

async function loadDialogs() {
  if (!token) return;
  const r = await fetch(API + "/chats/dm/list", { headers: { "Authorization":"Bearer " + token }});
  if (!r.ok) {
    alert("Load dialogs failed: " + await readError(r));
    return;
  }
  const list = await r.json();
  dialogs.innerHTML = list.map(d => {
    const online = d.other_online ? "online" : "";
    return `<div class="list-item" onclick="openChat(${d.chat_id}, ${d.other.id}, '${d.other.username.replaceAll("'","")}')">
      <span class="dot ${online}"></span> @${d.other.username}<br><small>chat_id: ${d.chat_id}</small>
    </div>`;
  }).join("");
}

async function openChat(chatId, otherId, title) {
  currentChatId = chatId;
  currentOtherId = otherId;
  nextBeforeId = null;
  otherLastRead = 0;

  chatTitle.textContent = `${title} (id ${chatId})`;
  setTypingUI("");
  setOnlineUI(false);
  msgs.innerHTML = `<div class="loadmore"><small>Loading…</small></div>`;

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
}

async function loadMessagesPage(beforeId=null, prepend=false) {
  if (!currentChatId) return;

  const url = new URL(API + `/chats/dm/${currentChatId}/messages`, location.origin);
  url.searchParams.set("limit", "50");
  if (beforeId) url.searchParams.set("before_id", String(beforeId));

  const r = await fetch(url.toString(), { headers: { "Authorization":"Bearer " + token }});
  if (!r.ok) {
    alert("Load messages failed: " + await readError(r));
    return;
  }
  const j = await r.json();

  nextBeforeId = j.next_before_id;
  otherLastRead = j.read_state?.other_last_read || otherLastRead;

  const items = j.items || [];
  if (!prepend) msgs.innerHTML = "";

  if (nextBeforeId) {
    const topHint = `<div class="loadmore" id="loadmore"><small>Scroll up to load more…</small></div>`;
    if (prepend) {
      msgs.insertAdjacentHTML("afterbegin", topHint);
    } else {
      msgs.insertAdjacentHTML("beforeend", topHint);
    }
  }

  if (prepend) {
    const html = items.map(m => renderMessageHTML(m)).join("");
    const lm = document.getElementById("loadmore");
    if (lm) lm.insertAdjacentHTML("afterend", html);
    else msgs.insertAdjacentHTML("afterbegin", html);
  } else {
    items.forEach(m => renderMessage(m));
  }

  updateReadMarks();
}

function renderAttachments(atts) {
  if (!atts || !atts.length) return "";
  return atts.map(a => {
    const url = API + a.url;
    if (a.mime && a.mime.startsWith("image/")) {
      return `<div style="margin-top:6px">
        <img src="${url}" style="max-width:280px;border-radius:12px;border:1px solid #222"/>
      </div>`;
    }
    if (a.mime && a.mime.startsWith("video/")) {
      return `<div style="margin-top:6px">
        <video src="${url}" controls style="max-width:360px;border-radius:12px;border:1px solid #222"></video>
      </div>`;
    }
    return `<div style="margin-top:6px"><a href="${url}" target="_blank">📎 ${escapeHtml(a.name || "file")}</a></div>`;
  }).join("");
}

function renderMessageHTML(m) {
  const isMe = me && m.sender_id === me.id;
  const who = isMe ? "me" : "other";
  const cls = isMe ? "me" : "";
  const time = (m.created_at || "").replace("T"," ").slice(0,19);
  const atts = renderAttachments(m.attachments);

  const readMark = isMe ? `<span data-msgid="${m.id}" class="readmark"><small> ✓</small></span>` : "";

  return `<div class="msg ${cls}" data-message-id="${m.id}">
    <b>${who}:</b> ${escapeHtml(m.text || "")}${readMark}<br>
    ${atts}
    <small>${time}</small>
  </div>`;
}

function renderMessage(m) {
  msgs.insertAdjacentHTML("beforeend", renderMessageHTML(m));
  msgs.scrollTop = msgs.scrollHeight;
  updateReadMarks();
}

function updateReadMarks() {
  if (!me) return;
  document.querySelectorAll(".readmark").forEach(el => {
    const id = parseInt(el.getAttribute("data-msgid") || "0", 10);
    el.innerHTML = `<small>${(otherLastRead >= id) ? " ✓✓" : " ✓"}</small>`;
  });
}

function isNearBottom() {
  const threshold = 60;
  return msgs.scrollHeight - (msgs.scrollTop + msgs.clientHeight) < threshold;
}

async function maybeMarkRead() {
  if (!currentChatId || !me) return;
  if (!isNearBottom()) return;

  const nodes = msgs.querySelectorAll("[data-message-id]");
  if (!nodes.length) return;

  const lastId = parseInt(nodes[nodes.length - 1].getAttribute("data-message-id"), 10);
  if (!Number.isFinite(lastId)) return;

  await fetch(API + `/chats/dm/${currentChatId}/read`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ last_read_message_id: lastId })
  });
}

async function send() {
  if (!currentChatId) return alert("Select a chat first");

  let fileIds = [];
  const f = file.files[0];

  if (f) {
    const fd = new FormData();
    fd.append("file", f);
    const r = await fetch(API + "/files/upload", { method:"POST", headers: { "Authorization":"Bearer " + token }, body: fd });
    if (!r.ok) {
      alert("Upload failed: " + await readError(r));
      return;
    }
    const j = await r.json();
    fileIds.push(j.file_id);
    file.value = "";
  }

  const textVal = text.value;
  const r2 = await fetch(API + `/chats/dm/${currentChatId}/send`, {
    method:"POST",
    headers: authHeaders(),
    body: JSON.stringify({ text: textVal, file_ids: fileIds })
  });
  if (!r2.ok) {
    alert("Send failed: " + await readError(r2));
    return;
  }
  const m = await r2.json();
  text.value = "";

  renderMessage(m);
  stopTyping();
  await maybeMarkRead();
}

function onTyping() {
  if (!currentChatId) return;

  if (!typingActive) {
    typingActive = true;
    wsSend({ type: "typing:start", chat_id: currentChatId });
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(stopTyping, 700);
}

function stopTyping() {
  if (!currentChatId) return;
  if (!typingActive) return;
  typingActive = false;
  wsSend({ type: "typing:stop", chat_id: currentChatId });
}

function escapeHtml(s) {
  return (s || "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

(async () => {
  if (token) {
    await loadMe();
    connectWS();
    await loadDialogs();
  } else {
    setMeUI();
  }
})();
