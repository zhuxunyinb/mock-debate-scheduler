const path = require("path");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ===================== 可选：Supabase 数据库（推荐：解决 Render 重启丢房间） =====================
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SUPABASE_TABLE = (process.env.SUPABASE_TABLE || "mds_rooms").trim();
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

// ===================== 本地 JSON 落盘（本地开发用；Render 免费档可能不可靠） =====================
const DATA_FILE = path.join(__dirname, "data.json");
const SAVE_DEBOUNCE_MS = 250;

// ===================== 内存数据库 =====================
/**
 * room: {
 *   code,
 *   title, startDate, endDate, dayStart, dayEnd, slotMinutes,
 *   timeZone,
 *   creatorName, createdAt, updatedAt,
 *   expiresMs,
 *   ownerMemberId,
 *   slots: string[] // slotId = epochMinutes (UTC)
 *   members: Map(memberId => member),
 *   socketsByMemberId: Map(memberId => Set(socketId))
 * }
 *
 * member: {
 *   id, name, joinedAt, lastSeenAt,
 *   unavailable:Set(slotId),
 *   confirmedAt: string|null,
 *   pinSalt, pinHash
 * }
 */
const rooms = new Map();

// ===================== 通用工具 =====================
function nowISO() {
  return new Date().toISOString();
}

function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function gen6Code() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}

