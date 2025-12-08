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

(function initDates() {
  const t = todayStr();
  $("cStartDate").value = t;
  $("cEndDate").value = t;
})();

$("demoFill").addEventListener("click", () => {
  $("cTitle").value = "全英赛初赛模辩：帝国理工学院 vs 爱丁堡大学";
  $("cName").value = "队长A";

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

  toast("已填入示例");
});

$("doCreate").addEventListener("click", () => {
  $("createResult").textContent = "创建中…";

  const payload = {
    title: $("cTitle").value.trim(),
    startDate: $("cStartDate").value,
    endDate: $("cEndDate").value,
    dayStart: $("cDayStart").value,
    dayEnd: $("cDayEnd").value,
    slotMinutes: 30, // ✅ 固定 30 分钟
    creatorName: $("cName").value.trim()
  };

  socket.emit("room:create", payload, (res) => {
    if (!res?.ok) {
      $("createResult").textContent = `创建失败：${res?.error || "未知错误"}`;
      return;
    }

    const { code, hostToken, memberId } = res;

    // 持久化（用于重进房间）
    localStorage.setItem(
      `mds:${code}`,
      JSON.stringify({ memberId, name: payload.creatorName, hostToken })
    );

    const inviteLink = `${location.origin}/room.html?code=${encodeURIComponent(code)}`;
    const hostLink = `${location.origin}/room.html?code=${encodeURIComponent(code)}&host=${encodeURIComponent(hostToken)}`;

    $("createResult").innerHTML = `
      ✅ 创建成功！<br/>
      房间码：<b class="mono">${code}</b><br/>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btnGhost btnTiny" id="copyCode">复制房间码</button>
        <button class="btn btnGhost btnTiny" id="copyInvite">复制邀请链接</button>
        <button class="btn btnGhost btnTiny" id="copyHost">复制房主链接</button>
        <a class="btn btnPrimary btnTiny" href="/room.html?code=${encodeURIComponent(code)}&host=${encodeURIComponent(hostToken)}">进入房间（房主）</a>
      </div>
      <div class="small" style="margin-top:8px">
        邀请链接：<span class="mono">${inviteLink}</span><br/>
        房主链接：<span class="mono">${hostLink}</span>
      </div>
    `;

    setTimeout(() => {
      const copy = (txt) => navigator.clipboard?.writeText(txt)
        .then(() => toast("已复制"))
        .catch(() => toast("复制失败（浏览器权限）"));

      $("copyCode").addEventListener("click", () => copy(code));
      $("copyInvite").addEventListener("click", () => copy(inviteLink));
      $("copyHost").addEventListener("click", () => copy(hostLink));
    }, 0);
  });
});

$("doJoin").addEventListener("click", () => {
  $("joinResult").textContent = "加入中…";
  const code = $("jCode").value.trim();
  const name = $("jName").value.trim();

  socket.emit("room:join", { code, name }, (res) => {
    if (!res?.ok) {
      $("joinResult").textContent = `加入失败：${res?.error || "未知错误"}`;
      return;
    }

    const memberId = res.memberId;
    localStorage.setItem(`mds:${code}`, JSON.stringify({ memberId, name }));

    location.href = `/room.html?code=${encodeURIComponent(code)}`;
  });
});
