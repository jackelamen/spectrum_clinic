(function () {
  "use strict";

  var SUPABASE_URL = "https://pnsufyerzcestmmfnqks.supabase.co";
  var PUBLISHABLE_KEY = "sb_publishable_UKR4VVAmkroQxQ_8oCI21Q_r6QXRVgq";
  var db = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY);
  var EXCELJS_URL = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  var EXCELJS_SRI = "sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz";

  // Exact appointment times are picked in 10-minute steps between these hours, skipping lunch.
  var CLINIC_START = "09:30";
  var CLINIC_END = "18:00";
  var LUNCH = ["13:00", "14:30"];
  var REFRESH_MS = 60000;
  var MAX_RANGE_DAYS = 366;

  var VISIT = { first: "초진", returning: "재진" };
  // Request windows; the two-hour windows and morning/afternoon are older requests.
  var TIME = {
    am1: "오전 1부 (9:30 ~ 11:15)", am2: "오전 2부 (11:15 ~ 13:00)", pm1: "오후 1부 (14:30 ~ 16:15)", pm2: "오후 2부 (16:15 ~ 18:00)",
    "09-11": "오전 9시 ~ 11시", "11-13": "오전 11시 ~ 오후 1시", "13-15": "오후 1시 ~ 3시",
    "15-17": "오후 3시 ~ 5시", "17-18": "오후 5시 ~ 6시", morning: "오전", afternoon: "오후", any: "상관없음"
  };
  var STATUS = { new: "새 요청", contacted: "연락함", confirmed: "확정", cancelled: "취소" };
  var DAYS = ["일", "월", "화", "수", "목", "금", "토"];

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var rows = [];
  var closed = {};            // date -> { day, reason }
  var pending = {};           // booking id -> { date, time } picked but not yet confirmed
  var state = { tab: "bookings", q: "" };

  /* ---------- Small helpers ---------- */

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function digits(s) { return String(s || "").replace(/\D/g, ""); }
  function kstDate(d) { return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10); }
  function today() { return kstDate(new Date()); }
  function addDays(iso, n) { var d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function weekday(iso) { return new Date(iso + "T00:00:00Z").getUTCDay(); }
  function dayCount(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400e3) + 1; }
  function fmtDay(iso) { return iso ? Number(iso.slice(5, 7)) + "/" + Number(iso.slice(8, 10)) + " (" + DAYS[weekday(iso)] + ")" : ""; }
  function fmtDayY(iso) { return (iso.slice(0, 4) !== today().slice(0, 4) ? iso.slice(0, 4) + "년 " : "") + fmtDay(iso); }
  function fmtFull(iso) { return iso + " (" + DAYS[weekday(iso)] + ")"; }   // 2027-03-16 (화)
  function fmtTime(t) { return t ? t.slice(0, 5) : ""; }
  function fmtStamp(ts) {
    var k = new Date(new Date(ts).getTime() + 9 * 3600e3).toISOString();
    return Number(k.slice(5, 7)) + "/" + Number(k.slice(8, 10)) + " " + k.slice(11, 16);
  }
  function fmtStampFull(ts) { var k = new Date(new Date(ts).getTime() + 9 * 3600e3).toISOString(); return k.slice(0, 10) + " " + k.slice(11, 16); }
  function ago(ts) {
    var m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
    if (m < 1) return "방금";
    if (m < 60) return m + "분 전";
    var h = Math.floor(m / 60);
    return h < 24 ? h + "시간 전" : Math.floor(h / 24) + "일 전";
  }
  function byId(id) { return rows.filter(function (r) { return r.id === id; })[0]; }

  var SLOTS = (function () {
    var out = [], a = CLINIC_START.split(":"), b = CLINIC_END.split(":");
    for (var m = a[0] * 60 + Number(a[1]); m < b[0] * 60 + Number(b[1]); m += 10) {
      var t = ("0" + Math.floor(m / 60)).slice(-2) + ":" + ("0" + (m % 60)).slice(-2);
      if (t < LUNCH[0] || t >= LUNCH[1]) out.push(t);
    }
    return out;
  })();

  var toastTimer;
  function toast(msg, bad, undo) {
    var el = $("toast");
    el.textContent = msg;
    if (undo) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "toast__undo"; b.textContent = "실행 취소";
      b.onclick = function () { el.className = "toast"; undo(); };
      el.appendChild(b);
    }
    el.className = "toast is-on" + (bad ? " toast--bad" : "") + (undo ? " toast--act" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, undo ? 7000 : 2600);
  }

  /* ---------- Sign in ---------- */

  function show(view) {
    ["login-view", "denied-view", "app"].forEach(function (v) { $(v).hidden = v !== view; });
  }

  var timer;
  async function route() {
    var res = await db.auth.getSession();
    var session = res.data.session;
    clearInterval(timer);
    $("admin-user").hidden = !session;
    if (!session) return show("login-view");
    $("admin-email").textContent = session.user.email;
    var staff = await db.from("staff").select("user_id").eq("user_id", session.user.id).maybeSingle();
    if (!staff.data) return show("denied-view");
    show("app");
    await load();
    timer = setInterval(function () {
      var typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || "");
      if (!document.hidden && !typing) load(true);
    }, REFRESH_MS);
  }

  /* ---------- Data ---------- */

  async function load(quiet) {
    $("list-error").classList.remove("is-on");
    var out = await Promise.all([
      db.from("reservation_requests").select("*").order("created_at", { ascending: false }).limit(1000),
      db.from("closed_days").select("*")
    ]);
    if (out[0].error || out[1].error) {
      $("list-error").textContent = "예약 목록을 불러오지 못했습니다. 새로고침해 주세요.";
      $("list-error").classList.add("is-on");
      return;
    }
    var before = rows.length;
    rows = out[0].data;
    closed = {};
    out[1].data.forEach(function (c) { closed[c.day] = c; });
    if (quiet && rows.length > before) toast("새 예약 요청 " + (rows.length - before) + "건이 들어왔습니다");
    render();
  }

  async function save(id, patch) {
    var res = await db.from("reservation_requests").update(patch).eq("id", id).select("id");
    if (res.error || !res.data.length) { toast("저장하지 못했습니다. 다시 시도해 주세요.", true); return false; }
    Object.assign(byId(id), patch);
    return true;
  }

  /* ---------- Copy ---------- */

  function copyText(text) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }

  // Plain text, one line per field, ready to paste into a CRM.
  function bookingText(r) {
    var lines = [
      "이름: " + r.name,
      "연락처: " + r.phone,
      "이메일: " + (r.email || ""),
      "진료 구분: " + VISIT[r.visit_type],
      "희망 일시: " + fmtFull(r.preferred_date) + " " + TIME[r.preferred_time],
      "문의 내용: " + (r.message || "")
    ];
    if (r.confirmed_date) lines.push("확정 일시: " + fmtFull(r.confirmed_date) + (r.confirmed_time ? " " + fmtTime(r.confirmed_time) : ""));
    lines.push("상태: " + STATUS[r.status]);
    if (r.staff_note) lines.push("직원 메모: " + r.staff_note);
    lines.push("접수: " + fmtStampFull(r.created_at));
    return lines.join("\n");
  }

  var COLUMNS = ["접수일시", "이름", "연락처", "이메일", "진료 구분", "희망 날짜", "희망 시간대", "상태", "확정 날짜", "확정 시간", "문의 내용", "직원 메모"];
  function bookingRow(r) {
    return [fmtStampFull(r.created_at), r.name, r.phone, r.email || "", VISIT[r.visit_type], r.preferred_date, TIME[r.preferred_time],
      STATUS[r.status], r.confirmed_date || "", fmtTime(r.confirmed_time), r.message || "", r.staff_note || ""];
  }

  /* ---------- Bookings list ---------- */

  function visible() {
    var q = state.q.toLowerCase(), dq = digits(q);
    return rows.filter(function (r) {
      if (!q) return true;
      var hay = [r.name, r.phone, r.email, r.message, r.staff_note].join(" ").toLowerCase();
      return hay.indexOf(q) !== -1 || (dq.length >= 3 && digits(r.phone).indexOf(dq) !== -1);
    });
  }

  function slotOptions(selected) {
    var list = SLOTS.slice();
    if (selected && list.indexOf(selected) === -1) { list.push(selected); list.sort(); }
    return '<option value="">시간</option>' + list.map(function (s) {
      return '<option value="' + s + '"' + (s === selected ? " selected" : "") + ">" + s + "</option>";
    }).join("");
  }

  function mailCell(r) {
    if (r.status !== "confirmed" || !r.confirmed_time) return "";
    if (!r.email) return '<span class="mail">이메일 없음</span>';
    if (r.confirmation_sent_at) return '<span class="mail ok">&#10003; 안내 메일 발송</span>';
    return '<button type="button" class="btn-line btn-line--sm" data-act="mail">' + (r.confirmation_error ? "메일 다시 보내기" : "안내 메일 보내기") + "</button>";
  }

  function row(r) {
    var pick = pending[r.id] || { date: r.confirmed_date || "", time: fmtTime(r.confirmed_time) };
    var showConfirm = pending[r.id] || r.status !== "confirmed";
    var statusOptions = Object.keys(STATUS).map(function (k) {
      return '<option value="' + k + '"' + (k === r.status ? " selected" : "") + ">" + STATUS[k] + "</option>";
    }).join("");
    return '<tr class="row row--' + r.status + '" data-id="' + r.id + '">' +
      '<td class="c-created">' + fmtStamp(r.created_at) + "</td>" +
      '<td class="c-name"><strong>' + esc(r.name) + "</strong></td>" +
      '<td class="c-phone"><a href="tel:' + esc(r.phone) + '">' + esc(r.phone) + "</a>" + (r.email ? '<div class="sub">' + esc(r.email) + "</div>" : "") + "</td>" +
      '<td><span class="tag tag--' + r.visit_type + '">' + VISIT[r.visit_type] + "</span></td>" +
      '<td class="c-pref">' + fmtDay(r.preferred_date) + (closed[r.preferred_date] ? ' <span class="warn">휴진일</span>' : "") + '<div class="sub">' + TIME[r.preferred_time] + "</div></td>" +
      '<td><select class="st st--' + r.status + '" data-f="status" aria-label="상태">' + statusOptions + "</select></td>" +
      '<td class="c-confirm"><div class="dt"><input type="date" data-f="cdate" value="' + esc(pick.date) + '" aria-label="확정 날짜">' +
        '<select data-f="ctime" aria-label="확정 시간">' + slotOptions(pick.time) + "</select>" +
        (showConfirm ? '<button type="button" class="btn-main btn-main--sm" data-act="confirm">' + (r.status === "confirmed" ? "변경" : "확정") + "</button>" : "") +
        "</div>" + mailCell(r) + "</td>" +
      '<td class="c-msg">' + (r.message ? esc(r.message) : '<span class="muted">-</span>') + "</td>" +
      '<td class="c-note"><textarea data-f="note" rows="2" maxlength="2000" aria-label="직원 메모">' + esc(r.staff_note) + "</textarea></td>" +
      '<td><button type="button" class="btn-line btn-line--sm" data-act="copy">복사</button></td></tr>';
  }

  function render() {
    var t = today(), weekEnd = addDays(t, 6 - weekday(t));
    var conf = rows.filter(function (r) { return r.status === "confirmed" && r.confirmed_date; });
    var tiles = [
      ["신규 요청", rows.filter(function (r) { return r.status === "new"; }).length, true],
      ["오늘 예약", conf.filter(function (r) { return r.confirmed_date === t; }).length],
      ["이번 주 예약", conf.filter(function (r) { return r.confirmed_date >= t && r.confirmed_date <= weekEnd; }).length],
      ["전체", rows.length]
    ];
    $("stats").innerHTML = tiles.map(function (x) {
      return '<div class="stat"><span>' + x[0] + '</span><b' + (x[2] && x[1] ? ' class="hot"' : "") + ">" + x[1] + "</b></div>";
    }).join("");
    var list = visible();
    $("count").textContent = state.q ? list.length + "건 / 전체 " + rows.length + "건" : "전체 " + rows.length + "건";
    $("list").innerHTML = list.length
      ? '<table class="grid"><thead><tr><th>접수일시</th><th>이름</th><th>연락처</th><th>구분</th><th>희망 일시</th><th>상태</th><th>확정 일시</th><th>문의 내용</th><th>직원 메모</th><th></th></tr></thead><tbody>' +
        list.map(row).join("") + "</tbody></table>"
      : '<p class="empty">' + (state.q ? "검색 결과가 없습니다." : "예약이 없습니다.") + "</p>";
    renderClosed();
  }

  /* ---------- Actions on a booking ---------- */

  async function sendConfirmation(r) {
    var res = await db.functions.invoke("confirm-reservation", { body: { id: r.id } });
    var ok = !res.error && res.data && res.data.sent;
    toast(ok ? "안내 메일을 보냈습니다" : "안내 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.", !ok);
    await load(true);
  }

  async function confirmBooking(id, date, time) {
    var r = byId(id);
    if (!date || !time) return toast("확정 날짜와 시간을 선택해 주세요.", true);
    if (closed[date] && !window.confirm(fmtFull(date) + "은 휴진으로 지정되어 있습니다. 그래도 확정할까요?")) return;
    var clash = rows.filter(function (x) {
      return x.id !== id && x.status === "confirmed" && x.confirmed_date === date && fmtTime(x.confirmed_time) === time;
    });
    if (clash.length && !window.confirm("같은 시간(" + fmtDay(date) + " " + time + ")에 이미 확정된 예약이 있습니다: " +
      clash.map(function (x) { return x.name; }).join(", ") + "\n\n그래도 확정할까요?")) return;
    if (!(await save(id, { status: "confirmed", confirmed_date: date, confirmed_time: time }))) return;
    delete pending[id];
    render();
    toast("확정했습니다 (" + fmtDay(date) + " " + time + ")");
    if (r.email) {
      if (window.confirm(r.name + "님께 확정 안내 메일을 보낼까요?\n" + r.email)) await sendConfirmation(r);
    } else {
      toast("확정했습니다. 이메일이 없어 전화로 안내해 주세요.");
    }
  }

  $("list").addEventListener("change", async function (e) {
    var f = e.target.getAttribute("data-f");
    var tr = e.target.closest("tr");
    if (!f || !tr) return;
    var id = tr.dataset.id, r = byId(id);
    if (f === "status") {
      var prev = r.status;
      if (await save(id, { status: e.target.value })) {
        render();
        toast("'" + STATUS[e.target.value] + "'(으)로 바꿨습니다", false, async function () {
          if (await save(id, { status: prev })) render();
        });
      } else render();
    } else if (f === "note") {
      if (await save(id, { staff_note: e.target.value.trim() || null })) toast("메모를 저장했습니다");
    } else if (f === "cdate" || f === "ctime") {
      // Nothing is saved until the 확정 button is pressed; keep the picks across refreshes.
      var dEl = tr.querySelector('[data-f="cdate"]'), tEl = tr.querySelector('[data-f="ctime"]');
      if (!dEl.value && tEl.value) dEl.value = r.preferred_date;
      pending[id] = { date: dEl.value, time: tEl.value };
      if (!tr.querySelector('[data-act="confirm"]')) render();
    }
  });

  $("list").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var r = byId(b.closest("tr").dataset.id);
    if (b.dataset.act === "confirm") {
      var tr = b.closest("tr");
      confirmBooking(r.id, tr.querySelector('[data-f="cdate"]').value, tr.querySelector('[data-f="ctime"]').value);
    } else if (b.dataset.act === "copy") {
      copyText(bookingText(r)).then(function (ok) { toast(ok ? r.name + "님 정보를 복사했습니다" : "복사하지 못했습니다. 직접 선택해 복사해 주세요.", !ok); });
    } else if (b.dataset.act === "mail") {
      if (window.confirm(r.name + "님께 확정 안내 메일을 보낼까요?\n" + r.email)) sendConfirmation(r);
    }
  });

  var searchTimer;
  $("search").addEventListener("input", function (e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.q = e.target.value.trim(); render(); }, 150);
  });

  $("refresh").addEventListener("click", function () { load().then(function () { toast("최신 상태입니다"); }); });

  // Tab-separated, so it pastes cleanly into a spreadsheet or a CRM table.
  $("copy-all").addEventListener("click", function () {
    var list = visible();
    if (!list.length) return toast("복사할 예약이 없습니다.", true);
    var clean = function (v) { return String(v == null ? "" : v).replace(/[\t\r\n]+/g, " "); };
    var text = [COLUMNS].concat(list.map(bookingRow)).map(function (cols) { return cols.map(clean).join("\t"); }).join("\n");
    copyText(text).then(function (ok) { toast(ok ? list.length + "건을 표 형태로 복사했습니다" : "복사하지 못했습니다.", !ok); });
  });

  /* ---------- Excel download (all bookings) ---------- */

  function loadScript(src, integrity) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src; s.integrity = integrity; s.crossOrigin = "anonymous";
      s.onload = resolve; s.onerror = function () { reject(new Error("load failed")); };
      document.head.appendChild(s);
    });
  }

  $("export").addEventListener("click", async function () {
    var btn = $("export");
    btn.disabled = true; btn.textContent = "파일 만드는 중...";
    try {
      if (!window.ExcelJS) await loadScript(EXCELJS_URL, EXCELJS_SRI);
      var wb = new ExcelJS.Workbook();
      var ws = wb.addWorksheet("예약", { views: [{ state: "frozen", ySplit: 1 }] });
      var widths = [16, 12, 16, 26, 10, 12, 18, 9, 12, 10, 44, 36];
      ws.columns = COLUMNS.map(function (c, i) { return { header: c, width: widths[i] }; });
      rows.slice().sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).forEach(function (r) {
        var row = ws.addRow(bookingRow(r));
        row.getCell(3).numFmt = "@";
        row.alignment = { vertical: "top", wrapText: false };
        row.getCell(11).alignment = { vertical: "top", wrapText: true };
        row.getCell(12).alignment = { vertical: "top", wrapText: true };
      });
      ws.getRow(1).font = { bold: true };
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
      var buf = await wb.xlsx.writeBuffer();
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      a.download = "예약목록_" + today() + ".xlsx";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      toast(rows.length + "건을 엑셀 파일로 저장했습니다");
    } catch (err) {
      toast("엑셀 파일을 만들지 못했습니다. 인터넷 연결을 확인해 주세요.", true);
    }
    btn.disabled = false; btn.textContent = "엑셀 다운로드";
  });

  /* ---------- Closed days ---------- */

  // Consecutive closed days with the same reason read as one holiday.
  function ranges() {
    var out = [];
    Object.keys(closed).sort().forEach(function (d) {
      var reason = closed[d].reason || "", last = out[out.length - 1];
      if (last && addDays(last.to, 1) === d && last.reason === reason) last.to = d;
      else out.push({ from: d, to: d, reason: reason });
    });
    return out.filter(function (r) { return r.to >= today(); });
  }

  function renderClosed() {
    var list = ranges();
    $("closed-list").innerHTML = list.length ? list.map(function (r) {
      return '<div class="cl"><div class="cl__main"><div class="cl__dates">' + fmtDayY(r.from) + (r.from !== r.to ? " ~ " + fmtDayY(r.to) : "") +
        '<span>' + dayCount(r.from, r.to) + "일</span></div>" + (r.reason ? '<div class="cl__reason">' + esc(r.reason) + "</div>" : "") + "</div>" +
        '<button type="button" class="btn-line btn-line--danger" data-clear data-from="' + r.from + '" data-to="' + r.to + '">해제</button></div>';
    }).join("") : '<p class="empty">지정된 휴진일이 없습니다.</p>';
  }

  function rangePreview() {
    var from = $("c-from").value, to = $("c-to").value, sum = $("c-sum");
    sum.textContent = "";
    if (!from || !to) return null;
    if (to < from) { sum.textContent = "종료일이 시작일보다 앞서 있습니다."; return null; }
    var n = dayCount(from, to);
    if (n > MAX_RANGE_DAYS) { sum.textContent = "한 번에 최대 " + MAX_RANGE_DAYS + "일까지 지정할 수 있습니다."; return null; }
    var dates = [];
    for (var i = 0, d = from; i < n; i++, d = addDays(d, 1)) dates.push(d);
    var fresh = dates.filter(function (x) { return !closed[x]; });
    var hit = rows.filter(function (r) {
      return (r.status === "confirmed" && r.confirmed_date >= from && r.confirmed_date <= to) ||
        ((r.status === "new" || r.status === "contacted") && r.preferred_date >= from && r.preferred_date <= to);
    });
    sum.textContent = n + "일 중 " + fresh.length + "일을 새로 휴진으로 지정합니다." + (n - fresh.length ? " (이미 휴진인 " + (n - fresh.length) + "일은 그대로)" : "") +
      (hit.length ? " 이 기간에 확정 예약 또는 대기 요청이 " + hit.length + "건 있습니다. 자동으로 취소되지는 않습니다." : "");
    return { fresh: fresh, hit: hit };
  }

  ["c-from", "c-to"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      if ($("c-to").value && $("c-to").value < $("c-from").value) $("c-to").value = $("c-from").value;
      rangePreview();
    });
  });

  $("closed-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var err = $("closed-error");
    err.classList.remove("is-on");
    var fail = function (m) { err.textContent = m; err.classList.add("is-on"); };
    var from = $("c-from").value, to = $("c-to").value;
    if (!from || !to) return fail("시작일과 종료일을 선택해 주세요.");
    if (to < from) return fail("종료일은 시작일과 같거나 이후여야 합니다.");
    if (from < today()) return fail("지난 날짜는 지정할 수 없습니다.");
    var p = rangePreview();
    if (!p) return fail("기간을 확인해 주세요.");
    if (!p.fresh.length) return fail("선택한 날이 모두 이미 휴진입니다.");
    if (p.hit.length && !window.confirm("이 기간에 확정 예약 또는 대기 요청이 " + p.hit.length + "건 있습니다.\n휴진으로 지정해도 예약은 자동으로 취소되지 않습니다. 계속할까요?")) return;
    var reason = $("c-reason").value.trim() || null, done = [];
    $("c-add").disabled = true;
    for (var i = 0; i < p.fresh.length; i += 100) {
      var res = await db.from("closed_days").insert(p.fresh.slice(i, i + 100).map(function (d) { return { day: d, reason: reason }; })).select();
      if (res.error) { $("c-add").disabled = false; done.forEach(function (c) { closed[c.day] = c; }); render(); return fail("일부만 저장되었습니다 (" + done.length + "일). 다시 시도해 주세요."); }
      done = done.concat(res.data);
    }
    $("c-add").disabled = false;
    done.forEach(function (c) { closed[c.day] = c; });
    $("c-reason").value = ""; $("c-sum").textContent = "";
    render();
    var days = done.map(function (c) { return c.day; });
    toast(days.length + "일을 휴진으로 지정했습니다", false, async function () {
      var u = await db.from("closed_days").delete().in("day", days);
      if (u.error) return toast("되돌리지 못했습니다.", true);
      days.forEach(function (d) { delete closed[d]; });
      render();
    });
  });

  $("closed-list").addEventListener("click", async function (e) {
    var b = e.target.closest("[data-clear]");
    if (!b) return;
    var from = b.dataset.from, to = b.dataset.to, n = dayCount(from, to);
    if (!window.confirm(fmtDayY(from) + (from !== to ? " ~ " + fmtDayY(to) + " (" + n + "일)" : "") + " 휴진을 해제할까요?\n다시 예약할 수 있는 날이 됩니다. (진료 요일이 아닌 날은 계속 제한됩니다.)")) return;
    var res = await db.from("closed_days").delete().gte("day", from).lte("day", to);
    if (res.error) return toast("해제하지 못했습니다.", true);
    Object.keys(closed).forEach(function (d) { if (d >= from && d <= to) delete closed[d]; });
    toast("휴진을 해제했습니다");
    render();
  });

  /* ---------- Tabs, sign in and out ---------- */

  function showTab(name) {
    state.tab = name;
    $("tab-bookings").hidden = name !== "bookings";
    $("tab-closed").hidden = name !== "closed";
    $$(".bar__tabs button").forEach(function (b) { b.classList.toggle("is-active", b.dataset.tab === name); });
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    if (name === "closed") {
      $("c-from").min = today(); $("c-to").min = today();
      if (!$("c-from").value) { $("c-from").value = today(); $("c-to").value = today(); }
      rangePreview();
    }
  }
  $$(".bar__tabs button").forEach(function (b) { b.addEventListener("click", function () { showTab(b.dataset.tab); }); });

  $("login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var err = $("login-error");
    err.classList.remove("is-on");
    $("login-submit").disabled = true;
    var res = await db.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    $("login-submit").disabled = false;
    if (res.error) {
      err.textContent = "이메일 또는 비밀번호가 올바르지 않습니다.";
      err.classList.add("is-on");
      return;
    }
    $("password").value = "";
    route();
  });

  $("logout").addEventListener("click", async function () {
    await db.auth.signOut();
    rows = []; closed = {};
    $("list").innerHTML = "";
    route();
  });

  showTab((location.hash || "").slice(1) === "closed" ? "closed" : "bookings");
  route();
})();