function generateUniqueCode() {
  for (let i = 0; i < 30; i++) {
    const code = gen6Code();
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

function clampString(s, maxLen) {
  if (typeof s !== "string") return "";
  const x = s.trim();
  return x.length > maxLen ? x.slice(0, maxLen) : x;
}

function isValidDateStr(s) {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(`${s}T00:00:00Z`).getTime();
  return Number.isFinite(t);
}

function dateStrToUTCms(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getTime();
}

function cmpDateStr(a, b) {
  return dateStrToUTCms(a) - dateStrToUTCms(b);
}

function addDaysDateStr(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseTimeToMinutes(t) {
  if (typeof t !== "string" || !/^\d{2}:\d{2}$/.test(t)) return null;
  const [hh, mm] = t.split(":").map(Number);
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function normalizePin(pin) {
  const p = String(pin ?? "").trim();
  return /^\d{4}$/.test(p) ? p : null;
}

function hashPin(pin, salt) {
  return crypto.createHash("sha256").update(`${salt}:${pin}`).digest("hex");
}

function verifyPin(member, pin) {
  const p = normalizePin(pin);
  if (!p) return false;
  return member.pinHash === hashPin(p, member.pinSalt);
}

function isValidTimeZone(tz) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ===================== 时区：把 “某时区的本地年月日时分” 转成 UTC ms =====================
// 参考思路：用 Intl 在目标时区 formatToParts 得到“那一刻在时区里的本地时间”，再反推 offset
const _offsetDTFCache = new Map();
function getOffsetDTF(tz) {
  if (_offsetDTFCache.has(tz)) return _offsetDTFCache.get(tz);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  _offsetDTFCache.set(tz, dtf);
  return dtf;
}

function tzOffsetMinutes(tz, utcMs) {
  const dtf = getOffsetDTF(tz);
  const parts = dtf.formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return (asUTC - utcMs) / 60000;
}

function zonedTimeToUtcMs(tz, year, month, day, hour, minute) {
  // 初始猜测：把本地时间当成 UTC
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  // 计算该时刻在 tz 的 offset，然后修正
  let off = tzOffsetMinutes(tz, utcMs);
  utcMs -= off * 60000;

  // 再算一次，处理 DST 边界可能变化
  const off2 = tzOffsetMinutes(tz, utcMs);
  if (off2 !== off) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute, 0) - off2 * 60000;
  }
  return utcMs;
}

const _partsDTFCache = new Map();
function getPartsDTF(tz) {
  if (_partsDTFCache.has(tz)) return _partsDTFCache.get(tz);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  _partsDTFCache.set(tz, dtf);
  return dtf;
}

function formatYMDHMInTZ(tz, utcMs) {
  const dtf = getPartsDTF(tz);
  const parts = dtf.formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const date = `${map.year}-${map.month}-${map.day}`;
  const time = `${map.hour}:${map.minute}`;
  return { date, time };
}

// ===================== 房间过期时间：endDate 当天结束后（按“房间时区”） =====================
function computeExpiresMs(endDate, timeZone) {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const nextDate = addDaysDateStr(endDate, 1);
  const [y, m, d] = nextDate.split("-").map(Number);
  return zonedTimeToUtcMs(tz, y, m, d, 0, 0);
}

function isRoomExpired(room) {
  return Date.now() >= room.expiresMs;
}

// ===================== 生成 slots（绝对 UTC 槽） =====================
function computeRoomSlots(room) {
  const tz = room.timeZone;
  const ds = parseTimeToMinutes(room.dayStart);
  const de = parseTimeToMinutes(room.dayEnd);
  if (ds == null || de == null || ds >= de) return [];

  const slots = [];
  const seen = new Set();

  let cur = room.startDate;
  while (cmpDateStr(cur, room.endDate) <= 0) {
    const [y, mo, d] = cur.split("-").map(Number);

    for (let m = ds; m < de; m += room.slotMinutes) {
      const hh = Math.floor(m / 60);
      const mm = m % 60;

      const utcMs = zonedTimeToUtcMs(tz, y, mo, d, hh, mm);
      const slotId = String(Math.floor(utcMs / 60000)); // epochMinutes

      if (!seen.has(slotId)) {
        seen.add(slotId);
        slots.push({ slotId, utcMs });
      }
    }

    cur = addDaysDateStr(cur, 1);
  }

  slots.sort((a, b) => a.utcMs - b.utcMs);
  return slots.map((x) => x.slotId);
}

// ===================== 输出给前端的 room 公共信息 =====================
function getRoomPublic(room) {
  return {
    code: room.code,
    title: room.title,
    startDate: room.startDate,
    endDate: room.endDate,
    dayStart: room.dayStart,
    dayEnd: room.dayEnd,
    slotMinutes: room.slotMinutes,
    timeZone: room.timeZone,
    creatorName: room.creatorName,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    expiresAt: new Date(room.expiresMs).toISOString(),
    expiresOn: room.endDate
  };
}

function isOwnerSocket(socket, room) {
  return socket.data?.code === room.code && socket.data?.memberId === room.ownerMemberId;
}

function addSocketMapping(room, memberId, socketId) {
  if (!room.socketsByMemberId.has(memberId)) {
    room.socketsByMemberId.set(memberId, new Set());
  }
  room.socketsByMemberId.get(memberId).add(socketId);
}

function removeSocketMapping(room, memberId, socketId) {
  const set = room.socketsByMemberId.get(memberId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) room.socketsByMemberId.delete(memberId);
}

function findMemberByName(room, name) {
  for (const m of room.members.values()) {
    if (m.name === name) return m;
  }
  return null;
}

function isNameTaken(room, name, exceptMemberId = null) {
  for (const m of room.members.values()) {
    if (m.name === name && m.id !== exceptMemberId) return true;
  }
  return false;
}

function buildConflicts(room) {
  const conflicts = new Map();
  for (const m of room.members.values()) {
    for (const slotId of m.unavailable) {
      if (!conflicts.has(slotId)) conflicts.set(slotId, []);
      conflicts.get(slotId).push(m.id);
    }
  }
  return conflicts;
}

function serializeConflicts(conflicts, detailed) {
  const obj = {};
  for (const [slotId, mids] of conflicts.entries()) {
    obj[slotId] = detailed ? mids : mids.length;
  }
  return { mode: detailed ? "detailed" : "count", data: obj };
}

function serializeMembers(room) {
  const list = [...room.members.values()].map((m) => ({
    id: m.id,
    name: m.name,
    isOwner: m.id === room.ownerMemberId,
    online: (room.socketsByMemberId.get(m.id)?.size || 0) > 0,
    joinedAt: m.joinedAt,
    lastSeenAt: m.lastSeenAt,
    confirmedAt: m.confirmedAt || null
  }));

  list.sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    return a.joinedAt.localeCompare(b.joinedAt);
  });

  return list;
}

