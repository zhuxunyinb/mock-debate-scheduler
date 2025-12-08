const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ========== 内存数据库（MVP）==========
/**
 * room: {
 *   code, hostToken,
 *   title, startDate, endDate, dayStart, dayEnd, slotMinutes,
 *   creatorName, createdAt, updatedAt,
 *   ownerMemberId,
 *   members: Map(memberId => member),
 *   socketsByMemberId: Map(memberId => Set(socketId))
 * }
 *
 * member: { id, name, joinedAt, lastSeenAt, unavailable:Set(slotKey), confirmedAt:string|null }
 */
const rooms = new Map();

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
  for (let i = 0; i < 20; i++) {
    const code = gen6Code();
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

function isValidDateStr(s) {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(`${s}T00:00:00`).getTime();
  return Number.isFinite(t);
}

function parseTimeToMinutes(t) {
  if (typeof t !== "string" || !/^\d{2}:\d{2}$/.test(t)) return null;
  const [hh, mm] = t.split(":").map(Number);
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function clampString(s, maxLen) {
  if (typeof s !== "string") return "";
  const x = s.trim();
  return x.length > maxLen ? x.slice(0, maxLen) : x;
}

function getRoomPublic(room) {
  return {
    code: room.code,
    title: room.title,
    startDate: room.startDate,
    endDate: room.endDate,
    dayStart: room.dayStart,
    dayEnd: room.dayEnd,
    slotMinutes: room.slotMinutes,
    creatorName: room.creatorName,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

function hasHostPrivilege(socket, room) {
  const token = socket.data?.hostToken;
  return Boolean(token && token === room.hostToken);
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

function buildConflicts(room) {
  const conflicts = new Map();
  for (const m of room.members.values()) {
    for (const key of m.unavailable) {
      if (!conflicts.has(key)) conflicts.set(key, []);
      conflicts.get(key).push(m.id);
    }
  }
  return conflicts;
}

function serializeConflicts(conflicts, detailed) {
  const obj = {};
  for (const [key, mids] of conflicts.entries()) {
    obj[key] = detailed ? mids : mids.length;
  }
  return { mode: detailed ? "detailed" : "count", data: obj };
}

function serializeMembers(room) {
  const members = [...room.members.values()].map((m) => ({
    id: m.id,
    name: m.name,
    isOwner: m.id === room.ownerMemberId,
    online: (room.socketsByMemberId.get(m.id)?.size || 0) > 0,
    joinedAt: m.joinedAt,
    lastSeenAt: m.lastSeenAt,
    confirmedAt: m.confirmedAt || null
  }));

  members.sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    return a.joinedAt.localeCompare(b.joinedAt);
  });

  return members;
}

async function emitRoomState(code) {
  const room = rooms.get(code);
  if (!room) return;

  room.updatedAt = nowISO();
  const conflicts = buildConflicts(room);
  const members = serializeMembers(room);

  const sockets = await io.in(code).fetchSockets();
  for (const s of sockets) {
    const detailed = hasHostPrivilege(s, room);
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
      members,
      memberCount: room.members.size,
      you,
      conflicts: serializeConflicts(conflicts, detailed),
      isHost: detailed
    });
  }
}

function ensureRoomExists(code) {
  const room = rooms.get(code);
  if (!room) return { ok: false, error: "房间不存在或已解散。" };
  return { ok: true, room };
}

// ========== Socket 事件 ==========
io.on("connection", (socket) => {
  socket.data = socket.data || {};

  socket.on("room:create", async (payload, ack) => {
    try {
      const title = clampString(payload?.title, 80) || "未命名模辩";
      const creatorName = clampString(payload?.creatorName, 40) || "未命名成员";
      const startDate = payload?.startDate;
      const endDate = payload?.endDate;
      const dayStart = payload?.dayStart || "09:00";
      const dayEnd = payload?.dayEnd || "23:00";
      const slotMinutes = Number(payload?.slotMinutes ?? 30);

      if (!isValidDateStr(startDate) || !isValidDateStr(endDate)) {
        return ack?.({ ok: false, error: "日期格式不对（应为 YYYY-MM-DD）。" });
      }
      const sd = new Date(`${startDate}T00:00:00`).getTime();
      const ed = new Date(`${endDate}T00:00:00`).getTime();
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
      const hostToken = randomToken(18);
      const createdAt = nowISO();

      const ownerMemberId = randomToken(10);
      const ownerMember = {
        id: ownerMemberId,
        name: creatorName,
        joinedAt: createdAt,
        lastSeenAt: createdAt,
        unavailable: new Set(),
        confirmedAt: null
      };

      const room = {
        code,
        hostToken,
        title,
        startDate,
        endDate,
        dayStart,
        dayEnd,
        slotMinutes,
        creatorName,
        createdAt,
        updatedAt: createdAt,
        ownerMemberId,
        members: new Map([[ownerMemberId, ownerMember]]),
        socketsByMemberId: new Map()
      };

      rooms.set(code, room);

      socket.data.code = code;
      socket.data.memberId = ownerMemberId;
      socket.data.hostToken = hostToken;

      socket.join(code);
      addSocketMapping(room, ownerMemberId, socket.id);

      ack?.({
        ok: true,
        code,
        hostToken,
        memberId: ownerMemberId,
        room: getRoomPublic(room)
      });

      await emitRoomState(code);
    } catch (e) {
      ack?.({ ok: false, error: "创建失败（服务器异常）。" });
    }
  });

  socket.on("room:join", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const name = clampString(payload?.name, 40) || "未命名成员";

    const found = ensureRoomExists(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    const maxMembers = 60;
    if (room.members.size >= maxMembers) {
      return ack?.({ ok: false, error: "房间人数已满。" });
    }

    const memberId = randomToken(10);
    const t = nowISO();
    room.members.set(memberId, {
      id: memberId,
      name,
      joinedAt: t,
      lastSeenAt: t,
      unavailable: new Set(),
      confirmedAt: null
    });

    socket.data.code = code;
    socket.data.memberId = memberId;
    socket.join(code);
    addSocketMapping(room, memberId, socket.id);

    ack?.({ ok: true, memberId, room: getRoomPublic(room) });
    await emitRoomState(code);
  });

  socket.on("room:enter", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const found = ensureRoomExists(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    let memberId = String(payload?.memberId || "").trim();
    const name = clampString(payload?.name, 40);
    const hostToken = String(payload?.hostToken || "").trim();

    if (hostToken && hostToken === room.hostToken) {
      socket.data.hostToken = hostToken;
    }

    if (memberId && room.members.has(memberId)) {
      const m = room.members.get(memberId);
      if (name) m.name = name;
      m.lastSeenAt = nowISO();

      socket.data.code = code;
      socket.data.memberId = memberId;

      socket.join(code);
      addSocketMapping(room, memberId, socket.id);

      ack?.({
        ok: true,
        memberId,
        isHost: hasHostPrivilege(socket, room),
        room: getRoomPublic(room)
      });
      await emitRoomState(code);
      return;
    }

    if (!name) {
      return ack?.({ ok: false, error: "需要姓名才能进入房间。" });
    }

    const maxMembers = 60;
    if (room.members.size >= maxMembers) {
      return ack?.({ ok: false, error: "房间人数已满。" });
    }

    memberId = randomToken(10);
    const t = nowISO();
    room.members.set(memberId, {
      id: memberId,
      name,
      joinedAt: t,
      lastSeenAt: t,
      unavailable: new Set(),
      confirmedAt: null
    });

    socket.data.code = code;
    socket.data.memberId = memberId;
    socket.join(code);
    addSocketMapping(room, memberId, socket.id);

    ack?.({
      ok: true,
      memberId,
      isHost: hasHostPrivilege(socket, room),
      room: getRoomPublic(room)
    });
    await emitRoomState(code);
  });

  socket.on("member:rename", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const memberId = String(payload?.memberId || "").trim();
    const name = clampString(payload?.name, 40);
    const found = ensureRoomExists(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    const m = room.members.get(memberId);
    if (!m) return ack?.({ ok: false, error: "成员不存在。" });
    if (!name) return ack?.({ ok: false, error: "名字不能为空。" });

    m.name = name;
    m.lastSeenAt = nowISO();
    ack?.({ ok: true });
    await emitRoomState(code);
  });

  socket.on("member:set_unavailable", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const memberId = String(payload?.memberId || "").trim();
    const keys = Array.isArray(payload?.unavailable) ? payload.unavailable : [];

    const found = ensureRoomExists(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    const m = room.members.get(memberId);
    if (!m) return ack?.({ ok: false, error: "成员不存在。" });

    const maxKeys = 5000;
    const cleaned = [];
    for (const k of keys) {
      if (typeof k === "string" && k.length <= 32 && k.includes("|")) {
        cleaned.push(k);
        if (cleaned.length >= maxKeys) break;
      }
    }

    m.unavailable = new Set(cleaned);
    m.lastSeenAt = nowISO();

    ack?.({ ok: true });
    await emitRoomState(code);
  });

  // ✅ 新增：成员确认提交（用于给成员反馈“房主已收到”）
  socket.on("member:confirm", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const memberId = String(payload?.memberId || "").trim();

    const found = ensureRoomExists(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    const m = room.members.get(memberId);
    if (!m) return ack?.({ ok: false, error: "成员不存在。" });

    m.confirmedAt = nowISO();
    m.lastSeenAt = nowISO();

    const hostMember = room.members.get(room.ownerMemberId);
    const hostName = hostMember?.name || room.creatorName || "房主";

    ack?.({ ok: true, hostName, confirmedAt: m.confirmedAt });
    await emitRoomState(code);
  });

  socket.on("member:leave", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const memberId = String(payload?.memberId || "").trim();

    const found = ensureRoomExists(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    if (!room.members.has(memberId)) return ack?.({ ok: false, error: "成员不存在。" });

    room.members.delete(memberId);
    room.socketsByMemberId.delete(memberId);

    ack?.({ ok: true });
    await emitRoomState(code);

    if (room.members.size === 0) rooms.delete(code);
  });

  socket.on("room:update", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const hostToken = String(payload?.hostToken || "").trim();
    const title = clampString(payload?.title, 80);

    const found = ensureRoomExists(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    if (!hostToken || hostToken !== room.hostToken) {
      return ack?.({ ok: false, error: "无权限（需要房主链接/密钥）。" });
    }
    if (!title) return ack?.({ ok: false, error: "标题不能为空。" });

    room.title = title;
    room.updatedAt = nowISO();

    ack?.({ ok: true });
    await emitRoomState(code);
  });

  socket.on("room:kick", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const hostToken = String(payload?.hostToken || "").trim();
    const targetId = String(payload?.targetId || "").trim();

    const found = ensureRoomExists(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    if (!hostToken || hostToken !== room.hostToken) {
      return ack?.({ ok: false, error: "无权限（需要房主链接/密钥）。" });
    }
    if (!room.members.has(targetId)) return ack?.({ ok: false, error: "目标成员不存在。" });
    if (targetId === room.ownerMemberId) {
      return ack?.({ ok: false, error: "不能踢出房间创建者（owner）。" });
    }

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

    ack?.({ ok: true });
    await emitRoomState(code);
  });

  socket.on("room:dissolve", async (payload, ack) => {
    const code = String(payload?.code || "").trim();
    const hostToken = String(payload?.hostToken || "").trim();

    const found = ensureRoomExists(code);
    if (!found.ok) return ack?.(found);
    const room = found.room;

    if (!hostToken || hostToken !== room.hostToken) {
      return ack?.({ ok: false, error: "无权限（需要房主链接/密钥）。" });
    }

    io.in(code).emit("room:dissolved", { ok: true, code });

    const sockets = await io.in(code).fetchSockets();
    for (const s of sockets) {
      s.leave(code);
      s.data.code = null;
      s.data.memberId = null;
    }

    rooms.delete(code);
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

// 简单健康检查
app.get("/health", (req, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, () => {
  console.log(`Mock Debate Scheduler running on http://localhost:${PORT}`);
});
