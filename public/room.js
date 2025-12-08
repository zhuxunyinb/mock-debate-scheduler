const socket = io();
const $ = (id) => document.getElementById(id);

const toastEl = $("toast");
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2200);
}

function qs() {
  const p = new URLSearchParams(location.search);
  return Object.fromEntries(p.entries());
}

function parseStore(code) {
  try {
    return JSON.parse(localStorage.getItem(`mds:${code}`) || "null");
  } catch {
    return null;
  }
}

function saveStore(code, obj) {
  localStorage.setItem(`mds:${code}`, JSON.stringify(obj));
}

function isValidCode(code) {
  return /^\d{6}$/.test(code);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateToStr(d) {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}

function cmpDate(a, b) {
  return new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime();
}

function timeToMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function clampStr(s, max) {
  if (typeof s !== "string") return "";
  const x = s.trim();
  return x.length > max ? x.slice(0, max) : x;
}

const query = qs();
const code = (query.code || "").trim();
let hostTokenFromUrl = (query.host || "").trim();

if (!isValidCode(code)) {
  alert("房间码不合法。请从首页创建/加入进入。");
  location.href = "/";
}

let store = parseStore(code) || {};
if (hostTokenFromUrl) store.hostToken = hostTokenFromUrl; // 允许房主链接覆盖
saveStore(code, store);

let memberId = store.memberId || "";
let myName = store.name || "";
let hostToken = store.hostToken || "";

let roomMeta = null;
let members = [];
let conflictsMode = "count"; // "count" or "detailed"
let conflictsData = {};      // key -> number OR array(memberId)
let isHost = false;

let myUnavailable = new Set();

const connState = $("connState");
socket.on("connect", () => { connState.textContent = "已连接"; });
socket.on("disconnect", () => { connState.textContent = "断开/重连中…"; });

const nameModal = $("nameModal");
function showNameModal(title, hint) {
  $("nameModalTitle").textContent = title;
  $("nameModalHint").textContent = hint || "";
  $("nameInput").value = myName || "";
  nameModal.classList.add("show");
  $("nameInput").focus();
}
function hideNameModal() { nameModal.classList.remove("show"); }

$("nameModalClose").addEventListener("click", () => hideNameModal());
$("nameSubmit").addEventListener("click", () => {
  const v = clampStr($("nameInput").value, 40);
  if (!v) return toast("名字不能为空");
  myName = v;
  store.name = myName;
  saveStore(code, store);
  hideNameModal();
  enterRoom(); // 重试进入
});

async function enterRoom() {
  if (!myName) {
    showNameModal("请输入你的姓名", "用于房间内显示。你之后也可以改名。");
    return;
  }

  socket.emit("room:enter", { code, memberId, name: myName, hostToken }, (res) => {
    if (!res?.ok) {
      toast(res?.error || "进入失败");
      if ((res?.error || "").includes("需要姓名")) showNameModal("请输入你的姓名", "");
      return;
    }
    memberId = res.memberId;
    store.memberId = memberId;
    store.hostToken = hostToken;
    saveStore(code, store);

    toast("进入房间成功");
  });
}

enterRoom();

// ========== UI: 顶部复制 ==========
$("copyCodeBtn").addEventListener("click", () => {
  navigator.clipboard?.writeText(code).then(() => toast("已复制房间码")).catch(() => toast("复制失败"));
});
$("copyInviteBtn").addEventListener("click", () => {
  const link = `${location.origin}/room.html?code=${encodeURIComponent(code)}`;
  navigator.clipboard?.writeText(link).then(() => toast("已复制邀请链接")).catch(() => toast("复制失败"));
});
$("copyHostBtn").addEventListener("click", () => {
  if (!hostToken) return toast("你当前不是房主（没有房主密钥）");
  const link = `${location.origin}/room.html?code=${encodeURIComponent(code)}&host=${encodeURIComponent(hostToken)}`;
  navigator.clipboard?.writeText(link).then(() => toast("已复制房主链接")).catch(() => toast("复制失败"));
});

$("leaveBtn").addEventListener("click", () => {
  if (!confirm("确定退出房间吗？（会把你从成员列表移除）")) return;
  socket.emit("member:leave", { code, memberId }, (res) => {
    if (!res?.ok) toast(res?.error || "退出失败");
    localStorage.removeItem(`mds:${code}`);
    location.href = "/";
  });
});

// ========== 改名 ==========
$("renameBtn").addEventListener("click", () => {
  showNameModal("修改你的显示名", "改名会实时同步给房主和其他成员。");
});

// ========== 房主面板 ==========
$("saveTitleBtn").addEventListener("click", () => {
  if (!hostToken) return toast("无房主权限");
  const title = clampStr($("editTitle").value, 80);
  if (!title) return toast("标题不能为空");
  socket.emit("room:update", { code, hostToken, title }, (res) => {
    if (!res?.ok) return toast(res?.error || "保存失败");
    toast("标题已更新");
  });
});

$("dissolveBtn").addEventListener("click", () => {
  if (!hostToken) return toast("无房主权限");
  if (!confirm("确定解散房间？所有人会被踢出。")) return;
  socket.emit("room:dissolve", { code, hostToken }, (res) => {
    if (!res?.ok) return toast(res?.error || "解散失败");
    toast("房间已解散");
    localStorage.removeItem(`mds:${code}`);
    location.href = "/";
  });
});

// ========== 监听踢出/解散 ==========
socket.on("room:kicked", (msg) => {
  if (msg?.code !== code) return;
  alert("你已被房主移出该房间。");
  localStorage.removeItem(`mds:${code}`);
  location.href = "/";
});

socket.on("room:dissolved", (msg) => {
  if (msg?.code !== code) return;
  alert("房间已被房主解散。");
  localStorage.removeItem(`mds:${code}`);
  location.href = "/";
});

// ========== 网格生成 ==========
const gridEl = $("timeGrid");
const cellInfoEl = $("cellInfo");
let daysArr = [];
let timesMinArr = [];
let cellsByKey = new Map();

function buildGrid(meta) {
  daysArr = [];
  timesMinArr = [];
  cellsByKey.clear();
  gridEl.innerHTML = "";

  const { startDate, endDate, dayStart, dayEnd, slotMinutes } = meta;

  // days (inclusive)
  let cur = startDate;
  while (cmpDate(cur, endDate) <= 0) {
    daysArr.push(cur);
    cur = addDays(cur, 1);
  }

  // times
  const ds = timeToMin(dayStart);
  const de = timeToMin(dayEnd);
  for (let m = ds; m < de; m += slotMinutes) timesMinArr.push(m);

  gridEl.style.setProperty("--days", String(daysArr.length));

  // header row
  const corner = document.createElement("div");
  corner.className = "cell hdr time corner";
  corner.textContent = "时间";
  gridEl.appendChild(corner);

  for (const d of daysArr) {
    const c = document.createElement("div");
    c.className = "cell hdr";
    c.textContent = d;
    gridEl.appendChild(c);
  }

  // body
  for (const tMin of timesMinArr) {
    const tCell = document.createElement("div");
    tCell.className = "cell time";
    tCell.textContent = minToTime(tMin);
    gridEl.appendChild(tCell);

    for (const d of daysArr) {
      const key = `${d}|${minToTime(tMin)}`;
      const cell = document.createElement("div");
      cell.className = "cell slot";
      cell.dataset.key = key;
      cell.title = key;

      cellsByKey.set(key, cell);
      gridEl.appendChild(cell);
    }
  }
}

// ========== 冲突计算（✅ 修复“你不可行却显示全员可行”的 bug）==========
function getBaseConflictList(key) {
  const v = conflictsData[key];
  if (conflictsMode === "detailed" && Array.isArray(v)) return v.slice();
  return [];
}

function getEffectiveConflictCount(key) {
  const v = conflictsData[key];
  let c = 0;
  if (conflictsMode === "detailed") c = Array.isArray(v) ? v.length : 0;
  else c = typeof v === "number" ? v : 0;

  // 把“本地尚未同步”的 myUnavailable 也算进去，避免误判为全员可行
  if (myUnavailable.has(key)) {
    if (conflictsMode === "detailed") {
      if (memberId && Array.isArray(v)) {
        if (!v.includes(memberId)) c += 1;
      } else {
        c = Math.max(c, 1);
      }
    } else {
      c = Math.max(c, 1);
    }
  }
  return c;
}

function getEffectiveConflictNames(key) {
  // 只在房主(detailed)时可精准列出名字；否则返回空
  if (!(isHost && conflictsMode === "detailed")) return [];

  const list = getBaseConflictList(key);
  const idSet = new Set(list);

  // 本地未同步也补上“我”
  if (myUnavailable.has(key) && memberId && !idSet.has(memberId)) {
    idSet.add(memberId);
  }

  return members
    .filter(m => idSet.has(m.id))
    .map(m => m.name);
}

// ========== 网格交互：拖拽涂不可行 ==========
let dragging = false;
let dragAction = null; // "add" or "remove"
let lastAppliedKey = null;

function applyAction(key) {
  if (!key || key === lastAppliedKey) return;
  lastAppliedKey = key;

  if (dragAction === "add") myUnavailable.add(key);
  else myUnavailable.delete(key);

  paintOneCell(key);
  scheduleSave();
}

function findSlotCellFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const cell = el.closest?.(".slot");
  return cell || null;
}