async function emitRoomState(code) {
  const room = rooms.get(code);
  if (!room) return;

  room.updatedAt = nowISO();
  const conflicts = buildConflicts(room);
  const members = serializeMembers(room);

  const sockets = await io.in(code).fetchSockets();
  for (const s of sockets) {
    const detailed = isOwnerSocket(s, room);
    const memberId = s.data?.memberId;

    const youMember = memberId ? room.members.get(memberId) : null;
    const you = youMember
      ? {
          id: youMember.id,
          name: youMember.name,
          isOwner: youMember.id === room.ownerMemberId,
          unavailable: [...youMember.unavailable],
          confirmedAt: youMember.confirmedAt || null
        }
      : null;

    s.emit("room:state", {
      ok: true,
      room: getRoomPublic(room),
      slots: room.slots, // ✅ 给前端：绝对 UTC 槽列表（epochMinutes）
      members,
      memberCount: room.members.size,
      you,
      conflicts: serializeConflicts(conflicts, detailed),
      isHost: detailed
    });
  }
}

// ===================== 序列化 / 反序列化（用于 file / supabase） =====================
function serializeRoom(room) {
  return {
    code: room.code,
    title: room.title,
    startDate: room.startDate,
    endDate: room.endDate,
    dayStart: room.dayStart,
    dayEnd: room.dayEnd,
    slotMinutes: room.slotMinutes,
    timeZone: room.timeZone,
    creatorName: room.creatorName,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    expiresMs: room.expiresMs,
    ownerMemberId: room.ownerMemberId,
    slots: Array.isArray(room.slots) ? room.slots : [],
    members: [...room.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      joinedAt: m.joinedAt,
      lastSeenAt: m.lastSeenAt,
      unavailable: [...m.unavailable],
      confirmedAt: m.confirmedAt || null,
      pinSalt: m.pinSalt,
      pinHash: m.pinHash
    }))
  };
}

function migrateOldUnavailableKeysIfNeeded(room) {
  // 兼容旧版本：unavailable 可能是 "YYYY-MM-DD|HH:mm"
  // 现在统一为 slotId(epochMinutes)
  const need = [...room.members.values()].some((m) => [...m.unavailable].some((k) => String(k).includes("|")));
  if (!need) return;

  const mapOldKeyToSlotId = new Map();
  for (const slotId of room.slots) {
    const utcMs = Number(slotId) * 60000;
    if (!Number.isFinite(utcMs)) continue;
    const { date, time } = formatYMDHMInTZ(room.timeZone, utcMs);
    mapOldKeyToSlotId.set(`${date}|${time}`, String(slotId));
  }

  for (const m of room.members.values()) {
    const next = new Set();
    for (const k of m.unavailable) {
      const key = String(k);
      if (key.includes("|")) {
        const mapped = mapOldKeyToSlotId.get(key);
        if (mapped) next.add(mapped);
      } else if (/^\d{6,16}$/.test(key)) {
        next.add(key);
      }
    }
    m.unavailable = next;
  }
}

