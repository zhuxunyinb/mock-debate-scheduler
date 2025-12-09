const socket = io();

const $ = (id) => document.getElementById(id);
const toastEl = $("toast");

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2200);
}

function showModal(el, yes) {
  el.classList.toggle("show", Boolean(yes));
}

function isPin4(x) {
  return /^\d{4}$/.test(String(x || "").trim());
}
function isCode6(x) {
  return /^\d{6}$/.test(String(x || "").trim());
}

function browserTZ() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const createModal = $("createModal");
const joinModal = $("joinModal");

$("openCreate").addEventListener("click", () => showModal(createModal, true));
$("closeCreate").addEventListener("click", () => showModal(createModal, false));

$("openJoin").addEventListener("click", () => showModal(joinModal, true));
$("closeJoin").addEventListener("click", () => showModal(joinModal, false));

function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

(function initDefaults() {
  const t = todayStr();
  $("cStartDate").value = t;
  $("cEndDate").value = t;
  $("cTimeZone").value = browserTZ();
})();

$("demoFill").addEventListener("click", () => {
  $("cTitle").value = "全英赛初赛模辩：帝国理工学院 vs 爱丁堡大学";
  $("cName").value = "队长A";
  $("cPin").value = "0420";

  const t = todayStr();
  $("cStartDate").value = t;

  // +3天
  const d = new Date(`${t}T00:00:00`);
  d.setDate(d.getDate() + 3);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  $("cEndDate").value = `${yyyy}-${mm}-${dd}`;

  $("cDayStart").value = "09:00";
  $("cDayEnd").value = "23:00";
  $("cTimeZone").value = browserTZ();

  toast("已填入示例");
});

$("doCreate").addEventListener("click", () => {
  $("createResult").textContent = "";

  const creatorName = $("cName").value.trim();
  const pin = $("cPin").value.trim();
  const timeZone = $("cTimeZone").value.trim() || browserTZ();

  if (!creatorName) return toast("请填写创建者姓名");
  if (!isPin4(pin)) return toast("密码必须是 4 位数字");
  if (!timeZone) return toast("请填写房间时区");

  const payload = {
    title: $("cTitle").value.trim(),
    startDate: $("cStartDate").value,
    endDate: $("cEndDate").value,
    dayStart: $("cDayStart").value,
    dayEnd: $("cDayEnd").value,
    slotMinutes: 30,
    creatorName,
    pin,
    timeZone
  };

  $("createResult").textContent = "创建中…";

  socket.emit("room:create", payload, (res) => {
    if (!res?.ok) {
      $("createResult").textContent = `创建失败：${res?.error || "未知错误"}`;
      return;
    }

    const code = res.code;
    const expiresOn = res.expiresOn || payload.endDate;
    const memberId = res.memberId;

    // 保存登录信息（同设备自动登录）
    localStorage.setItem(`mds:${code}`, JSON.stringify({ memberId, name: creatorName, pin }));

    $("createResult").innerHTML = `
      ✅ 创建成功！<br/>
      房间码：<b class="mono">${code}</b><br/>
      房间时区：<b class="mono">${timeZone}</b><br/>
      过期日期：<b>${expiresOn}</b>（到当天结束后自动销毁）<br/>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btnGhost btnTiny" id="copyCode">复制房间码</button>
        <a class="btn btnPrimary btnTiny" href="/room.html?code=${encodeURIComponent(code)}">进入房间</a>
      </div>
      <div class="small" style="margin-top:10px">
        重要：以后重新进入房间需要 “房间码 + 你的姓名 + 4位密码”。<br/>
        成员可在房间内切换显示时区。
      </div>
    `;

    setTimeout(() => {
      const copy = (txt) => navigator.clipboard?.writeText(txt)
        .then(() => toast("已复制"))
        .catch(() => toast("复制失败（浏览器权限）"));
      $("copyCode").addEventListener("click", () => copy(code));
    }, 0);
  });
});

$("doJoin").addEventListener("click", () => {
  $("joinResult").textContent = "";

  const code = $("jCode").value.trim();
  const name = $("jName").value.trim();
  const pin = $("jPin").value.trim();

  if (!isCode6(code)) return toast("房间码应为 6 位数字");
  if (!name) return toast("请填写姓名");
  if (!isPin4(pin)) return toast("密码必须是 4 位数字");

  $("joinResult").textContent = "进入中…";

  socket.emit("room:enter", { code, name, pin }, (res) => {
    if (!res?.ok) {
      $("joinResult").textContent = `进入失败：${res?.error || "未知错误"}`;
      return;
    }

    const memberId = res.memberId;
    localStorage.setItem(`mds:${code}`, JSON.stringify({ memberId, name, pin }));

    location.href = `/room.html?code=${encodeURIComponent(code)}`;
  });
});