gridEl.addEventListener("pointerdown", (e) => {
  const cell = e.target.closest?.(".slot");
  if (!cell) return;

  dragging = true;
  lastAppliedKey = null;
  const key = cell.dataset.key;
  dragAction = myUnavailable.has(key) ? "remove" : "add";

  cell.setPointerCapture?.(e.pointerId);
  applyAction(key);
});

gridEl.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const cell = findSlotCellFromPoint(e.clientX, e.clientY);
  if (!cell) return;
  applyAction(cell.dataset.key);
});

gridEl.addEventListener("pointerup", () => {
  dragging = false;
  dragAction = null;
  lastAppliedKey = null;
});
gridEl.addEventListener("pointercancel", () => {
  dragging = false;
  dragAction = null;
  lastAppliedKey = null;
});

// 点击格子看详情
gridEl.addEventListener("click", (e) => {
  const cell = e.target.closest?.(".slot");
  if (!cell) return;
  const key = cell.dataset.key;
  cellInfoEl.innerHTML = buildCellInfo(key);
});

// 清空
$("clearMine").addEventListener("click", () => {
  if (!confirm("清空你所有不可行时间？")) return;
  myUnavailable.clear();
  paintAllCells();
  scheduleSave(true);
});

// ========== 保存（防抖）==========
let saveTimer = null;
let lastSentAt = 0;