function deserializeRoom(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!obj.code) return null;

  const timeZoneRaw = String(obj.timeZone || "Asia/Shanghai");
  const timeZone = isValidTimeZone(timeZoneRaw) ? timeZoneRaw : "UTC";

  const room = {
    code: String(obj.code),
    title: String(obj.title || "未命名模辩"),
    startDate: String(obj.startDate || obj.endDate || ""),
    endDate: String(obj.endDate || ""),
    dayStart: String(obj.dayStart || "09:00"),
    dayEnd: String(obj.dayEnd || "23:00"),
    slotMinutes: Number(obj.slotMinutes ?? 30),
    timeZone,
    creatorName: String(obj.creatorName || "未知"),
    createdAt: String(obj.createdAt || nowISO()),
    updatedAt: String(obj.updatedAt || nowISO()),
    expiresMs: Number(obj.expiresMs ?? computeExpiresMs(String(obj.endDate || ""), timeZone)),
    ownerMemberId: String(obj.ownerMemberId || ""),
    slots: Array.isArray(obj.slots) ? obj.slots.map((x) => String(x)) : [],
    members: new Map(),
    socketsByMemberId: new Map()
  };

  if (!room.startDate || !room.endDate) return null;

  // members
  if (Array.isArray(obj.members)) {
    for (const m of obj.members) {
      if (!m?.id || !m?.name || !m?.pinSalt || !m?.pinHash) continue;
      room.members.set(String(m.id), {
        id: String(m.id),
        name: String(m.name),
        joinedAt: String(m.joinedAt || nowISO()),
        lastSeenAt: String(m.lastSeenAt || nowISO()),
        unavailable: new Set(Array.isArray(m.unavailable) ? m.unavailable.map((x) => String(x)) : []),
        confirmedAt: m.confirmedAt ? String(m.confirmedAt) : null,
        pinSalt: String(m.pinSalt),
        pinHash: String(m.pinHash)
      });
    }
  }

  // owner fallback
  if (!room.ownerMemberId || !room.members.has(room.ownerMemberId)) {
    const first = room.members.values().next().value;
    if (first?.id) room.ownerMemberId = first.id;
  }

  // slots：如果没有，就重新计算
  if (!Array.isArray(room.slots) || room.slots.length === 0) {
    room.slots = computeRoomSlots(room);
  } else {
    // 规范化 + 排序 + 去重
    const cleaned = [];
    const set = new Set();
    for (const s of room.slots) {
      const k = String(s).trim();
      if (!/^\d{6,16}$/.test(k)) continue;
      if (!set.has(k)) {
        set.add(k);
        cleaned.push(k);
      }
    }
    cleaned.sort((a, b) => Number(a) - Number(b));
    room.slots = cleaned;
  }

  // 迁移旧 unavailable
  migrateOldUnavailableKeysIfNeeded(room);

  // 过期则丢弃
  if (isRoomExpired(room)) return null;

  return room;
}

// ===================== 持久化：Supabase REST =====================
function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

async function sbLoadRooms() {
  const now = Date.now();
  const url =
    `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_TABLE)}` +
    `?select=data&expires_ms=gt.${now}&limit=2000`;

  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase load failed: ${res.status} ${txt}`);
  }

  const rows = await res.json();
  let count = 0;
  for (const row of rows) {
    const roomObj = row?.data;
    const r = deserializeRoom(roomObj);
    if (!r) continue;
    rooms.set(r.code, r);
    count++;
  }
  console.log(`Loaded rooms from Supabase: ${count}`);
}

async function sbUpsertRoom(room) {
  const row = {
    code: room.code,
    expires_ms: room.expiresMs,
    data: serializeRoom(room),
    updated_at: new Date().toISOString()
  };

  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_TABLE)}?on_conflict=code`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify([row])
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`Supabase upsert failed(${room.code}):`, res.status, txt);
  }
}

async function sbDeleteRoom(code) {
  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_TABLE)}?code=eq.${encodeURIComponent(code)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { ...supabaseHeaders(), Prefer: "return=minimal" }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`Supabase delete failed(${code}):`, res.status, txt);
  }
}

// ===================== 持久化：File（fallback） =====================
function fileLoadRooms() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.rooms)) return;

    let count = 0;
    for (const obj of data.rooms) {
      const r = deserializeRoom(obj);
      if (!r) continue;
      rooms.set(r.code, r);
      count++;
    }
    console.log(`Loaded rooms from file: ${count}`);
  } catch (e) {
    console.error("Failed to load data.json:", e?.message || e);
  }
}

