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

function isPin4(pin) {
  return /^\d{4}$/.test(String(pin || "").trim());
}

function clampStr(s, max) {
  if (typeof s !== "string") return "";
  const x = s.trim();
  return x.length > max ? x.slice(0, max) : x;
}

function browserTZ() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function isValidTimeZone(tz) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ===== 时间格式化（给“任意时区”输出 YYYY-MM-DD & HH:mm）=====
const _dtfCache = new Map();
function getDTF(tz) {
  if (_dtfCache.has(tz)) return _dtfCache.get(tz);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  _dtfCache.set(tz, dtf);
  return dtf;
}

function partsInTZ(tz, utcMs) {
  const dtf = getDTF(tz);
  const parts = dtf.formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`
  };
}

function formatDateTime(tz, utcMs) {
  const p = partsInTZ(tz, utcMs);
  return `${p.date} ${p.time}`;
}

// ===== 基础状态 =====
const query = qs();
const code = (query.code || "").trim();

if (!isValidCode(code)) {
  alert("房间码不合法。请从首页进入。");
  location.href = "/";
}

let store = parseStore(code) || {};
let memberId = String(store.memberId || "").trim();
let myName = String(store.name || "").trim();
let myPin = String(store.pin || "").trim();

let roomMeta = null;
let roomSlots = []; // slotId (epochMinutes) string[]
let members = [];
let conflictsMode = "count";
let conflictsData = {};
let isHost = false;

let myUnavailable = new Set(); // slotId set

// 显示时区：每个用户自己选
const displayTzKey = `mds:displayTz:${code}`;
let displayTimeZone = (localStorage.getItem(displayTzKey) || "").trim() || browserTZ();

// 这些是“当前显示时区下”渲染出来的网格轴
let displayDates = [];
let displayTimes = [];
let slotIdByDateTime = new Map(); // `${date}|${time}` -> slotId
let cellBySlotId = new Map();     // slotId -> cell DOM
let slotInfoById = new Map();     // slotId -> { utcMs, dispDate, dispTime, roomDate, roomTime }

// ===== 顶部连接状态 =====
const connState = $("connState");
socket.on("connect", () => { connState.textContent = "已连接"; });
socket.on("disconnect", () => { connState.textContent = "断开/重连中…"; });

// ===== 登录/改名 Modal =====
const authModal = $("authModal");
const pinField = $("pinField");
let modalMode = "login"; // login | rename

function showAuthModal(mode, title, hint) {
  modalMode = mode;
  $("authModalTitle").textContent = title || (mode === "rename" ? "改名" : "登录到房间");
  $("authModalHint").textContent = hint || "";

  $("nameInput").value = myName || "";
  $("pinInput").value = myPin || "";

  pinField.style.display = (mode === "login") ? "block" : "none";
  authModal.classList.add("show");
  $("nameInput").focus();
}

function hideAuthModal() {
  authModal.classList.remove("show");
}

$("authModalClose").addEventListener("click", () => hideAuthModal());

$("authSubmit").addEventListener("click", () => {
  const name = clampStr($("nameInput").value, 40);
  if (!name) return toast("名字不能为空");

  if (modalMode === "login") {
    const pin = $("pinInput").value.trim();
    if (!isPin4(pin)) return toast("密码必须是 4 位数字");

    myName = name;
    myPin = pin;

    store.name = myName;
    store.pin = myPin;
    saveStore(code, store);

    hideAuthModal();
    enterRoom();
    return;
  }

  // rename
  myName = name;
  store.name = myName;
  saveStore(code, store);

  hideAuthModal();
  doRename();
});

// ===== 进入房间 =====
function enterRoom() {
  if (!myName || !myPin) {
    showAuthModal(
      "login",
      "登录到房间",
      "输入你的姓名和 4 位密码。若该姓名不存在，会创建新成员；若已存在，会校验密码。"
    );
    return;
  }

  socket.emit("room:enter", { code, memberId, name: myName, pin: myPin }, (res) => {
    if (!res?.ok) {
      toast(res?.error || "进入失败");
      showAuthModal("login", "登录到房间", res?.error || "请重新输入姓名和密码。");
      return;
    }

    memberId = res.memberId;
    store.memberId = memberId;
    saveStore(code, store);

    toast("进入房间成功");
  });
}

enterRoom();

// ===== 顶部按钮 =====
$("copyCodeBtn").addEventListener("click", () => {
  navigator.clipboard?.writeText(code).then(() => toast("已复制房间码")).catch(() => toast("复制失败"));
});

$("logoutBtn").addEventListener("click", () => {
  if (!confirm("确定退出登录？（不会删除你已填写的时间表）")) return;
  localStorage.removeItem(`mds:${code}`);
  try { socket.disconnect(); } catch {}
  location.href = "/";
});

// ===== 改名 =====
$("renameBtn").addEventListener("click", () => {
  if (!memberId) return showAuthModal("login", "登录到房间", "请先登录。");
  showAuthModal("rename", "改我的名字", "改名后，下次登录请使用新名字（密码不变）。");
});

function doRename() {
  if (!memberId) return;
  socket.emit("member:rename", { code, memberId, newName: myName }, (res) => {
    if (!res?.ok) return toast(res?.error || "改名失败");
    toast("改名成功");
  });
}

// ===== 房主面板 =====
$("saveTitleBtn").addEventListener("click", () => {
  const title = clampStr($("editTitle").value, 80);
  if (!title) return toast("标题不能为空");
  socket.emit("room:update", { code, title }, (res) => {
    if (!res?.ok) return toast(res?.error || "保存失败");
    toast("标题已更新");
  });
});

$("dissolveBtn").addEventListener("click", () => {
  if (!confirm("确定解散房间？所有人会被踢出。")) return;
  socket.emit("room:dissolve", { code }, (res) => {
    if (!res?.ok) return toast(res?.error || "解散失败");
    toast("房间已解散");
    localStorage.removeItem(`mds:${code}`);
    location.href = "/";
  });
});

// ===== 被踢/解散/过期 =====
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

socket.on("room:expired", (msg) => {
  if (msg?.code !== code) return;
  alert("房间已过期并被系统自动销毁。");
  localStorage.removeItem(`mds:${code}`);
  location.href = "/";
});

// ===== 时区输入框 =====
const roomTimeZoneInput = $("roomTimeZone");
const displayTimeZoneInput = $("displayTimeZone");
displayTimeZoneInput.value = displayTimeZone;

displayTimeZoneInput.addEventListener("change", () => {
  const tz = displayTimeZoneInput.value.trim() || browserTZ();
  if (!isValidTimeZone(tz)) {
    toast("时区不合法。请用如 Asia/Shanghai、Europe/London 这类名称。");
    displayTimeZoneInput.value = displayTimeZone;
    return;
  }
  displayTimeZone = tz;
  localStorage.setItem(displayTzKey, displayTimeZone);
  toast(`已切换显示时区：${displayTimeZone}`);
  rebuildGrid();      // ✅ 重绘
  paintAllCells();
  renderOkSlots();
});

// ===== 网格 DOM & 交互 =====
const gridEl = $("timeGrid");
const cellInfoEl = $("cellInfo");

// 拖拽涂格子
let dragging = false;
let dragAction = null; // add/remove
let lastAppliedSlot = null;

function getEffectiveConflictCount(slotId) {
  const v = conflictsData[slotId];
  let c = 0;

  if (conflictsMode === "detailed") c = Array.isArray(v) ? v.length : 0;
  else c = typeof v === "number" ? v : 0;

  // 把“本地未同步”也算进去，避免你刚涂就点格子却显示“全员可行”
  if (myUnavailable.has(slotId)) c = Math.max(c, 1);

  return c;
}

function getEffectiveConflictNames(slotId) {
  if (!(isHost && conflictsMode === "detailed")) return [];
  const v = conflictsData[slotId];
  const list = Array.isArray(v) ? v.slice() : [];
  const set = new Set(list);

  // 把本地未同步的自己也补进去（如果 conflicts 里还没包含）
  if (myUnavailable.has(slotId) && memberId && !set.has(memberId)) set.add(memberId);

  return members.filter(m => set.has(m.id)).map(m => m.name);
}

function buildCellInfo(slotId) {
  const info = slotInfoById.get(slotId);
  if (!info) return `该格子不可用`;

  const c = getEffectiveConflictCount(slotId);
  const meMark = myUnavailable.has(slotId) ? "（你标记为不可行）" : "";

  const disp = `${info.dispDate} ${info.dispTime}`;
  const roomt = `${info.roomDate} ${info.roomTime}`;

  let header = `<b>显示时区(${displayTimeZone})</b>：<span class="mono">${disp}</span><br/>` +
               `<b>房间时区(${roomMeta?.timeZone || "?"})</b>：<span class="mono">${roomt}</span><br/>`;

  if (isHost && conflictsMode === "detailed") {
    if (c === 0) return `${header}✅ 全员可行 ${meMark}`;
    const names = getEffectiveConflictNames(slotId);
    return `${header}❌ 不可行成员（${c}）<br/>${names.map(n => `• ${n}`).join("<br/>")}${meMark ? `<br/>${meMark}` : ""}`;
  }

  if (c === 0) return `${header}✅ 全员可行 ${meMark}`;
  return `${header}冲突人数：${c} ${meMark}`;
}

function paintOneCell(slotId) {
  const cell = cellBySlotId.get(slotId);
  if (!cell) return;

  const c = getEffectiveConflictCount(slotId);

  // tooltip
  const info = slotInfoById.get(slotId);
  if (info) {
    const tipLine = `${info.dispDate} ${info.dispTime} (${displayTimeZone})`;
    if (isHost && conflictsMode === "detailed") {
      const names = getEffectiveConflictNames(slotId);
      cell.title = c === 0 ? `${tipLine}\n全员可行` : `${tipLine}\n不可行：${names.join(", ")}`;
    } else {
      cell.title = c === 0 ? `${tipLine}\n全员可行` : `${tipLine}\n冲突人数：${c}`;
    }
  }

  // 我的不可行优先
  if (myUnavailable.has(slotId)) {
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
  for (const slotId of roomSlots) paintOneCell(slotId);
}

function applyAction(slotId) {
  if (!slotId || slotId === lastAppliedSlot) return;
  lastAppliedSlot = slotId;

  if (dragAction === "add") myUnavailable.add(slotId);
  else myUnavailable.delete(slotId);

  paintOneCell(slotId);
  scheduleSave();
}

function findSlotCellFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const cell = el.closest?.(".slot");
  if (!cell) return null;
  const slotId = cell.dataset.slot;
  if (!slotId) return null;
  return cell;
}

gridEl.addEventListener("pointerdown", (e) => {
  const cell = e.target.closest?.(".slot");
  if (!cell) return;
  const slotId = cell.dataset.slot;
  if (!slotId) return;

  dragging = true;
  lastAppliedSlot = null;
  dragAction = myUnavailable.has(slotId) ? "remove" : "add";

  cell.setPointerCapture?.(e.pointerId);
  applyAction(slotId);
});

gridEl.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const cell = findSlotCellFromPoint(e.clientX, e.clientY);
  if (!cell) return;
  applyAction(cell.dataset.slot);
});

gridEl.addEventListener("pointerup", () => {
  dragging = false;
  dragAction = null;
  lastAppliedSlot = null;
});
gridEl.addEventListener("pointercancel", () => {
  dragging = false;
  dragAction = null;
  lastAppliedSlot = null;
});

// 点击格子看详情
gridEl.addEventListener("click", (e) => {
  const cell = e.target.closest?.(".slot");
  if (!cell) return;
  const slotId = cell.dataset.slot;
  if (!slotId) return;
  cellInfoEl.innerHTML = buildCellInfo(slotId);
});

// 清空
$("clearMine").addEventListener("click", () => {
  if (!confirm("清空你所有不可行时间？")) return;
  myUnavailable.clear();
  paintAllCells();
  scheduleSave(true);
});

// ===== 保存（防抖）=====
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

// ===== 成员确认提交 =====
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
      const hostName = res.hostName || "房主";
      setSaveState("已提交给房主");
      toast(`${hostName} 已经收到你的时间安排！`);
    });
  });
});

// ===== 渲染：成员列表 =====
function renderMembers() {
  const listEl = $("memberList");
  listEl.innerHTML = "";

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
      <div class="memberRole">${m.isOwner ? "房主" : "成员"}</div>
    `;

    left.appendChild(dot);
    left.appendChild(nameWrap);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "8px";
    right.style.alignItems = "center";

    const badge = document.createElement("span");
    const confirmed = Boolean(m.confirmedAt);
    badge.className = `memberBadge ${confirmed ? "ok" : ""}`;
    badge.textContent = confirmed ? "已确认" : "未确认";
    right.appendChild(badge);

    if (isHost && !m.isOwner) {
      const kickBtn = document.createElement("button");
      kickBtn.className = "btn btnDanger btnTiny";
      kickBtn.textContent = "踢出";
      kickBtn.addEventListener("click", () => {
        if (!confirm(`确定踢出「${m.name}」？`)) return;
        socket.emit("room:kick", { code, targetId: m.id }, (res) => {
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

  confirmBtn.style.display = isHost ? "none" : "inline-block";
}

// ===== 渲染：房间头部 =====
function getOwnerName() {
  const owner = members.find(m => m.isOwner);
  return owner?.name || roomMeta?.creatorName || "房主";
}

function renderRoomHeader() {
  $("roomTitle").textContent = roomMeta?.title || "房间";
  const expiresOn = roomMeta?.expiresOn || roomMeta?.endDate;

  $("roomMeta").innerHTML = `
    房间码：<b class="mono">${code}</b><br/>
    日期范围（房间时区）：${roomMeta.startDate} ~ ${roomMeta.endDate}<br/>
    每天（房间时区）：${roomMeta.dayStart}–${roomMeta.dayEnd} · 粒度：${roomMeta.slotMinutes}min<br/>
    房间时区：<b class="mono">${roomMeta.timeZone}</b><br/>
    当前显示时区：<b class="mono">${displayTimeZone}</b><br/>
    过期日期：<b>${expiresOn}</b>（到当天结束后自动销毁）
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

// ===== 依据显示时区重建网格 =====
function rebuildGrid() {
  gridEl.innerHTML = "";
  slotIdByDateTime = new Map();
  cellBySlotId = new Map();
  slotInfoById = new Map();

  if (!roomMeta || !Array.isArray(roomSlots) || roomSlots.length === 0) {
    cellInfoEl.textContent = "房间尚未准备好。";
    return;
  }

  // room timezone
  const roomTZ = roomMeta.timeZone || "UTC";
  roomTimeZoneInput.value = roomTZ;

  // display timezone fallback
  if (!isValidTimeZone(displayTimeZone)) {
    displayTimeZone = browserTZ();
    localStorage.setItem(displayTzKey, displayTimeZone);
    displayTimeZoneInput.value = displayTimeZone;
  }

  // 计算显示轴（dates/times）与映射
  const dateSet = new Set();
  const timeSet = new Set();

  for (const slotId of roomSlots) {
    const n = Number(slotId);
    if (!Number.isFinite(n)) continue;
    const utcMs = n * 60000;

    const disp = partsInTZ(displayTimeZone, utcMs);
    const rm = partsInTZ(roomTZ, utcMs);

    dateSet.add(disp.date);
    timeSet.add(disp.time);

    const key = `${disp.date}|${disp.time}`;
    if (!slotIdByDateTime.has(key)) slotIdByDateTime.set(key, String(slotId));

    slotInfoById.set(String(slotId), {
      utcMs,
      dispDate: disp.date,
      dispTime: disp.time,
      roomDate: rm.date,
      roomTime: rm.time
    });
  }

  displayDates = [...dateSet].sort();
  displayTimes = [...timeSet].sort();

  gridEl.style.setProperty("--days", String(displayDates.length));

  // header row
  const corner = document.createElement("div");
  corner.className = "cell hdr time corner";
  corner.textContent = "时间";
  gridEl.appendChild(corner);

  for (const d of displayDates) {
    const c = document.createElement("div");
    c.className = "cell hdr";
    c.textContent = d;
    gridEl.appendChild(c);
  }

  // body
  for (const t of displayTimes) {
    const tCell = document.createElement("div");
    tCell.className = "cell time";
    tCell.textContent = t;
    gridEl.appendChild(tCell);

    for (const d of displayDates) {
      const dtKey = `${d}|${t}`;
      const slotId = slotIdByDateTime.get(dtKey);

      if (!slotId) {
        // 没有对应槽位：填个空格，保证网格对齐
        const empty = document.createElement("div");
        empty.className = "cell";
        empty.textContent = "";
        gridEl.appendChild(empty);
        continue;
      }

      const cell = document.createElement("div");
      cell.className = "cell slot";
      cell.dataset.slot = slotId;

      cellBySlotId.set(slotId, cell);
      gridEl.appendChild(cell);
    }
  }
}

// ===== 可行时间段（按显示时区输出） =====
function computeAllOkIntervals() {
  if (!roomMeta || !roomSlots.length) return [];

  const step = Number(roomMeta.slotMinutes || 30);
  const nums = roomSlots.map(Number).filter(Number.isFinite).sort((a, b) => a - b);

  const intervals = [];
  let runStart = null;
  let runEnd = null;

  for (let i = 0; i < nums.length; i++) {
    const slotId = String(nums[i]);
    const ok = getEffectiveConflictCount(slotId) === 0;

    if (!ok) {
      if (runStart != null) {
        intervals.push({ startMin: runStart, endMin: runEnd });
        runStart = null;
        runEnd = null;
      }
      continue;
    }

    if (runStart == null) {
      runStart = nums[i];
      runEnd = nums[i] + step;
      continue;
    }

    // 连续：下一个槽 = 上一个槽 + step
    if (nums[i] === runEnd) {
      runEnd = nums[i] + step;
    } else {
      intervals.push({ startMin: runStart, endMin: runEnd });
      runStart = nums[i];
      runEnd = nums[i] + step;
    }
  }

  if (runStart != null) intervals.push({ startMin: runStart, endMin: runEnd });

  // 排序
  intervals.sort((a, b) => a.startMin - b.startMin);
  return intervals;
}

function renderOkSlots() {
  const listEl = $("okSlots");
  const hintEl = $("okSlotsHint");
  listEl.innerHTML = "";

  if (!roomMeta) return;

  hintEl.textContent = members.length
    ? `当前成员数：${members.length} · 显示时区：${displayTimeZone}`
    : `等待成员加入… · 显示时区：${displayTimeZone}`;

  const allOk = computeAllOkIntervals();
  if (allOk.length === 0) {
    const div = document.createElement("div");
    div.className = "listItem";
    div.textContent = "目前没有全员都行的时间段。";
    listEl.appendChild(div);
    return;
  }

  for (const it of allOk.slice(0, 30)) {
    const startMs = it.startMin * 60000;
    const endMs = it.endMin * 60000;

    const startDT = formatDateTime(displayTimeZone, startMs);
    const endDT = formatDateTime(displayTimeZone, endMs);

    const div = document.createElement("div");
    div.className = "listItem";
    div.innerHTML = `<b>${startDT}</b>  →  <b>${endDT}</b>`;
    listEl.appendChild(div);
  }
}

// ===== 服务端状态推送 =====
let lastSlotsSignature = "";

function slotsSignature(slots, step) {
  if (!Array.isArray(slots) || slots.length === 0) return "0|0|0|" + step;
  const first = String(slots[0]);
  const last = String(slots[slots.length - 1]);
  return `${slots.length}|${first}|${last}|${step}`;
}

socket.on("room:state", (state) => {
  if (!state?.ok) return;

  roomMeta = state.room;
  members = state.members || [];
  isHost = Boolean(state.isHost);

  // 房主面板显示
  $("hostPanel").style.display = isHost ? "block" : "none";
  if (isHost) $("editTitle").value = roomMeta.title || "";

  // you
  if (state.you?.id) {
    memberId = state.you.id;
    store.memberId = memberId;
    if (state.you.name && state.you.name !== myName) {
      myName = state.you.name;
      store.name = myName;
    }
    saveStore(code, store);
  }

  if (state.you?.unavailable) {
    myUnavailable = new Set(state.you.unavailable.map(String));
  }

  conflictsMode = state.conflicts?.mode || "count";
  conflictsData = state.conflicts?.data || {};

  // slots
  roomSlots = Array.isArray(state.slots) ? state.slots.map(String) : [];
  const sig = slotsSignature(roomSlots, roomMeta?.slotMinutes || 30);

  // 时区输入框同步
  roomTimeZoneInput.value = roomMeta?.timeZone || "UTC";
  if (!displayTimeZoneInput.value.trim()) displayTimeZoneInput.value = displayTimeZone;

  // 若 slots 或房间关键元信息变化，重建网格
  if (sig !== lastSlotsSignature) {
    lastSlotsSignature = sig;
    rebuildGrid();
  }

  renderRoomHeader();
  renderMembers();
  paintAllCells();
  renderOkSlots();
});

