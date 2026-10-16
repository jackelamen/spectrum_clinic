(function () {
  var SUPABASE_URL = "https://pnsufyerzcestmmfnqks.supabase.co";
  var PUBLISHABLE_KEY = "sb_publishable_UKR4VVAmkroQxQ_8oCI21Q_r6QXRVgq";
  var db = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY);
  var EXCELJS_URL = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";

  /* Appointment slots run every 10 minutes between these hours (edit to match the clinic). */
  var CLINIC_START = "09:00";
  var CLINIC_END = "18:00";   // last slot starts 10 minutes before this

  var VISIT = { first: "초진", returning: "재진" };
  // Two-hour request windows inside office hours. morning/afternoon are the older choices.
  var TIME = {
    "09-11": "오전 9~11시", "11-13": "오전 11시~오후 1시", "13-15": "오후 1~3시", "15-17": "오후 3~5시", "17-18": "오후 5~6시",
    morning: "오전", afternoon: "오후", any: "상관없음"
  };
  var TIME_ORDER = { "09-11": 0, morning: 0, "11-13": 1, "13-15": 2, afternoon: 2, "15-17": 3, "17-18": 4, any: 9 };
  var STATUS = { new: "신규", contacted: "연락함", confirmed: "확정", cancelled: "취소" };
  var STATUS_ORDER = { new: 0, contacted: 1, confirmed: 2, cancelled: 3 };
  var DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  var REFRESH_MS = 60000;

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var rows = [];
  var patients = [];
  var closedMap = {};     // date -> { day, reason }: days the clinic is closed
  var CAPACITY = 0;       // set below: one appointment per 10-minute slot
  var state = {
    q: "",
    statuses: { new: true, contacted: true, confirmed: true, cancelled: false },
    dateField: "preferred_date",
    from: "", to: "", preset: "all",
    sort: "created_at", dir: "desc",
    view: "table",
    dupOnly: false,
    openId: null,
    calY: 0, calM: 0, selDay: ""
  };

  /* ---------- Dates and times (Korea time) ---------- */

  function kstDate(d) { return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10); }
  function today() { return kstDate(new Date()); }
  function addDays(iso, n) { var d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function weekday(iso) { return new Date(iso + "T00:00:00Z").getUTCDay(); }
  function weekRange() { var t = today(), mon = addDays(t, -((weekday(t) + 6) % 7)); return [mon, addDays(mon, 6)]; }
  function monthRange() {
    var t = today(), first = t.slice(0, 8) + "01", n = new Date(first + "T00:00:00Z");
    n.setUTCMonth(n.getUTCMonth() + 1); n.setUTCDate(0);
    return [first, n.toISOString().slice(0, 10)];
  }
  function fmtDay(iso) { return iso ? Number(iso.slice(5, 7)) + "/" + Number(iso.slice(8, 10)) + " (" + DAYS[weekday(iso)] + ")" : ""; }
  function fmtDayLong(iso) {
    return Number(iso.slice(0, 4)) + "년 " + Number(iso.slice(5, 7)) + "월 " + Number(iso.slice(8, 10)) + "일 " + DAYS[weekday(iso)] + "요일";
  }
  function fmtStamp(ts) {
    var k = new Date(new Date(ts).getTime() + 9 * 3600e3).toISOString();
    return Number(k.slice(5, 7)) + "/" + Number(k.slice(8, 10)) + " " + k.slice(11, 16);
  }
  function fmtTime(t) { return t ? t.slice(0, 5) : ""; }
  function relDay(iso) {
    var t = today();
    return iso === t ? "오늘" : iso === addDays(t, 1) ? "내일" : iso === addDays(t, -1) ? "어제" : "";
  }
  function digits(s) { return String(s || "").replace(/\D/g, ""); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var SLOTS = (function () {
    var out = [], a = CLINIC_START.split(":"), b = CLINIC_END.split(":");
    for (var m = a[0] * 60 + Number(a[1]); m < b[0] * 60 + Number(b[1]); m += 10) {
      out.push(("0" + Math.floor(m / 60)).slice(-2) + ":" + ("0" + (m % 60)).slice(-2));
    }
    return out;
  })();

  CAPACITY = SLOTS.length;
  (function () { var t = today(); state.calY = Number(t.slice(0, 4)); state.calM = Number(t.slice(5, 7)) - 1; state.selDay = t; })();

  /* ---------- Feedback ---------- */

  var toastTimer;
  function toast(msg, bad, long) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "toast is-visible" + (bad ? " toast--bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, long ? 5000 : 2200);
  }

  // Native <dialog> keeps focus inside and closes on Esc. Resolves "ok", "alt" or "" (cancelled).
  // Answers come from the buttons themselves, so nothing depends on the dialog's close event.
  function ask(o) {
    return new Promise(function (resolve) {
      var d = $("dlg"), done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      $("dlg-title").textContent = o.title;
      $("dlg-body").innerHTML = o.html || "";
      $("dlg-ok").textContent = o.ok || "확인";
      $("dlg-ok").className = "a-btn " + (o.danger ? "a-btn--danger" : "a-btn--primary");
      $("dlg-cancel").textContent = o.cancel || "취소";
      $("dlg-alt").hidden = !o.alt;
      $("dlg-alt").textContent = o.alt || "";
      $("dlg-ok").onclick = function () { finish("ok"); };
      $("dlg-alt").onclick = function () { finish("alt"); };
      $("dlg-cancel").onclick = function () { finish(""); };
      d.oncancel = function () { finish(""); };
      d.onclose = function () { finish(d.returnValue === "cancel" ? "" : d.returnValue); };
      d.returnValue = "";
      d.showModal();
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error("load failed")); };
      document.head.appendChild(s);
    });
  }

  /* ---------- Auth ---------- */

  function show(view) {
    ["login-view", "denied-view", "app"].forEach(function (v) { $(v).hidden = v !== view; });
  }

  var refreshTimer;
  async function route() {
    var res = await db.auth.getSession();
    var session = res.data.session;
    $("admin-user").hidden = !session;
    clearInterval(refreshTimer);
    if (!session) return show("login-view");
    $("admin-email").textContent = session.user.email;

    var staff = await db.from("staff").select("user_id").eq("user_id", session.user.id).maybeSingle();
    if (!staff.data) return show("denied-view");
    show("app");
    await load();
    // New web bookings appear without a manual refresh (paused while a record is being edited).
    refreshTimer = setInterval(function () {
      if (!document.hidden && !state.openId && !$("dlg").open) load(true);
    }, REFRESH_MS);
  }

  /* ---------- Data ---------- */

  function byId(id) { return rows.filter(function (r) { return r.id === id; })[0]; }
  function patientById(id) { return patients.filter(function (p) { return p.id === id; })[0] || null; }
  function isBlocking(r) { return r.status === "confirmed" && r.confirmed_date && r.confirmed_time; }
  function slotKey(date, time) { return date + " " + time; }

  // A confirmed appointment holds its slot. Two confirmed appointments in one slot are flagged.
  function indexSlots() {
    var map = {};
    rows.forEach(function (r) { r._dup = false; r._dupWith = []; });
    rows.forEach(function (r) {
      if (isBlocking(r)) { var k = slotKey(r.confirmed_date, fmtTime(r.confirmed_time)); (map[k] = map[k] || []).push(r); }
    });
    Object.keys(map).forEach(function (k) {
      var g = map[k];
      if (g.length > 1) g.forEach(function (r) { r._dup = true; r._dupWith = g.filter(function (x) { return x !== r; }); });
    });
  }

  function attachPatients() {
    rows.forEach(function (r) { r.patient = r.patient_id ? patientById(r.patient_id) : null; });
  }

  async function load(quiet) {
    $("list-error").classList.remove("is-visible");
    var out = await Promise.all([
      db.from("reservation_requests").select("*").order("created_at", { ascending: false }).limit(1000),
      db.from("patients").select("*").order("created_at", { ascending: false }).limit(5000),
      db.from("closed_days").select("*")
    ]);
    if (out[0].error || out[1].error || out[2].error) {
      $("list-error").textContent = "예약 목록을 불러오지 못했습니다. 새로고침해 주세요.";
      $("list-error").classList.add("is-visible");
      return;
    }
    var before = rows.length;
    patients = out[1].data;
    closedMap = {};
    out[2].data.forEach(function (c) { closedMap[c.day] = c; });
    rows = out[0].data.map(function (r) { r.created_date = kstDate(new Date(r.created_at)); return r; });
    attachPatients(); indexSlots();
    if (quiet && rows.length > before) toast("새 예약 요청 " + (rows.length - before) + "건이 들어왔습니다");
    render();
    if (state.openId) fillDrawer(true);
  }

  async function save(id, patch, silent) {
    var res = await db.from("reservation_requests").update(patch).eq("id", id).select("id");
    if (res.error || !res.data.length) { toast("저장하지 못했습니다. 다시 시도해 주세요.", true); return false; }
    rows.forEach(function (r) { if (r.id === id) Object.assign(r, patch); });
    attachPatients(); indexSlots();
    if (!silent) toast("저장됨");
    return true;
  }

  /* ---------- Filtering & sorting ---------- */

  function matches(r) {
    if (state.dupOnly) return r._dup;
    if (!state.statuses[r.status]) return false;
    if (state.from || state.to) {
      var d = r[state.dateField];
      if (!d) return false;
      if (state.from && d < state.from) return false;
      if (state.to && d > state.to) return false;
    }
    if (state.q) {
      var q = state.q.toLowerCase(), dq = digits(q);
      var hay = [r.name, r.patient && r.patient.patient_number, r.message, r.staff_note, r.phone, r.email].join(" ").toLowerCase();
      if (hay.indexOf(q) === -1 && !(dq.length >= 3 && digits(r.phone).indexOf(dq) !== -1)) return false;
    }
    return true;
  }

  function sortValue(r, key) {
    if (key === "status") return STATUS_ORDER[r.status];
    if (key === "preferred_time") return TIME_ORDER[r.preferred_time];
    if (key === "preferred_date") return r.preferred_date + TIME_ORDER[r.preferred_time];
    if (key === "confirmed_date") return r.confirmed_date ? r.confirmed_date + (r.confirmed_time || "") : null;
    if (key === "patient_number") return r.patient ? r.patient.patient_number : null;
    var v = r[key];
    return v == null || v === "" ? null : String(v).toLowerCase();
  }

  function sorted(list) {
    var dir = state.dir === "asc" ? 1 : -1;
    return list.slice().sort(function (a, b) {
      var x = sortValue(a, state.sort), y = sortValue(b, state.sort);
      if (x === y) return a.created_at < b.created_at ? 1 : -1;
      if (x == null) return 1;
      if (y == null) return -1;
      return x < y ? -dir : dir;
    });
  }

  function filtersActive() {
    return !!(state.q || state.from || state.to || state.dupOnly || state.statuses.cancelled ||
      !state.statuses.new || !state.statuses.contacted || !state.statuses.confirmed);
  }

  /* ---------- Rendering ---------- */

  function statusSelect(r) {
    return '<select class="st st--' + r.status + '" data-field="status" aria-label="상태">' +
      Object.keys(STATUS).map(function (k) {
        return '<option value="' + k + '"' + (k === r.status ? " selected" : "") + ">" + STATUS[k] + "</option>";
      }).join("") + "</select>";
  }

  function dupBadge(r) {
    return r._dup ? '<span class="dup-badge" title="같은 시간에 확정된 예약: ' + esc(r._dupWith.map(function (x) { return x.name; }).join(", ")) + '">중복 예약</span>' : "";
  }

  function pnCell(r) {
    if (r.patient) return '<span class="pn">' + esc(r.patient.patient_number) + "</span>";
    var n = suggestionsFor(r).length;
    return '<button type="button" class="pn-add" data-open-patient>' + (n ? "후보 " + n + "명" : "미지정") + "</button>";
  }

  function render() {
    var t = today(), wk = weekRange();
    var active = rows.filter(function (r) { return r.status !== "cancelled"; });
    var when = function (r) { return r.confirmed_date || r.preferred_date; };
    $("stat-new").textContent = rows.filter(function (r) { return r.status === "new"; }).length;
    $("stat-today").textContent = active.filter(function (r) { return when(r) === t; }).length;
    $("stat-week").textContent = active.filter(function (r) { var d = when(r); return d >= wk[0] && d <= wk[1]; }).length;
    $("stat-all").textContent = rows.length;
    $$("[data-count]").forEach(function (el) {
      var n = rows.filter(function (r) { return r.status === el.dataset.count; }).length;
      el.textContent = n || "";
    });

    var dups = rows.filter(function (r) { return r._dup; }).length;
    $("dup-filter").hidden = !dups;
    $("dup-filter").textContent = (state.dupOnly ? "전체 보기" : "중복 예약 " + dups + "건 보기");
    $("dup-filter").classList.toggle("is-on", state.dupOnly);

    var list = sorted(rows.filter(matches));
    $("result-count").textContent = list.length + "건" + (list.length !== rows.length ? " / 전체 " + rows.length + "건" : "");
    $("clear-filters").hidden = !filtersActive();

    $$(".grid th[data-sort]").forEach(function (th) {
      th.classList.toggle("is-sorted", th.dataset.sort === state.sort);
      th.dataset.dir = th.dataset.sort === state.sort ? state.dir : "";
      th.setAttribute("aria-sort", th.dataset.sort === state.sort ? (state.dir === "asc" ? "ascending" : "descending") : "none");
    });

    if (state.view === "table") renderTable(list);
    else if (state.view === "agenda") renderAgenda(list, t);
    else renderCalendar();
  }

  function renderTable(list) {
    $("empty").hidden = list.length > 0;
    $("grid-body").innerHTML = list.map(function (r) {
      var rel = relDay(r.preferred_date);
      var conf = r.confirmed_date
        ? '<span class="conf">' + fmtDay(r.confirmed_date) + (r.confirmed_time ? " " + fmtTime(r.confirmed_time) : "") + "</span>" +
          (r.status === "confirmed" && r.confirmation_sent_at ? ' <span class="mail-ok" title="안내 메일 발송됨">&#9993;</span>' : "")
        : '<span class="muted">미정</span>';
      return '<tr data-id="' + r.id + '" class="row--' + r.status + (r._dup ? " row--dup" : "") + (r.id === state.openId ? " is-open" : "") + '">' +
        '<td class="col-created num">' + fmtStamp(r.created_at) + "</td>" +
        '<td class="col-pn">' + pnCell(r) + "</td>" +
        '<td class="col-name"><button type="button" class="name-btn" data-open>' + esc(r.name) + "</button>" + (r._dup ? " " + dupBadge(r) : "") + "</td>" +
        '<td class="col-phone num"><a href="tel:' + esc(r.phone) + '">' + esc(r.phone) + "</a></td>" +
        '<td class="col-visit"><span class="tag tag--' + r.visit_type + '">' + VISIT[r.visit_type] + "</span></td>" +
        '<td class="col-pref num">' + fmtDay(r.preferred_date) + (rel ? ' <span class="rel">' + rel + "</span>" : "") + "</td>" +
        '<td class="col-ptime">' + TIME[r.preferred_time] + "</td>" +
        '<td class="col-status">' + statusSelect(r) + "</td>" +
        '<td class="col-conf num">' + conf + "</td>" +
        '<td class="col-msg"><span class="clip" title="' + esc(r.message) + '">' + (r.message ? esc(r.message) : '<span class="muted">-</span>') + "</span></td>" +
        '<td class="col-note"><input class="cell-input" data-field="staff_note" value="' + esc(r.staff_note) + '" placeholder="메모" maxlength="2000" aria-label="직원 메모"></td>' +
      "</tr>";
    }).join("");
  }

  function renderAgenda(list, t) {
    var groups = {};
    list.forEach(function (r) { var d = r.confirmed_date || r.preferred_date; (groups[d] = groups[d] || []).push(r); });
    var days = Object.keys(groups).sort();
    var el = $("agenda-view");
    if (!days.length) { el.innerHTML = '<p class="admin-empty">조건에 맞는 예약이 없습니다.</p>'; return; }
    el.innerHTML = days.map(function (d) {
      var items = groups[d].sort(function (a, b) {
        var x = a.confirmed_time || ("~" + TIME_ORDER[a.preferred_time]);
        var y = b.confirmed_time || ("~" + TIME_ORDER[b.preferred_time]);
        return x < y ? -1 : x > y ? 1 : 0;
      });
      var rel = relDay(d);
      return '<section class="day' + (d < t ? " day--past" : "") + (d === t ? " day--today" : "") + '">' +
        '<h3 class="day__head">' + fmtDayLong(d) + (rel ? ' <span class="rel">' + rel + "</span>" : "") +
        (closedMap[d] ? ' <span class="closed-badge">휴진</span>' : "") +
        '<span class="day__count">' + items.length + "건</span></h3>" +
        items.map(function (r) {
          var time = r.confirmed_time ? fmtTime(r.confirmed_time) : TIME[r.preferred_time];
          return '<div class="slot row--' + r.status + (r._dup ? " row--dup" : "") + '" data-id="' + r.id + '">' +
            '<span class="slot__time' + (r.confirmed_time ? "" : " is-tentative") + '">' + time + "</span>" +
            '<span><button type="button" class="name-btn" data-open>' + esc(r.name) + "</button> " + dupBadge(r) + "</span>" +
            '<span class="tag tag--' + r.visit_type + '">' + VISIT[r.visit_type] + "</span>" +
            '<span class="slot__pn">' + (r.patient ? esc(r.patient.patient_number) : "") + "</span>" +
            '<a class="slot__phone" href="tel:' + esc(r.phone) + '">' + esc(r.phone) + "</a>" +
            statusSelect(r) +
          "</div>";
        }).join("") +
      "</section>";
    }).join("");
  }

  /* ---------- Patient numbers ---------- */

  function suggestionsFor(r) {
    var d = digits(r.phone);
    return patients.map(function (p) {
      var why = d && digits(p.phone) === d ? "연락처 일치" : p.name === r.name ? "이름 일치" : "";
      return { p: p, why: why };
    }).filter(function (x) { return x.why; })
      .sort(function (a, b) { return a.why === b.why ? 0 : a.why === "연락처 일치" ? -1 : 1; })
      .slice(0, 5);
  }

  function renderPatient(r) {
    var el = $("d-patient-body");
    if (r.patient) {
      var others = rows.filter(function (x) { return x.patient_id === r.patient_id && x.id !== r.id; });
      el.innerHTML = '<div class="pt-linked"><div><div class="pt-no">' + esc(r.patient.patient_number) + '</div>' +
        '<div class="pt-meta">' + esc(r.patient.name) + "</div></div>" +
        '<button type="button" class="link-btn" data-act="unlink">연결 해제</button></div>' +
        (others.length ? '<div class="pt-others"><div class="d-label">이 환자의 다른 예약 ' + others.length + "건</div>" +
          others.map(function (x) {
            return '<button type="button" class="pt-other" data-act="goto" data-id="' + x.id + '">' + fmtDay(x.confirmed_date || x.preferred_date) +
              " · " + STATUS[x.status] + "</button>";
          }).join("") + "</div>" : "");
      return;
    }
    var sug = suggestionsFor(r);
    el.innerHTML =
      (sug.length ? '<div class="d-label">같은 환자일 수 있는 기존 환자</div><div class="pt-sugs">' + sug.map(function (s) {
        return '<button type="button" class="pt-sug" data-act="link" data-pid="' + s.p.id + '"><b>' + esc(s.p.patient_number) + "</b> " +
          esc(s.p.name) + ' <span class="pt-why">' + s.why + "</span><span class=\"pt-go\">연결</span></button>";
      }).join("") + "</div>" : '<p class="pt-none">아직 환자번호가 없습니다.</p>') +
      '<div class="pt-new"><button type="button" class="a-btn" data-act="new">새 환자번호 발급</button>' +
      '<div class="pt-manual"><input type="text" id="pt-manual-input" maxlength="30" placeholder="기존 차트번호 직접 입력" aria-label="환자번호 직접 입력">' +
      '<button type="button" class="a-btn" data-act="manual">지정</button></div></div>';
  }

  async function linkPatient(r, patient) {
    if (await save(r.id, { patient_id: patient.id }, true)) {
      toast("환자번호 " + patient.patient_number + "에 연결했습니다");
      render(); fillDrawer(false);
    }
  }

  async function createPatient(r, number) {
    var res = await db.rpc("create_patient", { p_name: r.name, p_phone: r.phone, p_number: number || null });
    if (res.error) {
      toast(res.error.code === "23505" ? "이미 사용 중인 환자번호입니다." : "환자번호를 만들지 못했습니다.", true);
      return;
    }
    patients.unshift(res.data);
    await linkPatient(r, res.data);
  }

  $("d-patient-body").addEventListener("click", async function (e) {
    var b = e.target.closest("[data-act]");
    var r = byId(state.openId);
    if (!b || !r) return;
    var act = b.dataset.act;
    if (act === "link") return linkPatient(r, patientById(b.dataset.pid));
    if (act === "new") return createPatient(r, null);
    if (act === "goto") return openDrawer(b.dataset.id);
    if (act === "unlink") {
      var ok = await ask({
        title: "환자번호 연결을 해제할까요?",
        html: "<p>이 예약만 환자번호 " + esc(r.patient.patient_number) + "에서 분리됩니다. 환자 기록은 그대로 남습니다.</p>",
        ok: "연결 해제"
      });
      if (ok === "ok" && await save(r.id, { patient_id: null }, true)) { render(); fillDrawer(false); }
      return;
    }
    if (act === "manual") {
      var n = $("pt-manual-input").value.trim();
      if (!n) return;
      var existing = patients.filter(function (p) { return p.patient_number === n; })[0];
      if (existing) {
        var go = await ask({
          title: "이미 등록된 환자번호입니다",
          html: "<p><b>" + esc(n) + "</b>는 <b>" + esc(existing.name) + "</b>님에게 등록되어 있습니다.</p><p>같은 환자라면 이 환자로 연결하세요. 다른 환자라면 다른 번호를 사용해야 합니다.</p>",
          ok: "같은 환자로 연결"
        });
        if (go === "ok") linkPatient(r, existing);
        return;
      }
      createPatient(r, n);
    }
  });

  /* ---------- Drawer ---------- */

  function openDrawer(id, toPatient) {
    state.openId = id;
    fillDrawer(true);
    $("drawer").classList.add("is-open");
    $("drawer").setAttribute("aria-hidden", "false");
    $("drawer-backdrop").hidden = false;
    $$(".grid tbody tr").forEach(function (tr) { tr.classList.toggle("is-open", tr.dataset.id === id); });
    if (toPatient) $("d-patient").scrollIntoView({ block: "start" }); else $("drawer").focus();
  }

  function closeDrawer() {
    state.openId = null;
    $("drawer").classList.remove("is-open");
    $("drawer").setAttribute("aria-hidden", "true");
    $("drawer-backdrop").hidden = true;
    $$(".grid tbody tr.is-open").forEach(function (tr) { tr.classList.remove("is-open"); });
  }

  // Fills the 확정 일시 time list for a date, marking slots that are already taken.
  function fillSlots(r, date, selected) {
    var taken = {};
    rows.forEach(function (x) {
      if (x.id !== r.id && isBlocking(x) && x.confirmed_date === date) {
        var k = fmtTime(x.confirmed_time);
        (taken[k] = taken[k] || []).push(x.name);
      }
    });
    var list = SLOTS.slice();
    if (selected && list.indexOf(selected) === -1) { list.push(selected); list.sort(); }
    $("d-ctime").innerHTML = '<option value="">시간 선택</option>' + list.map(function (s) {
      return '<option value="' + s + '"' + (s === selected ? " selected" : "") + (taken[s] ? ' class="is-taken"' : "") + ">" +
        s + (taken[s] ? "  (예약 있음: " + taken[s].join(", ") + ")" : "") + "</option>";
    }).join("");
  }

  function drawerDates() { return { date: $("d-cdate").value, time: $("d-ctime").value }; }

  function updateScheduleUi() {
    var r = byId(state.openId);
    if (!r) return;
    var d = drawerDates();
    var changed = d.date !== (r.confirmed_date || "") || d.time !== fmtTime(r.confirmed_time);
    var btn = $("d-primary");
    if (r.status === "confirmed") {
      btn.textContent = "일정 변경 저장";
      btn.disabled = !changed || !d.date || !d.time;
    } else {
      btn.textContent = r.email ? "예약 확정하고 안내 메일 보내기" : "예약 확정";
      btn.disabled = false;
    }
    var clash = d.date && d.time ? rows.filter(function (x) {
      return x.id !== r.id && isBlocking(x) && x.confirmed_date === d.date && fmtTime(x.confirmed_time) === d.time;
    }) : [];
    var warn = $("d-dup");
    if (r._dup && !changed) {
      warn.hidden = false;
      warn.innerHTML = "<b>중복 예약</b> 같은 시간에 확정된 다른 예약이 있습니다: " + r._dupWith.map(function (x) { return esc(x.name); }).join(", ");
    } else if (clash.length) {
      warn.hidden = false;
      warn.innerHTML = "<b>주의</b> 이 시간에 이미 확정된 예약이 있습니다: " + clash.map(function (x) { return esc(x.name); }).join(", ");
    } else warn.hidden = true;
  }

  function mailLine(r) {
    if (r.status !== "confirmed") return r.email ? "안내 메일 수신: " + esc(r.email) : "이메일이 없습니다. 확정 후 전화로 안내해 주세요.";
    if (!r.email) return "이메일이 없어 안내 메일을 보낼 수 없습니다. 전화로 안내해 주세요.";
    if (r.confirmation_sent_at) return '<span class="ok">&#10003; 안내 메일 발송됨</span> (' + fmtStamp(r.confirmation_sent_at) + ")";
    if (r.confirmation_error) return '<span class="bad">안내 메일 발송에 실패했습니다.</span> 아래 버튼으로 다시 보내 주세요.';
    return "안내 메일을 아직 보내지 않았습니다.";
  }

  // full = true resets the inputs (opening a record); false keeps what is typed.
  function fillDrawer(full) {
    var r = byId(state.openId);
    if (!r) return closeDrawer();
    $("d-name").textContent = r.name;
    $("d-sub").innerHTML = '<span class="tag tag--' + r.visit_type + '">' + VISIT[r.visit_type] + "</span>" +
      '<span class="st-badge st--' + r.status + '">' + STATUS[r.status] + "</span>" + dupBadge(r);
    $("d-phone").innerHTML = '<a href="tel:' + esc(r.phone) + '">' + esc(r.phone) + "</a>";
    $("d-email").textContent = r.email || "없음";
    $("d-pref").textContent = fmtDayLong(r.preferred_date) + " · " + TIME[r.preferred_time];
    $("d-created").textContent = fmtStamp(r.created_at);
    $("d-msg").textContent = r.message || "없음";
    $("d-msg").classList.toggle("is-empty", !r.message);
    $("d-status").value = r.status;
    renderPatient(r);
    if (full) {
      $("d-cdate").value = r.confirmed_date || r.preferred_date;
      fillSlots(r, $("d-cdate").value, fmtTime(r.confirmed_time));
      $("d-note").value = r.staff_note || "";
    }
    $("d-resend").hidden = !(r.status === "confirmed" && r.email);
    $("d-mail").innerHTML = mailLine(r);
    updateScheduleUi();
  }

  /* ---------- Confirming and double-booking ---------- */

  async function sendConfirmation(r) {
    if (!r.email) { toast("이메일이 없어 안내 메일은 보내지 않았습니다. 전화로 안내해 주세요.", false, true); return false; }
    var res = await db.functions.invoke("confirm-reservation", { body: { id: r.id } });
    var ok = !res.error && res.data && res.data.sent;
    toast(ok ? "안내 메일을 보냈습니다" : "안내 메일을 보내지 못했습니다. 잠시 후 다시 보내 주세요.", !ok, !ok);
    await load(true);
    return ok;
  }

  async function confirmBooking(r, date, time, reschedule) {
    if (!date || !time) {
      toast("확정 날짜와 시간을 먼저 지정해 주세요", true);
      openDrawer(r.id);
      return false;
    }
    if (closedMap[date]) {
      var open = await ask({
        title: "휴진으로 지정된 날입니다",
        html: "<p><b>" + fmtDayLong(date) + "</b>은 휴진" + (closedMap[date].reason ? " (" + esc(closedMap[date].reason) + ")" : "") + "으로 지정되어 있습니다.</p><p>그래도 이 날짜로 확정하시겠습니까?</p>",
        ok: "그래도 확정", danger: true, cancel: "다른 날짜 고르기"
      });
      if (open !== "ok") return false;
    }
    var clash = rows.filter(function (x) {
      return x.id !== r.id && isBlocking(x) && x.confirmed_date === date && fmtTime(x.confirmed_time) === time;
    });
    if (clash.length) {
      var yes = await ask({
        title: "이미 예약이 있는 시간입니다",
        html: "<p><b>" + fmtDayLong(date) + " " + time + "</b>에 이미 확정된 예약이 있습니다.</p><ul class=\"dlg__list\">" +
          clash.map(function (x) {
            return "<li><b>" + esc(x.name) + "</b>" + (x.patient ? " (" + esc(x.patient.patient_number) + ")" : "") + " · " + VISIT[x.visit_type] + "</li>";
          }).join("") + "</ul><p>그래도 같은 시간에 <b>" + esc(r.name) + "</b>님을 중복 예약하시겠습니까? 중복된 예약에는 표시가 붙습니다.</p>",
        ok: "중복 예약으로 확정", danger: true, cancel: "다른 시간 고르기"
      });
      if (yes !== "ok") return false;
    }
    var patch = { status: "confirmed", confirmed_date: date, confirmed_time: time };
    if (!(await save(r.id, patch, true))) return false;
    render(); if (state.openId === r.id) fillDrawer(true);

    if (reschedule) {
      if (r.email) {
        var again = await ask({
          title: "변경된 일정을 안내할까요?",
          html: "<p>" + esc(r.name) + "님께 변경된 예약 일시 (<b>" + fmtDayLong(date) + " " + time + "</b>)를 이메일로 다시 보내드릴 수 있습니다.</p>",
          ok: "안내 메일 보내기", cancel: "보내지 않음"
        });
        if (again === "ok") await sendConfirmation(r); else toast("일정을 변경했습니다");
      } else toast("일정을 변경했습니다. 이메일이 없어 전화로 안내해 주세요.", false, true);
    } else {
      toast(r.email ? "예약을 확정했습니다" : "예약을 확정했습니다. 이메일이 없어 전화로 안내해 주세요.", false, !r.email);
      if (r.email) await sendConfirmation(r);
    }
    return true;
  }

  /* ---------- Excel export ---------- */

  async function exportXlsx() {
    var all = sorted(rows), filtered = sorted(rows.filter(matches)), list = filtered;
    if (filtersActive() && filtered.length !== all.length) {
      var choice = await ask({
        title: "엑셀 다운로드",
        html: "<p>현재 필터에 맞는 <b>" + filtered.length + "건</b>만 받을까요, 전체 <b>" + all.length + "건</b>을 받을까요?</p>",
        ok: "전체 " + all.length + "건", alt: "현재 필터 " + filtered.length + "건", cancel: "취소"
      });
      if (!choice) return;
      list = choice === "ok" ? all : filtered;
    }
    var btn = $("export");
    btn.disabled = true; btn.textContent = "파일 만드는 중...";
    try {
      if (!window.ExcelJS) await loadScript(EXCELJS_URL);
      var wb = new ExcelJS.Workbook();
      wb.creator = "스펙트럼 채정호 정신건강의학과의원";
      wb.created = new Date();
      var ws = wb.addWorksheet("예약", { views: [{ state: "frozen", ySplit: 1 }] });
      var cols = [
        ["접수일시", 16], ["환자번호", 12], ["이름", 12], ["연락처", 16], ["이메일", 26], ["진료 구분", 10],
        ["희망일", 13], ["희망 시간대", 12], ["상태", 9], ["확정일", 13], ["확정 시간", 10], ["중복 예약", 10],
        ["안내 메일", 12], ["문의 내용", 44], ["직원 메모", 36]
      ];
      ws.columns = cols.map(function (c) { return { header: c[0], width: c[1] }; });
      var fills = { new: "FFFDEAEA", contacted: "FFFFF3D4", confirmed: "FFE2F3E8", cancelled: "FFEEECE8" };
      list.forEach(function (r) {
        var row = ws.addRow([
          fmtStamp(r.created_at), r.patient ? r.patient.patient_number : "", r.name, r.phone, r.email || "", VISIT[r.visit_type],
          new Date(r.preferred_date + "T00:00:00Z"), TIME[r.preferred_time], STATUS[r.status],
          r.confirmed_date ? new Date(r.confirmed_date + "T00:00:00Z") : "", fmtTime(r.confirmed_time),
          r._dup ? "중복" : "", r.status === "confirmed" ? (r.confirmation_sent_at ? "발송" : r.email ? "미발송" : "이메일 없음") : "",
          r.message || "", r.staff_note || ""
        ]);
        row.getCell(7).numFmt = "yyyy-mm-dd"; row.getCell(10).numFmt = "yyyy-mm-dd";
        row.getCell(4).numFmt = "@"; row.getCell(2).numFmt = "@";
        row.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fills[r.status] } };
        if (r._dup) row.getCell(12).font = { bold: true, color: { argb: "FFB42328" } };
        row.alignment = { vertical: "top", wrapText: false };
        row.getCell(14).alignment = { vertical: "top", wrapText: true };
        row.getCell(15).alignment = { vertical: "top", wrapText: true };
      });
      var head = ws.getRow(1);
      head.font = { bold: true };
      head.alignment = { vertical: "middle" };
      head.height = 24;
      head.eachCell(function (c) {
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3EFE7" } };
        c.border = { bottom: { style: "thin", color: { argb: "FFBDB8AD" } } };
      });
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

      var ps = wb.addWorksheet("환자", { views: [{ state: "frozen", ySplit: 1 }] });
      ps.columns = [{ header: "환자번호", width: 14 }, { header: "이름", width: 14 }, { header: "연락처", width: 16 }, { header: "예약 건수", width: 11 }, { header: "등록일", width: 13 }];
      patients.slice().sort(function (a, b) { return a.patient_number < b.patient_number ? -1 : 1; }).forEach(function (p) {
        var n = rows.filter(function (r) { return r.patient_id === p.id; }).length;
        var row = ps.addRow([p.patient_number, p.name, p.phone || "", n, kstDate(new Date(p.created_at))]);
        row.getCell(1).numFmt = "@"; row.getCell(3).numFmt = "@";
      });
      ps.getRow(1).font = { bold: true };
      ps.getRow(1).eachCell(function (c) { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3EFE7" } }; });

      var buf = await wb.xlsx.writeBuffer();
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      a.download = "예약목록_" + today() + ".xlsx";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      toast(list.length + "건을 엑셀 파일로 저장했습니다");
    } catch (e) {
      toast("엑셀 파일을 만들지 못했습니다. 인터넷 연결을 확인해 주세요.", true, true);
    }
    btn.disabled = false; btn.textContent = "엑셀(.xlsx) 다운로드";
  }

  /* ---------- Calendar ---------- */

  // Busyness = share of the day's 10-minute slots taken by confirmed appointments.
  var LEVELS = [
    { max: 0.34, name: "여유" },
    { max: 0.67, name: "보통" },
    { max: 1, name: "혼잡" },
    { max: Infinity, name: "마감" }
  ];
  function level(ratio) { return LEVELS.filter(function (l) { return ratio < l.max; })[0] || LEVELS[3]; }
  function hue(ratio) { return Math.round(140 * (1 - Math.min(ratio, 1))); }   // 140 green -> 0 red

  function dayStats() {
    var m = {};
    var get = function (d) { return (m[d] = m[d] || { slots: {}, appts: 0, pending: 0 }); };
    rows.forEach(function (r) {
      if (isBlocking(r)) { var d = get(r.confirmed_date); d.slots[fmtTime(r.confirmed_time)] = 1; d.appts++; }
      else if (r.status === "new" || r.status === "contacted") get(r.preferred_date).pending++;
    });
    Object.keys(m).forEach(function (k) { m[k].used = Object.keys(m[k].slots).length; });
    return m;
  }

  function renderCalendar() {
    var y = state.calY, mo = state.calM, t = today();
    $("cv-title").textContent = y + "년 " + (mo + 1) + "월";
    var stats = dayStats();
    var lead = new Date(Date.UTC(y, mo, 1)).getUTCDay();
    var days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    var html = "";
    for (var i = 0; i < lead; i++) html += '<span class="cv__blank"></span>';
    for (var d = 1; d <= days; d++) {
      var date = y + "-" + ("0" + (mo + 1)).slice(-2) + "-" + ("0" + d).slice(-2);
      var st = stats[date] || { used: 0, appts: 0, pending: 0 };
      var ratio = st.used / CAPACITY, lv = level(ratio), shut = closedMap[date];
      var cls = "cv__day" + (date === t ? " is-today" : "") + (date === state.selDay ? " is-sel" : "") +
        (shut ? " is-closed" : "") + (date < t ? " is-past" : "");
      html += '<button type="button" class="' + cls + '" data-date="' + date + '" style="--h:' + hue(ratio) + '" ' +
        'aria-label="' + (mo + 1) + "월 " + d + "일 " + DAYS[weekday(date)] + "요일, " + (shut ? "휴진" : lv.name + ", 확정 " + st.appts + "건") +
        (st.pending ? ", 요청 " + st.pending + "건" : "") + '">' +
        '<span class="cv__n">' + d + "</span>" +
        '<span class="cv__tag">' + (shut ? "휴진" : lv.name) + "</span>" +
        '<span class="cv__counts">' + (shut ? (shut.reason ? esc(shut.reason) : "") :
          (st.appts ? "<b>확정 " + st.appts + "</b>" : "") + (st.pending ? "<i>요청 " + st.pending + "</i>" : "")) + "</span>" +
        '<span class="cv__bar"><span style="width:' + Math.min(100, Math.round(ratio * 100)) + '%"></span></span>' +
      "</button>";
    }
    $("cv-grid").innerHTML = html;
    renderDayPanel(stats);
  }

  function renderDayPanel(stats) {
    var date = state.selDay;
    var el = $("cv-side");
    if (!date) { el.innerHTML = '<p class="admin-empty">날짜를 선택해 주세요.</p>'; return; }
    stats = stats || dayStats();
    var st = stats[date] || { used: 0, appts: 0, pending: 0 };
    var ratio = st.used / CAPACITY, lv = level(ratio), shut = closedMap[date];
    var rel = relDay(date);
    var appts = rows.filter(function (r) { return isBlocking(r) && r.confirmed_date === date; });
    var pend = rows.filter(function (r) { return (r.status === "new" || r.status === "contacted") && r.preferred_date === date; });
    var byTime = {};
    appts.forEach(function (r) { (byTime[fmtTime(r.confirmed_time)] = byTime[fmtTime(r.confirmed_time)] || []).push(r); });

    var h = '<div class="dp__head"><h3>' + fmtDayLong(date) + (rel ? ' <span class="rel">' + rel + "</span>" : "") + "</h3>" +
      (shut ? '<span class="closed-badge">휴진</span>' :
        '<span class="dp__state" style="--h:' + hue(ratio) + '">' + lv.name + " · " + st.used + "/" + CAPACITY + "칸</span>") + "</div>";

    if (shut) {
      h += '<div class="dp__closed"><b>휴진</b>' + (shut.reason ? " · " + esc(shut.reason) : "") +
        '<button type="button" class="a-btn" data-act="reopen">휴진 해제</button></div>';
    } else {
      h += '<button type="button" class="a-btn a-btn--block dp__close" data-act="close">이 날 휴진으로 지정</button>';
    }
    if (shut && (appts.length || pend.length)) {
      h += '<div class="d-dup"><b>확인 필요</b> 휴진일에 확정 예약 ' + appts.length + "건, 대기 요청 " + pend.length + "건이 있습니다. 환자분께 일정 변경을 안내해 주세요.</div>";
    }

    // 10-minute timetable, one row per hour.
    h += '<h4 class="dp__sub">시간표 <span>(10분 단위)</span></h4><div class="tt' + (shut ? " is-closed" : "") + '">';
    var hours = {}, hourOrder = [];
    SLOTS.forEach(function (sl) {
      var hh = sl.slice(0, 2);
      if (!hours[hh]) { hours[hh] = []; hourOrder.push(hh); }   // keep clock order, not object-key order
      hours[hh].push(sl);
    });
    hourOrder.forEach(function (hh) {
      h += '<div class="tt__row"><span class="tt__h">' + hh + "시</span><div class=\"tt__cells\">";
      hours[hh].forEach(function (sl) {
        var list = byTime[sl];
        if (!list) { h += '<span class="tt__slot" title="' + sl + ' 비어 있음">' + sl.slice(3) + "</span>"; return; }
        var dup = list.length > 1;
        h += '<button type="button" class="tt__slot is-booked' + (dup ? " is-dup" : "") + '" data-id="' + list[0].id + '" title="' + sl + " " +
          esc(list.map(function (x) { return x.name; }).join(", ")) + (dup ? " (중복 예약)" : "") + '">' +
          '<small>' + sl.slice(3) + "</small>" + esc(list[0].name) + (dup ? " +" + (list.length - 1) : "") + "</button>";
      });
      h += "</div></div>";
    });
    h += "</div>";

    // Rows that fall outside the timetable (older confirmations) still need to be reachable.
    var stray = appts.filter(function (r) { return SLOTS.indexOf(fmtTime(r.confirmed_time)) === -1; });
    if (stray.length) {
      h += '<p class="dp__stray">시간표 밖 예약: ' + stray.map(function (r) {
        return '<button type="button" class="pt-other" data-id="' + r.id + '">' + fmtTime(r.confirmed_time) + " " + esc(r.name) + "</button>";
      }).join(" ") + "</p>";
    }

    h += '<h4 class="dp__sub">이 날을 희망한 요청 <span>(' + pend.length + "건)</span></h4>";
    h += pend.length ? '<div class="dp__list">' + pend.map(function (r) {
      return '<button type="button" class="dp__req" data-id="' + r.id + '"><b>' + esc(r.name) + "</b>" +
        '<span class="tag tag--' + r.visit_type + '">' + VISIT[r.visit_type] + "</span>" +
        '<span class="dp__win">' + TIME[r.preferred_time] + "</span>" +
        '<span class="st-badge st--' + r.status + '">' + STATUS[r.status] + "</span></button>";
    }).join("") + "</div>" : '<p class="pt-none">대기 중인 요청이 없습니다.</p>';
    el.innerHTML = h;
  }

  async function closeDay(date) {
    var appts = rows.filter(function (r) { return isBlocking(r) && r.confirmed_date === date; });
    var pend = rows.filter(function (r) { return (r.status === "new" || r.status === "contacted") && r.preferred_date === date; });
    var warn = appts.length || pend.length
      ? '<div class="d-dup"><b>확인 필요</b> 이 날 확정 예약 ' + appts.length + "건, 대기 요청 " + pend.length +
        "건이 있습니다. 휴진으로 지정해도 예약이 자동으로 취소되거나 환자분께 안내되지는 않습니다.</div>" : "";
    var ok = await ask({
      title: fmtDayLong(date) + "을 휴진으로 지정할까요?",
      html: "<p>휴진으로 지정하면 환자 예약 화면에서 이 날짜가 선택되지 않습니다.</p>" + warn +
        '<label class="dlg__field">사유 (선택, 환자에게는 보이지 않습니다)<input type="text" id="closed-reason" maxlength="100" placeholder="예: 학회 참석"></label>',
      ok: "휴진으로 지정", danger: true
    });
    if (ok !== "ok") return;
    var reason = ($("closed-reason").value || "").trim() || null;
    var res = await db.from("closed_days").insert({ day: date, reason: reason }).select().single();
    if (res.error) { toast("휴진으로 지정하지 못했습니다. 다시 시도해 주세요.", true); return; }
    closedMap[date] = res.data;
    toast("휴진으로 지정했습니다");
    render();
  }

  async function reopenDay(date) {
    var ok = await ask({
      title: "휴진을 해제할까요?",
      html: "<p><b>" + fmtDayLong(date) + "</b>이 다시 예약 가능한 날이 됩니다. (월~수 외의 요일은 계속 예약이 제한됩니다.)</p>",
      ok: "휴진 해제"
    });
    if (ok !== "ok") return;
    var res = await db.from("closed_days").delete().eq("day", date);
    if (res.error) { toast("휴진을 해제하지 못했습니다. 다시 시도해 주세요.", true); return; }
    delete closedMap[date];
    toast("휴진을 해제했습니다");
    render();
  }

  function shiftCal(n) {
    var d = new Date(Date.UTC(state.calY, state.calM + n, 1));
    state.calY = d.getUTCFullYear(); state.calM = d.getUTCMonth();
    renderCalendar();
  }

  /* ---------- Filters UI ---------- */

  function setPreset(p) {
    state.preset = p;
    var t = today(), r;
    if (p === "today") r = [t, t];
    else if (p === "tomorrow") r = [addDays(t, 1), addDays(t, 1)];
    else if (p === "week") r = weekRange();
    else if (p === "month") r = monthRange();
    else r = ["", ""];
    state.from = r[0]; state.to = r[1];
    $("date-from").value = state.from; $("date-to").value = state.to;
    $$(".presets button").forEach(function (b) { b.classList.toggle("is-active", b.dataset.preset === p); });
  }

  function setStatuses(only) {
    Object.keys(state.statuses).forEach(function (k) { state.statuses[k] = only ? only.indexOf(k) !== -1 : k !== "cancelled"; });
    $$(".status-chips button").forEach(function (b) { b.classList.toggle("is-on", state.statuses[b.dataset.status]); });
  }

  function setView(v) {
    state.view = v;
    $("table-view").hidden = v !== "table";
    $("agenda-view").hidden = v !== "agenda";
    $("calendar-view").hidden = v !== "calendar";
    document.querySelector(".toolbar").classList.toggle("is-cal", v === "calendar");
    $$(".result-line").forEach(function (el) { el.hidden = v === "calendar"; });
    $$(".seg button").forEach(function (b) { b.classList.toggle("is-active", b.dataset.view === v); });
  }

  /* ---------- Events ---------- */

  var searchTimer;
  $("search").addEventListener("input", function (e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.q = e.target.value.trim(); render(); }, 120);
  });

  document.addEventListener("keydown", function (e) {
    var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (e.key === "/" && !typing && !$("app").hidden && !$("dlg").open) { e.preventDefault(); $("search").focus(); }
    if (e.key === "Escape" && state.openId && !$("dlg").open) closeDrawer();
  });

  $("date-field").addEventListener("change", function (e) { state.dateField = e.target.value; render(); });
  $$(".presets button").forEach(function (b) {
    b.addEventListener("click", function () { setPreset(b.dataset.preset); render(); });
  });
  ["date-from", "date-to"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      state.from = $("date-from").value; state.to = $("date-to").value;
      if (state.from && state.to && state.from > state.to) { state.to = state.from; $("date-to").value = state.to; }
      state.preset = "custom";
      $$(".presets button").forEach(function (b) { b.classList.remove("is-active"); });
      render();
    });
  });

  $$(".status-chips button").forEach(function (b) {
    b.addEventListener("click", function () {
      state.dupOnly = false;
      state.statuses[b.dataset.status] = !state.statuses[b.dataset.status];
      b.classList.toggle("is-on", state.statuses[b.dataset.status]);
      render();
    });
  });

  $$(".stats .stat").forEach(function (b) {
    b.addEventListener("click", function () {
      var s = b.dataset.stat;
      $("search").value = ""; state.q = ""; state.dupOnly = false;
      if (s === "new") { setStatuses(["new"]); setPreset("all"); }
      else if (s === "today" || s === "week") {
        setStatuses(null);
        $("date-field").value = state.dateField = "preferred_date";
        setPreset(s);
      } else { setStatuses(["new", "contacted", "confirmed", "cancelled"]); setPreset("all"); }
      render();
    });
  });

  $("clear-filters").addEventListener("click", function () {
    $("search").value = ""; state.q = ""; state.dupOnly = false;
    setStatuses(null); setPreset("all"); render();
  });
  $("dup-filter").addEventListener("click", function () { state.dupOnly = !state.dupOnly; render(); });

  $$(".seg button").forEach(function (b) {
    b.addEventListener("click", function () { setView(b.dataset.view); render(); });
  });

  $$(".grid th[data-sort]").forEach(function (th) {
    th.addEventListener("click", function () {
      var k = th.dataset.sort;
      if (state.sort === k) state.dir = state.dir === "asc" ? "desc" : "asc";
      else { state.sort = k; state.dir = k === "created_at" ? "desc" : "asc"; }
      render();
    });
  });

  // Inline edits in the table and agenda.
  async function onInlineChange(e) {
    var el = e.target.closest("[data-field]");
    var host = e.target.closest("[data-id]");
    if (!el || !host) return;
    var r = byId(host.dataset.id);
    if (el.dataset.field === "status") {
      // Confirming needs a date and time, a conflict check and the patient email, so it has its own flow.
      if (el.value === "confirmed" && r.status !== "confirmed") {
        render();
        return confirmBooking(r, r.confirmed_date, fmtTime(r.confirmed_time));
      }
      if (await save(r.id, { status: el.value })) render(); else render();
      if (state.openId === r.id) fillDrawer(true);
      return;
    }
    if (await save(r.id, { staff_note: el.value.trim() || null }) && state.openId === r.id) fillDrawer(true);
  }
  $("grid-body").addEventListener("change", onInlineChange);
  $("agenda-view").addEventListener("change", onInlineChange);
  $("grid-body").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.classList.contains("cell-input")) e.target.blur();
  });

  function onOpen(e) {
    var p = e.target.closest("[data-open-patient]");
    var n = e.target.closest("[data-open]");
    var host = e.target.closest("[data-id]");
    if (host && (p || n)) openDrawer(host.dataset.id, !!p);
  }
  $("grid-body").addEventListener("click", onOpen);
  $("agenda-view").addEventListener("click", onOpen);

  $("drawer-close").addEventListener("click", closeDrawer);
  $("drawer-backdrop").addEventListener("click", closeDrawer);

  $("d-cdate").addEventListener("change", function () {
    var r = byId(state.openId);
    fillSlots(r, $("d-cdate").value, $("d-ctime").value);
    updateScheduleUi();
  });
  $("d-ctime").addEventListener("change", updateScheduleUi);

  $("d-primary").addEventListener("click", function () {
    var r = byId(state.openId), d = drawerDates();
    confirmBooking(r, d.date, d.time, r.status === "confirmed");
  });
  $("d-resend").addEventListener("click", async function () {
    var r = byId(state.openId);
    $("d-resend").disabled = true;
    await sendConfirmation(r);
    $("d-resend").disabled = false;
    if (state.openId) fillDrawer(false);
  });

  $("d-status").addEventListener("change", async function (e) {
    var r = byId(state.openId), v = e.target.value;
    if (v === "confirmed" && r.status !== "confirmed") {
      e.target.value = r.status;
      var d = drawerDates();
      return confirmBooking(r, d.date, d.time, false);
    }
    if (await save(r.id, { status: v })) { render(); fillDrawer(false); } else fillDrawer(false);
  });

  $("d-note").addEventListener("change", async function (e) {
    var r = byId(state.openId);
    if (await save(r.id, { staff_note: e.target.value.trim() || null })) render();
  });

  $("cv-prev").addEventListener("click", function () { shiftCal(-1); });
  $("cv-next").addEventListener("click", function () { shiftCal(1); });
  $("cv-today").addEventListener("click", function () {
    var t = today();
    state.calY = Number(t.slice(0, 4)); state.calM = Number(t.slice(5, 7)) - 1; state.selDay = t;
    renderCalendar();
  });
  $("cv-grid").addEventListener("click", function (e) {
    var b = e.target.closest(".cv__day");
    if (!b) return;
    state.selDay = b.dataset.date;
    renderCalendar();
    if (window.innerWidth < 900) $("cv-side").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("cv-side").addEventListener("click", function (e) {
    var act = e.target.closest("[data-act]");
    if (act) return act.dataset.act === "close" ? closeDay(state.selDay) : reopenDay(state.selDay);
    var open = e.target.closest("[data-id]");
    if (open) openDrawer(open.dataset.id);
  });

  $("refresh").addEventListener("click", function () { load().then(function () { toast("최신 상태입니다"); }); });
  $("export").addEventListener("click", exportXlsx);

  $("login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var err = $("login-error");
    err.classList.remove("is-visible");
    $("login-submit").disabled = true;
    var res = await db.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    $("login-submit").disabled = false;
    if (res.error) {
      err.textContent = "이메일 또는 비밀번호가 올바르지 않습니다.";
      err.classList.add("is-visible");
      return;
    }
    $("password").value = "";
    route();
  });

  $("logout").addEventListener("click", async function () {
    await db.auth.signOut();
    rows = []; patients = [];
    closeDrawer();
    $("grid-body").innerHTML = "";
    route();
  });

  route();
})();