function setSaveState(txt) {
  $("saveState").textContent = txt || "";
}

function pushUnavailableNow(cb) {
  if (!memberId) return cb?.(false);

  setSaveState("同步中…");
  const payload = { code, memberId, unavailable: [...myUnavailable] };
  socket.emit("member:set_unavailable", payload, (res) => {
    if (!res?.ok) {
      setSaveState("同步失败");
      toast(res?.error || "同步失败");
      return cb?.(false);
    }
    lastSentAt = Date.now();
    setSaveState("已同步");
    setTimeout(() => {
      if (Date.now() - lastSentAt > 900) setSaveState("");
    }, 1200);
    cb?.(true);
  });
}

function scheduleSave(force = false) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => pushUnavailableNow(), force ? 0 : 220);
}

// ========== 成员确认提交 ==========
const confirmBtn = $("confirmBtn");
confirmBtn.addEventListener("click", () => {
  confirmBtn.disabled = true;
  pushUnavailableNow((ok) => {
    if (!ok) {
      confirmBtn.disabled = false;
      return;
    }
    socket.emit("member:confirm", { code, memberId }, (res) => {
      confirmBtn.disabled = false;
      if (!res?.ok) return toast(res?.error || "确认失败");
      const hostName = res.hostName || getOwnerName() || "房主";
      setSaveState("已提交给房主");
      toast(`${hostName} 已经收到你的时间安排！`);
    });
  });
});

// ========== 渲染逻辑 ==========
function getOwnerName() {
  const owner = members.find(m => m.isOwner);
  return owner?.name || roomMeta?.creatorName || "房主";
}