function fileSaveAllRooms() {
  try {
    const data = {
      version: 3,
      savedAt: nowISO(),
      rooms: [...rooms.values()].map(serializeRoom)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save data.json:", e?.message || e);
  }
}

// ===================== 持久化调度（dirty / delete） =====================
const DIRTY = new Set();
const DELETED = new Set();
let persistTimer = null;
let persistInFlight = false;
let persistQueued = false;

function markDirty(code) {
  if (!code) return;
  DIRTY.add(code);
  schedulePersist();
}

function markDeleted(code) {
  if (!code) return;
  DELETED.add(code);
  schedulePersist();
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => queuePersistFlush(), SAVE_DEBOUNCE_MS);
}

function queuePersistFlush() {
  if (persistInFlight) {
    persistQueued = true;
    return;
  }
  persistInFlight = true;

  flushPersist()
    .catch(() => {})
    .finally(() => {
      persistInFlight = false;
      if (persistQueued) {
        persistQueued = false;
        queuePersistFlush();
      }
    });
}

async function flushPersist() {
  if (USE_SUPABASE) {
    const dirtyCodes = [...DIRTY];
    const deletedCodes = [...DELETED];
    DIRTY.clear();
    DELETED.clear();

    for (const code of dirtyCodes) {
      const room = rooms.get(code);
      if (!room) continue;
      await sbUpsertRoom(room);
    }
    for (const code of deletedCodes) {
      await sbDeleteRoom(code);
    }
    return;
  }

  // fallback: 写全量文件
  DIRTY.clear();
  DELETED.clear();
  fileSaveAllRooms();
}

// ===================== 过期清理 =====================
async function expireRoom(code, reason = "expired") {
  const room = rooms.get(code);
  if (!room) return;

  try {
    io.in(code).emit("room:expired", { ok: true, code, reason, expiresOn: room.endDate });
    const sockets = await io.in(code).fetchSockets();
    for (const s of sockets) {
      s.leave(code);
      s.data.code = null;
      s.data.memberId = null;
    }
  } catch {
    // ignore
  } finally {
    rooms.delete(code);
    markDeleted(code);
  }
}

async function cleanupExpiredRooms() {
  const now = Date.now();
  const toExpire = [];
  for (const [code, room] of rooms.entries()) {
    if (room.expiresMs <= now) toExpire.push(code);
  }
  for (const code of toExpire) {
    await expireRoom(code, "expired");
  }
}

function ensureRoomAlive(code) {
  const room = rooms.get(code);
  if (!room) return { ok: false, error: "房间不存在或已过期。" };
  if (isRoomExpired(room)) {
    expireRoom(code, "expired");
    return { ok: false, error: "房间已过期（到截止日期当天结束后自动销毁）。" };
  }
  return { ok: true, room };
}

