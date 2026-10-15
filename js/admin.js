(function () {
  var SUPABASE_URL = "https://pnsufyerzcestmmfnqks.supabase.co";
  var PUBLISHABLE_KEY = "sb_publishable_UKR4VVAmkroQxQ_8oCI21Q_r6QXRVgq";
  var db = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY);

  var VISIT = { first: "초진", returning: "재진" };
  var TIME = { morning: "오전", afternoon: "오후", any: "상관없음" };
  var TIME_ORDER = { morning: 0, afternoon: 1, any: 2 };
  var STATUS = { new: "신규", contacted: "연락함", confirmed: "확정", cancelled: "취소" };
  var STATUS_ORDER = { new: 0, contacted: 1, confirmed: 2, cancelled: 3 };
  var DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  var REFRESH_MS = 60000;

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var rows = [];
  var state = {
    q: "",
    statuses: { new: true, contacted: true, confirmed: true, cancelled: false },
    dateField: "preferred_date",
    from: "",
    to: "",
    preset: "all",
    sort: "created_at",
    dir: "desc",
    view: "table",
    openId: null
  };

  /* ---------- Dates (all in Korea time) ---------- */

  function kstDate(d) {
    return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  }
  function today() { return kstDate(new Date()); }
  function addDays(iso, n) {
    var d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function weekday(iso) { return new Date(iso + "T00:00:00Z").getUTCDay(); }
  function weekRange() {
    var t = today();
    var mon = addDays(t, -((weekday(t) + 6) % 7));
    return [mon, addDays(mon, 6)];
  }
  function monthRange() {
    var t = today();
    var first = t.slice(0, 8) + "01";
    var next = new Date(first + "T00:00:00Z");
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(0);
    return [first, next.toISOString().slice(0, 10)];
  }

  function fmtDay(iso) {
    if (!iso) return "";
    return Number(iso.slice(5, 7)) + "/" + Number(iso.slice(8, 10)) + " (" + DAYS[weekday(iso)] + ")";
  }
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
    if (iso === t) return "오늘";
    if (iso === addDays(t, 1)) return "내일";
    if (iso === addDays(t, -1)) return "어제";
    return "";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- Feedback ---------- */

  var toastTimer;
  function toast(msg, bad) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "toast is-visible" + (bad ? " toast--bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 2200);
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
    // New web bookings appear without a manual refresh.
    refreshTimer = setInterval(function () { if (!document.hidden) load(true); }, REFRESH_MS);
  }

  /* ---------- Data ---------- */

  async function load(quiet) {
    $("list-error").classList.remove("is-visible");
    var res = await db.from("reservation_requests").select("*").order("created_at", { ascending: false }).limit(1000);
    if (res.error) {
      $("list-error").textContent = "예약 목록을 불러오지 못했습니다. 새로고침해 주세요.";
      $("list-error").classList.add("is-visible");
      return;
    }
    var before = rows.length;
    rows = res.data.map(function (r) { r.created_date = kstDate(new Date(r.created_at)); return r; });
    if (quiet && rows.length > before) toast("새 예약 요청 " + (rows.length - before) + "건이 들어왔습니다");
    render();
    if (state.openId) fillDrawer();
  }

  async function save(id, patch) {
    var res = await db.from("reservation_requests").update(patch).eq("id", id).select("id");
    if (res.error || !res.data.length) { toast("저장하지 못했습니다. 다시 시도해 주세요.", true); return false; }
    rows.forEach(function (r) { if (r.id === id) Object.assign(r, patch); });
    toast("저장됨");
    return true;
  }

  /* ---------- Filtering & sorting ---------- */

  function matches(r) {
    if (!state.statuses[r.status]) return false;
    if (state.from || state.to) {
      var d = r[state.dateField];
      if (!d) return false;
      if (state.from && d < state.from) return false;
      if (state.to && d > state.to) return false;
    }
    if (state.q) {
      var q = state.q.toLowerCase();
      var digits = q.replace(/\D/g, "");
      var hay = [r.name, r.patient_number, r.message, r.staff_note, r.phone].join(" ").toLowerCase();
      if (hay.indexOf(q) === -1 && !(digits.length >= 3 && r.phone.replace(/\D/g, "").indexOf(digits) !== -1)) return false;
    }
    return true;
  }

  function sortValue(r, key) {
    if (key === "status") return STATUS_ORDER[r.status];
    if (key === "preferred_time") return TIME_ORDER[r.preferred_time];
    if (key === "preferred_date") return r.preferred_date + TIME_ORDER[r.preferred_time];
    if (key === "confirmed_date") return r.confirmed_date ? r.confirmed_date + (r.confirmed_time || "") : null;
    var v = r[key];
    return v == null || v === "" ? null : String(v).toLowerCase();
  }

  function sorted(list) {
    var dir = state.dir === "asc" ? 1 : -1;
    return list.slice().sort(function (a, b) {
      var x = sortValue(a, state.sort), y = sortValue(b, state.sort);
      if (x === y) return a.created_at < b.created_at ? 1 : -1;
      if (x == null) return 1;   // blanks always last
      if (y == null) return -1;
      return x < y ? -dir : dir;
    });
  }

  function filtersActive() {
    return !!(state.q || state.from || state.to || state.statuses.cancelled ||
      !state.statuses.new || !state.statuses.contacted || !state.statuses.confirmed);
  }

  /* ---------- Rendering ---------- */

  function statusSelect(r, cls) {
    return '<select class="st st--' + r.status + " " + (cls || "") + '" data-field="status" aria-label="상태">' +
      Object.keys(STATUS).map(function (k) {
        return '<option value="' + k + '"' + (k === r.status ? " selected" : "") + ">" + STATUS[k] + "</option>";
      }).join("") + "</select>";
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

    var list = sorted(rows.filter(matches));
    $("result-count").textContent = list.length + "건" + (list.length !== rows.length ? " / 전체 " + rows.length + "건" : "");
    $("clear-filters").hidden = !filtersActive();

    $$(".grid th[data-sort]").forEach(function (th) {
      th.classList.toggle("is-sorted", th.dataset.sort === state.sort);
      th.dataset.dir = th.dataset.sort === state.sort ? state.dir : "";
      th.setAttribute("aria-sort", th.dataset.sort === state.sort ? (state.dir === "asc" ? "ascending" : "descending") : "none");
    });

    if (state.view === "table") renderTable(list, t); else renderAgenda(list, t);
  }

  function renderTable(list, t) {
    $("empty").hidden = list.length > 0;
    $("grid-body").innerHTML = list.map(function (r) {
      var rel = relDay(r.preferred_date);
      var conf = r.confirmed_date
        ? '<span class="conf">' + fmtDay(r.confirmed_date) + (r.confirmed_time ? " " + fmtTime(r.confirmed_time) : "") + "</span>"
        : '<span class="muted">미정</span>';
      return '<tr data-id="' + r.id + '" class="row--' + r.status + (r.id === state.openId ? " is-open" : "") + '">' +
        '<td class="col-created num">' + fmtStamp(r.created_at) + "</td>" +
        '<td class="col-pn"><input class="cell-input" data-field="patient_number" value="' + esc(r.patient_number) + '" placeholder="입력" maxlength="30" aria-label="환자번호"></td>' +
        '<td class="col-name"><button type="button" class="name-btn" data-open>' + esc(r.name) + "</button></td>" +
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
    list.forEach(function (r) {
      var d = r.confirmed_date || r.preferred_date;
      (groups[d] = groups[d] || []).push(r);
    });
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
        '<span class="day__count">' + items.length + "건</span></h3>" +
        items.map(function (r) {
          var time = r.confirmed_time ? fmtTime(r.confirmed_time) : TIME[r.preferred_time];
          return '<div class="slot row--' + r.status + '" data-id="' + r.id + '">' +
            '<span class="slot__time' + (r.confirmed_time ? "" : " is-tentative") + '">' + time + "</span>" +
            '<button type="button" class="name-btn" data-open>' + esc(r.name) + "</button>" +
            '<span class="tag tag--' + r.visit_type + '">' + VISIT[r.visit_type] + "</span>" +
            '<span class="slot__pn">' + (r.patient_number ? esc(r.patient_number) : "") + "</span>" +
            '<a class="slot__phone" href="tel:' + esc(r.phone) + '">' + esc(r.phone) + "</a>" +
            statusSelect(r) +
          "</div>";
        }).join("") +
      "</section>";
    }).join("");
  }

  /* ---------- Drawer ---------- */

  function openDrawer(id) {
    state.openId = id;
    fillDrawer();
    $("drawer").classList.add("is-open");
    $("drawer").setAttribute("aria-hidden", "false");
    $("drawer-backdrop").hidden = false;
    $$(".grid tbody tr").forEach(function (tr) { tr.classList.toggle("is-open", tr.dataset.id === id); });
    $("drawer").focus();
  }

  function closeDrawer() {
    state.openId = null;
    $("drawer").classList.remove("is-open");
    $("drawer").setAttribute("aria-hidden", "true");
    $("drawer-backdrop").hidden = true;
    $$(".grid tbody tr.is-open").forEach(function (tr) { tr.classList.remove("is-open"); });
  }

  function current() {
    return rows.filter(function (r) { return r.id === state.openId; })[0];
  }

  function fillDrawer() {
    var r = current();
    if (!r) return closeDrawer();
    $("d-name").textContent = r.name;
    $("d-sub").innerHTML = '<span class="tag tag--' + r.visit_type + '">' + VISIT[r.visit_type] + "</span>" +
      '<span class="st-badge st--' + r.status + '">' + STATUS[r.status] + "</span>";
    $("d-phone").innerHTML = '<a href="tel:' + esc(r.phone) + '">' + esc(r.phone) + "</a>";
    $("d-pref").textContent = fmtDayLong(r.preferred_date) + " · " + TIME[r.preferred_time];
    $("d-created").textContent = fmtStamp(r.created_at);
    $("d-msg").textContent = r.message || "없음";
    $("d-msg").classList.toggle("is-empty", !r.message);
    $("d-pn").value = r.patient_number || "";
    $("d-status").value = r.status;
    $("d-cdate").value = r.confirmed_date || "";
    $("d-ctime").value = fmtTime(r.confirmed_time);
    $("d-note").value = r.staff_note || "";
  }

  async function drawerSave(patch) {
    var r = current();
    if (!r) return;
    if (await save(r.id, patch)) { fillDrawer(); render(); }
  }

  /* ---------- Export ---------- */

  function exportCsv() {
    var list = sorted(rows.filter(matches));
    var head = ["접수일시", "환자번호", "이름", "연락처", "구분", "희망일", "희망시간", "상태", "확정일", "확정시간", "문의 내용", "직원 메모"];
    var cell = function (v) { v = v == null ? "" : String(v); return '"' + v.replace(/"/g, '""') + '"'; };
    var lines = [head.map(cell).join(",")].concat(list.map(function (r) {
      return [fmtStamp(r.created_at), r.patient_number, r.name, r.phone, VISIT[r.visit_type], r.preferred_date,
        TIME[r.preferred_time], STATUS[r.status], r.confirmed_date, fmtTime(r.confirmed_time), r.message, r.staff_note].map(cell).join(",");
    }));
    // BOM so Excel opens Korean text correctly.
    var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "예약목록_" + today() + ".csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
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
    $("date-from").value = state.from;
    $("date-to").value = state.to;
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
    if (e.key === "/" && !typing && !$("app").hidden) { e.preventDefault(); $("search").focus(); }
    if (e.key === "Escape" && state.openId) closeDrawer();
  });

  $("date-field").addEventListener("change", function (e) { state.dateField = e.target.value; render(); });
  $$(".presets button").forEach(function (b) {
    b.addEventListener("click", function () { setPreset(b.dataset.preset); render(); });
  });
  ["date-from", "date-to"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      state.from = $("date-from").value;
      state.to = $("date-to").value;
      if (state.from && state.to && state.from > state.to) { state.to = state.from; $("date-to").value = state.to; }
      state.preset = "custom";
      $$(".presets button").forEach(function (b) { b.classList.remove("is-active"); });
      render();
    });
  });

  $$(".status-chips button").forEach(function (b) {
    b.addEventListener("click", function () {
      state.statuses[b.dataset.status] = !state.statuses[b.dataset.status];
      b.classList.toggle("is-on", state.statuses[b.dataset.status]);
      render();
    });
  });

  $$(".stats .stat").forEach(function (b) {
    b.addEventListener("click", function () {
      var s = b.dataset.stat;
      $("search").value = ""; state.q = "";
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
    $("search").value = ""; state.q = "";
    setStatuses(null); setPreset("all");
    render();
  });

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

  // Inline edits in the table and agenda share one handler.
  function onInlineChange(e) {
    var el = e.target.closest("[data-field]");
    var host = e.target.closest("[data-id]");
    if (!el || !host) return;
    var patch = {};
    patch[el.dataset.field] = el.value.trim() || null;
    if (el.dataset.field === "status") patch.status = el.value;
    save(host.dataset.id, patch).then(function (ok) {
      if (!ok) return render();
      if (el.dataset.field === "status") render();
      if (state.openId === host.dataset.id) fillDrawer();
    });
  }
  $("grid-body").addEventListener("change", onInlineChange);
  $("agenda-view").addEventListener("change", onInlineChange);
  $("grid-body").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.classList.contains("cell-input")) e.target.blur();
  });

  function onOpen(e) {
    var btn = e.target.closest("[data-open]");
    if (btn) openDrawer(btn.closest("[data-id]").dataset.id);
  }
  $("grid-body").addEventListener("click", onOpen);
  $("agenda-view").addEventListener("click", onOpen);

  $("drawer-close").addEventListener("click", closeDrawer);
  $("drawer-backdrop").addEventListener("click", closeDrawer);
  $("d-pn").addEventListener("change", function (e) { drawerSave({ patient_number: e.target.value.trim() || null }); });
  $("d-status").addEventListener("change", function (e) { drawerSave({ status: e.target.value }); });
  $("d-cdate").addEventListener("change", function (e) {
    var patch = { confirmed_date: e.target.value || null };
    if (!e.target.value) patch.confirmed_time = null;
    var r = current();
    // Picking an appointment date is what confirming means, so move the status along.
    if (e.target.value && r && (r.status === "new" || r.status === "contacted")) patch.status = "confirmed";
    drawerSave(patch);
  });
  $("d-ctime").addEventListener("change", function (e) { drawerSave({ confirmed_time: e.target.value || null }); });
  $("d-note").addEventListener("change", function (e) { drawerSave({ staff_note: e.target.value.trim() || null }); });

  $("refresh").addEventListener("click", function () { load().then(function () { toast("최신 상태입니다"); }); });
  $("export").addEventListener("click", exportCsv);

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
    rows = [];
    closeDrawer();
    $("grid-body").innerHTML = "";
    route();
  });

  route();
})();