function buildCellInfo(key) {
  const c = getEffectiveConflictCount(key);
  const meMark = myUnavailable.has(key) ? "（你标记为不可行）" : "";

  if (isHost && conflictsMode === "detailed") {
    if (c === 0) return `<b class="mono">${key}</b>：✅ 全员可行 ${meMark}`;
    const names = getEffectiveConflictNames(key);
    return `<b class="mono">${key}</b>：❌ 不可行成员（${c}）<br/>${names.map(n => `• ${n}`).join("<br/>")}${meMark ? `<br/>${meMark}` : ""}`;
  }

  if (c === 0) return `<b class="mono">${key}</b>：✅ 全员可行 ${meMark}`;
  return `<b class="mono">${key}</b>：冲突人数：${c} ${meMark}`;
}

function paintOneCell(key) {
  const cell = cellsByKey.get(key);
  if (!cell) return;

  const c = getEffectiveConflictCount(key);

  // tooltip
  if (isHost && conflictsMode === "detailed") {
    const names = getEffectiveConflictNames(key);
    cell.title = c === 0 ? `${key}\n全员可行` : `${key}\n不可行：${names.join(", ")}`;
  } else {
    cell.title = c === 0 ? `${key}\n全员可行` : `${key}\n冲突人数：${c}`;
  }

  // 我的不可行优先显示（红）
  if (myUnavailable.has(key)) {
    cell.classList.remove("ok","r1","r2","r3","r4");
    cell.classList.add("me");
    return;
  }
  cell.classList.remove("me");

  if (c === 0) {
    cell.classList.add("ok");
    cell.classList.remove("r1","r2","r3","r4");
  } else {
    cell.classList.remove("ok");
    const ratio = c / Math.max(1, (members?.length || 1));
    cell.classList.remove("r1","r2","r3","r4");
    if (ratio < 0.25) cell.classList.add("r1");
    else if (ratio < 0.5) cell.classList.add("r2");
    else if (ratio < 0.75) cell.classList.add("r3");
    else cell.classList.add("r4");
  }
}

function paintAllCells() {
  for (const key of cellsByKey.keys()) paintOneCell(key);
}

function renderMembers() {
  const listEl = $("memberList");
  listEl.innerHTML = "";

  const ownerName = getOwnerName();

  for (const m of members) {
    const item = document.createElement("div");
    item.className = "memberItem";

    const left = document.createElement("div");
    left.className = "memberLeft";

    const dot = document.createElement("div");
    dot.className = `dot ${m.online ? "on" : ""}`;

    const nameWrap = document.createElement("div");
    nameWrap.style.minWidth = "0";

    const myTag = m.id === memberId ? "（你）" : "";
    nameWrap.innerHTML = `
      <div class="memberName">${m.name}${myTag}</div>
      <div class="memberRole">${m.isOwner ? "房间创建者" : "成员"}</div>
    `;

    left.appendChild(dot);
    left.appendChild(nameWrap);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "8px";
    right.style.alignItems = "center";

    // ✅ 确认状态
    const badge = document.createElement("span");
    const confirmed = Boolean(m.confirmedAt);
    badge.className = `memberBadge ${confirmed ? "ok" : ""}`;
    badge.textContent = confirmed ? "已确认" : "未确认";
    right.appendChild(badge);

    // 房主可踢人
    if (isHost && hostToken && !m.isOwner) {
      const kickBtn = document.createElement("button");
      kickBtn.className = "btn btnDanger btnTiny";
      kickBtn.textContent = "踢出";
      kickBtn.addEventListener("click", () => {
        if (!confirm(`确定踢出「${m.name}」？`)) return;
        socket.emit("room:kick", { code, hostToken, targetId: m.id }, (res) => {
          if (!res?.ok) return toast(res?.error || "踢出失败");
          toast("已踢出成员");
        });
      });
      right.appendChild(kickBtn);
    }

    item.appendChild(left);
    item.appendChild(right);
    listEl.appendChild(item);
  }

  // 小细节：成员确认按钮只给非房主
  if (!isHost) {
    confirmBtn.style.display = "inline-block";
  } else {
    confirmBtn.style.display = "none";
  }
}