// ===================== Socket 事件 =====================
io.on("connection", (socket) => {
  socket.data = socket.data || {};

  // 创建房间：房主设置时区 + 4位密码
  socket.on("room:create", async (payload, ack) => {
    try {
      const title = clampString(payload?.title, 80) || "未命名模辩";
      const creatorName = clampString(payload?.creatorName, 40) || "未命名成员";
      const pin = normalizePin(payload?.pin);

      const startDate = payload?.startDate;
      const endDate = payload?.endDate;
      const dayStart = payload?.dayStart || "09:00";
      const dayEnd = payload?.dayEnd || "23:00";
      const slotMinutes = Number(payload?.slotMinutes ?? 30);

      const tz = clampString(payload?.timeZone, 64) || "UTC";
      if (!isValidTimeZone(tz)) return ack?.({ ok: false, error: "时区不合法。请使用如 Asia/Shanghai、Europe/London 这类 IANA 时区名。" });

      if (!pin) return ack?.({ ok: false, error: "密码必须是 4 位数字。" });

      if (!isValidDateStr(startDate) || !isValidDateStr(endDate)) {
        return ack?.({ ok: false, error: "日期格式不对（应为 YYYY-MM-DD）。" });
      }
      const sd = dateStrToUTCms(startDate);
      const ed = dateStrToUTCms(endDate);
      if (sd > ed) return ack?.({ ok: false, error: "起始日期不能晚于结束日期。" });

      const maxDays = 21;
      const days = Math.floor((ed - sd) / (24 * 3600 * 1000)) + 1;
      if (days > maxDays) {
        return ack?.({ ok: false, error: `日期跨度太大（最多 ${maxDays} 天）。` });
      }

      const ds = parseTimeToMinutes(dayStart);
      const de = parseTimeToMinutes(dayEnd);
      if (ds == null || de == null || ds >= de) {
        return ack?.({ ok: false, error: "每天时间段不合法（开始时间要早于结束时间）。" });
      }

      const allowedSlots = new Set([15, 30, 60]);
      if (!allowedSlots.has(slotMinutes)) {
        return ack?.({ ok: false, error: "时间粒度只支持 15/30/60 分钟。" });
      }

      const code = generateUniqueCode();
      const createdAt = nowISO();

      const ownerMemberId = randomToken(10);
      const salt = randomToken(12);
      const ownerMember = {
        id: ownerMemberId,
        name: creatorName,
        joinedAt: createdAt,
        lastSeenAt: createdAt,
        unavailable: new Set(),
        confirmedAt: null,
        pinSalt: salt,
        pinHash: hashPin(pin, salt)
      };

      const room = {
        code,
        title,
        startDate,
        endDate,
        dayStart,
        dayEnd,
        slotMinutes,
        timeZone: tz,
        creatorName,
        createdAt,
        updatedAt: createdAt,
        expiresMs: computeExpiresMs(endDate, tz),
        ownerMemberId,
        slots: [],
        members: new Map([[ownerMemberId, ownerMember]]),
        socketsByMemberId: new Map()
      };

      room.slots = computeRoomSlots(room);

      rooms.set(code, room);

      socket.data.code = code;
      socket.data.memberId = ownerMemberId;

      socket.join(code);
      addSocketMapping(room, ownerMemberId, socket.id);

      markDirty(code);

      ack?.({
        ok: true,
        code,
        expiresOn: room.endDate,
        room: getRoomPublic(room),
        memberId: ownerMemberId,
        isHost: true
      });

      await emitRoomState(code);
    } catch {
      ack?.({ ok: false, error: "创建失败（服务器异常）。" });
    }
  });

  // 进入房间：房间码 + 姓名 + 4位密码（存在则校验；不存在则创建）
  socket.on("room:enter", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const name = clampString(payload?.name, 40);
    const pin = normalizePin(payload?.pin);
    const memberIdFromClient = String(payload?.memberId || "").trim();

    if (!code) return ack?.({ ok: false, error: "缺少房间码。" });
    if (!name) return ack?.({ ok: false, error: "需要姓名。" });
    if (!pin) return ack?.({ ok: false, error: "密码必须是 4 位数字。" });

    const found = ensureRoomAlive(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    const maxMembers = 120;
    let member = null;

    // 1) 优先用 memberId（同设备自动回归更稳）
    if (memberIdFromClient && room.members.has(memberIdFromClient)) {
      const m = room.members.get(memberIdFromClient);
      if (!verifyPin(m, pin)) return ack?.({ ok: false, error: "密码不正确。" });

      if (name && name !== m.name) {
        if (isNameTaken(room, name, m.id)) {
          return ack?.({ ok: false, error: "该姓名已被占用，请换一个名字。" });
        }
        m.name = name;
      }
      member = m;
    }

    // 2) 再用 name 找成员
    if (!member) {
      const existing = findMemberByName(room, name);
      if (existing) {
        if (!verifyPin(existing, pin)) return ack?.({ ok: false, error: "密码不正确。" });
        member = existing;
      }
    }

    // 3) 不存在则创建
    if (!member) {
      if (room.members.size >= maxMembers) return ack?.({ ok: false, error: "房间人数已满。" });
      if (isNameTaken(room, name)) return ack?.({ ok: false, error: "该姓名已存在，请输入正确密码或换一个名字。" });

      const id = randomToken(10);
      const t = nowISO();
      const salt = randomToken(12);

      member = {
        id,
        name,
        joinedAt: t,
        lastSeenAt: t,
        unavailable: new Set(),
        confirmedAt: null,
        pinSalt: salt,
        pinHash: hashPin(pin, salt)
      };

      room.members.set(id, member);
    }

    member.lastSeenAt = nowISO();

    socket.data.code = code;
    socket.data.memberId = member.id;

    socket.join(code);
    addSocketMapping(room, member.id, socket.id);

    room.updatedAt = nowISO();
    markDirty(code);

    ack?.({
      ok: true,
      memberId: member.id,
      isHost: member.id === room.ownerMemberId,
      room: getRoomPublic(room)
    });

    await emitRoomState(code);
  });

  // 改名
  socket.on("member:rename", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const memberId = String(payload?.memberId || "").trim();
    const newName = clampString(payload?.newName, 40);

    const found = ensureRoomAlive(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    if (socket.data?.code !== code || socket.data?.memberId !== memberId) {
      return ack?.({ ok: false, error: "无权限（会话不匹配）。" });
    }

    const m = room.members.get(memberId);
    if (!m) return ack?.({ ok: false, error: "成员不存在。" });
    if (!newName) return ack?.({ ok: false, error: "名字不能为空。" });

    if (isNameTaken(room, newName, memberId)) {
      return ack?.({ ok: false, error: "该姓名已被占用，请换一个名字。" });
    }

    m.name = newName;
    m.lastSeenAt = nowISO();
    room.updatedAt = nowISO();
    markDirty(code);

    ack?.({ ok: true });
    await emitRoomState(code);
  });

  // 更新不可行时间（slotId 列表）
  socket.on("member:set_unavailable", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const memberId = String(payload?.memberId || "").trim();
    const keys = Array.isArray(payload?.unavailable) ? payload.unavailable : [];

    const found = ensureRoomAlive(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    if (socket.data?.code !== code || socket.data?.memberId !== memberId) {
      return ack?.({ ok: false, error: "无权限（会话不匹配）。" });
    }

    const m = room.members.get(memberId);
    if (!m) return ack?.({ ok: false, error: "成员不存在。" });

    const maxKeys = 12000;
    const cleaned = [];
    for (const k0 of keys) {
      const k = String(k0).trim();
      // slotId = epochMinutes（8-12位很常见；放宽到 6-16）
      if (/^\d{6,16}$/.test(k)) {
        cleaned.push(k);
        if (cleaned.length >= maxKeys) break;
      }
    }

    m.unavailable = new Set(cleaned);
    m.confirmedAt = null;
    m.lastSeenAt = nowISO();
    room.updatedAt = nowISO();
    markDirty(code);

    ack?.({ ok: true });
    await emitRoomState(code);
  });

  // 成员确认提交
  socket.on("member:confirm", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const memberId = String(payload?.memberId || "").trim();

    const found = ensureRoomAlive(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    if (socket.data?.code !== code || socket.data?.memberId !== memberId) {
      return ack?.({ ok: false, error: "无权限（会话不匹配）。" });
    }

    const m = room.members.get(memberId);
    if (!m) return ack?.({ ok: false, error: "成员不存在。" });

    m.confirmedAt = nowISO();
    m.lastSeenAt = nowISO();
    room.updatedAt = nowISO();
    markDirty(code);

    const host = room.members.get(room.ownerMemberId);
    const hostName = host?.name || room.creatorName || "房主";

    ack?.({ ok: true, hostName, confirmedAt: m.confirmedAt });
    await emitRoomState(code);
  });

  // 退出（不删数据）
  socket.on("member:leave", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const memberId = String(payload?.memberId || "").trim();

    const found = ensureRoomAlive(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    try {
      socket.leave(code);
      removeSocketMapping(room, memberId, socket.id);
      socket.data.code = null;
      socket.data.memberId = null;
    } catch {
      // ignore
    }

    ack?.({ ok: true });
    await emitRoomState(code);
  });

  // 房主改标题
  socket.on("room:update", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const title = clampString(payload?.title, 80);

    const found = ensureRoomAlive(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    if (!isOwnerSocket(socket, room)) {
      return ack?.({ ok: false, error: "无权限（仅房主可操作）。" });
    }
    if (!title) return ack?.({ ok: false, error: "标题不能为空。" });

    room.title = title;
    room.updatedAt = nowISO();
    markDirty(code);

    ack?.({ ok: true });
    await emitRoomState(code);
  });

  // 房主踢人
  socket.on("room:kick", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const targetId = String(payload?.targetId || "").trim();

    const found = ensureRoomAlive(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    if (!isOwnerSocket(socket, room)) {
      return ack?.({ ok: false, error: "无权限（仅房主可操作）。" });
    }
    if (!room.members.has(targetId)) return ack?.({ ok: false, error: "目标成员不存在。" });
    if (targetId === room.ownerMemberId) return ack?.({ ok: false, error: "不能踢出房主本人。" });

    const socketIds = room.socketsByMemberId.get(targetId);
    if (socketIds) {
      for (const sid of socketIds) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit("room:kicked", { ok: true, code });
        if (s) s.leave(code);
        if (s) {
          s.data.code = null;
          s.data.memberId = null;
        }
      }
    }

    room.members.delete(targetId);
    room.socketsByMemberId.delete(targetId);
    room.updatedAt = nowISO();
    markDirty(code);

    ack?.({ ok: true });
    await emitRoomState(code);
  });

  // 房主解散房间
  socket.on("room:dissolve", async (payload, ack) => {
    const code = String(payload?.code || "").trim();

    const found = ensureRoomAlive(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    if (!isOwnerSocket(socket, room)) {
      return ack?.({ ok: false, error: "无权限（仅房主可操作）。" });
    }

    io.in(code).emit("room:dissolved", { ok: true, code });

    const sockets = await io.in(code).fetchSockets();
    for (const s of sockets) {
      s.leave(code);
      s.data.code = null;
      s.data.memberId = null;
    }

    rooms.delete(code);
    markDeleted(code);
    ack?.({ ok: true });
  });

  socket.on("disconnect", async () => {
    try {
      const code = socket.data?.code;
      const memberId = socket.data?.memberId;
      if (!code || !memberId) return;

      const room = rooms.get(code);
      if (!room) return;

      removeSocketMapping(room, memberId, socket.id);

      const m = room.members.get(memberId);
      if (m) m.lastSeenAt = nowISO();

      await emitRoomState(code);
    } catch {
      // ignore
    }
  });
});

// 健康检查
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    rooms: rooms.size,
    persistence: USE_SUPABASE ? "supabase" : "file",
    now: nowISO()
  })
);

// 启动：加载数据 + 清理过期 + 定时清理
async function bootstrap() {
  try {
    if (USE_SUPABASE) {
      await sbLoadRooms();
    } else {
      fileLoadRooms();
    }
  } catch (e) {
    console.error("Bootstrap load failed, fallback to file:", e?.message || e);
    fileLoadRooms();
  }

  await cleanupExpiredRooms().catch(() => {});

  setInterval(() => {
    cleanupExpiredRooms().catch(() => {});
  }, 60 * 1000);

  server.listen(PORT, () => {
    console.log(`Mock Debate Scheduler running on http://localhost:${PORT}`);
    console.log(`Persistence: ${USE_SUPABASE ? "Supabase" : "File(data.json)"}`);
  });
}

bootstrap();

