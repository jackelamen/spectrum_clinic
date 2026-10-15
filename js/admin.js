(function () {
  var SUPABASE_URL = "https://pnsufyerzcestmmfnqks.supabase.co";
  var PUBLISHABLE_KEY = "sb_publishable_UKR4VVAmkroQxQ_8oCI21Q_r6QXRVgq";
  var db = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY);

  var VISIT = { first: "초진", returning: "재진" };
  var TIME = { morning: "오전", afternoon: "오후", any: "상관없음" };
  var STATUS = { new: "신규", contacted: "연락함", confirmed: "확정", cancelled: "취소" };
  var DAYS = ["일", "월", "화", "수", "목", "금", "토"];

  var $ = function (id) { return document.getElementById(id); };
  var rows = [];
  var filter = "new";

  function show(view) {
    ["login-view", "denied-view", "list-view"].forEach(function (v) { $(v).hidden = v !== view; });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(d) {
    var dt = new Date(d + "T00:00:00");
    return (dt.getMonth() + 1) + "월 " + dt.getDate() + "일 (" + DAYS[dt.getDay()] + ")";
  }

  function fmtStamp(ts) {
    return new Date(ts).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  async function route() {
    var res = await db.auth.getSession();
    var session = res.data.session;
    $("admin-user").hidden = !session;
    if (!session) return show("login-view");
    $("admin-email").textContent = session.user.email;

    var staff = await db.from("staff").select("user_id").eq("user_id", session.user.id).maybeSingle();
    if (!staff.data) return show("denied-view");
    show("list-view");
    load();
  }

  async function load() {
    $("list-error").classList.remove("is-visible");
    var res = await db.from("reservation_requests").select("*").order("created_at", { ascending: false }).limit(500);
    if (res.error) {
      $("list-error").textContent = "예약 목록을 불러오지 못했습니다. 새로고침해 주세요.";
      $("list-error").classList.add("is-visible");
      return;
    }
    rows = res.data;
    render();
  }

  function render() {
    var counts = { all: rows.length, new: 0, contacted: 0, confirmed: 0, cancelled: 0 };
    rows.forEach(function (r) { counts[r.status]++; });
    document.querySelectorAll("[data-count]").forEach(function (el) {
      el.textContent = counts[el.dataset.count] || "";
    });

    var list = rows.filter(function (r) { return filter === "all" || r.status === filter; });
    $("empty").hidden = list.length > 0;
    $("booking-list").innerHTML = list.map(function (r) {
      var options = Object.keys(STATUS).map(function (k) {
        return '<option value="' + k + '"' + (k === r.status ? " selected" : "") + ">" + STATUS[k] + "</option>";
      }).join("");
      return '<article class="booking booking--' + r.status + '" data-id="' + r.id + '">' +
        '<div class="booking__head">' +
          '<div><strong class="booking__name">' + esc(r.name) + '</strong>' +
          '<span class="booking__tag">' + VISIT[r.visit_type] + '</span></div>' +
          '<select class="booking__status" aria-label="상태">' + options + '</select>' +
        '</div>' +
        '<div class="booking__meta">' +
          '<a href="tel:' + esc(r.phone) + '">' + esc(r.phone) + '</a>' +
          '<span>희망: ' + fmtDate(r.preferred_date) + ' · ' + TIME[r.preferred_time] + '</span>' +
          '<span class="booking__received">접수 ' + fmtStamp(r.created_at) + '</span>' +
        '</div>' +
        (r.message ? '<p class="booking__msg">' + esc(r.message) + '</p>' : '') +
        '<label class="booking__note"><span>직원 메모</span>' +
          '<textarea rows="2" maxlength="2000" placeholder="통화 내용, 확정 시간 등">' + esc(r.staff_note) + '</textarea></label>' +
        '<div class="booking__saved" aria-live="polite"></div>' +
      '</article>';
    }).join("");
  }

  async function save(card, patch) {
    var id = card.dataset.id;
    var note = card.querySelector(".booking__saved");
    note.textContent = "저장 중...";
    var res = await db.from("reservation_requests").update(patch).eq("id", id).select("id");
    if (res.error || !res.data.length) { note.textContent = "저장 실패. 다시 시도해 주세요."; return false; }
    rows.forEach(function (r) { if (r.id === id) Object.assign(r, patch); });
    note.textContent = "저장됨";
    return true;
  }

  $("booking-list").addEventListener("change", async function (e) {
    var card = e.target.closest(".booking");
    if (!card) return;
    if (e.target.matches(".booking__status")) {
      if (await save(card, { status: e.target.value })) setTimeout(render, 600);
    } else if (e.target.matches("textarea")) {
      save(card, { staff_note: e.target.value.trim() || null });
    }
  });

  document.querySelector(".admin-tabs").addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    filter = btn.dataset.filter;
    document.querySelectorAll(".admin-tabs button").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
    render();
  });

  $("refresh").addEventListener("click", load);

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
    $("booking-list").innerHTML = "";
    route();
  });

  route();
})();