function computeAllOkIntervals() {
  // 返回数组: [{date, start, end}]
  const intervals = [];
  const slotMinutes = roomMeta.slotMinutes;
  const de = timeToMin(roomMeta.dayEnd);

  for (const d of daysArr) {
    let runStart = null;

    for (const tMin of timesMinArr) {
      const key = `${d}|${minToTime(tMin)}`;
      const ok = getEffectiveConflictCount(key) === 0;

      if (ok) {
        if (runStart == null) runStart = tMin;
      } else {
        if (runStart != null) {
          const endMin = tMin;
          intervals.push({ date: d, start: minToTime(runStart), end: minToTime(endMin) });
          runStart = null;
        }
      }
    }

    if (runStart != null) {
      intervals.push({ date: d, start: minToTime(runStart), end: minToTime(de) });
    }
  }

  // ✅ 按时间顺序排列（日期→开始时间）
  intervals.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  return intervals;
}

function renderOkSlots() {
  const listEl = $("okSlots");
  const hintEl = $("okSlotsHint");
  listEl.innerHTML = "";

  if (!roomMeta) return;

  hintEl.textContent = members.length
    ? `当前成员数：${members.length}（仅当某格子冲突人数为 0 才算全员可行）`
    : "等待成员加入…";

  const allOk = computeAllOkIntervals();

  if (allOk.length === 0) {
    const div = document.createElement("div");
    div.className = "listItem";
    div.textContent = "目前没有全员都行的时间段。";
    listEl.appendChild(div);
    return;
  }

  // ✅ 展示前 20 条（按时间顺序）
  const top = allOk.slice(0, 20);
  for (const it of top) {
    const div = document.createElement("div");
    div.className = "listItem";
    div.innerHTML = `<b>${it.date}</b>  ${it.start}–${it.end}`;
    listEl.appendChild(div);
  }
}

function renderRoomHeader() {
  $("roomTitle").textContent = roomMeta?.title || "房间";
  $("roomMeta").innerHTML = `
    房间码：<b class="mono">${code}</b><br/>
    日期范围：${roomMeta.startDate} ~ ${roomMeta.endDate}<br/>
    每天：${roomMeta.dayStart}–${roomMeta.dayEnd} · 粒度：${roomMeta.slotMinutes}min
  `;

  const kv = $("roomKV");
  kv.innerHTML = "";
  const mk = (txt) => {
    const s = document.createElement("span");
    s.textContent = txt;
    kv.appendChild(s);
  };
  mk(`创建者：${getOwnerName()}`);
  mk(`成员数：${members.length}`);
  mk(isHost ? "你是房主（管理）" : "你是成员");
}

// ========== 服务端状态推送 ==========
socket.on("room:state", (state) => {
  if (!state?.ok) return;

  roomMeta = state.room;
  members = state.members || [];
  isHost = Boolean(state.isHost);

  // 房主面板显示
  $("hostPanel").style.display = (isHost && hostToken) ? "block" : "none";
  if (isHost && hostToken) {
    $("editTitle").value = roomMeta.title || "";
  }

  // 你自己的不可行：以服务端为准（重连/多端）
  if (state.you?.unavailable) {
    myUnavailable = new Set(state.you.unavailable);

    if (state.you.name && state.you.name !== myName) {
      myName = state.you.name;
      store.name = myName;
      saveStore(code, store);
    }
  }

  // 冲突数据
  conflictsMode = state.conflicts?.mode || "count";
  conflictsData = state.conflicts?.data || {};

  // 重建网格
  const needBuild =
    !cellsByKey.size ||
    gridEl.dataset.sig !== `${roomMeta.startDate}|${roomMeta.endDate}|${roomMeta.dayStart}|${roomMeta.dayEnd}|${roomMeta.slotMinutes}`;

  if (needBuild) {
    buildGrid(roomMeta);
    gridEl.dataset.sig = `${roomMeta.startDate}|${roomMeta.endDate}|${roomMeta.dayStart}|${roomMeta.dayEnd}|${roomMeta.slotMinutes}`;
  }

  renderRoomHeader();
  renderMembers();
  paintAllCells();
  renderOkSlots();
});

// 如果 URL 带 host，自动记住（管理权限）
if (hostTokenFromUrl) {
  hostToken = hostTokenFromUrl;
  store.hostToken = hostToken;
  saveStore(code, store);
}
