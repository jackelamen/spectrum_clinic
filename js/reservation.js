document.addEventListener("DOMContentLoaded", function () {
  var ENDPOINT = "https://pnsufyerzcestmmfnqks.supabase.co/functions/v1/reservation";
  var PUBLISHABLE_KEY = "sb_publishable_UKR4VVAmkroQxQ_8oCI21Q_r6QXRVgq";

  var form = document.getElementById("reserve-form");
  var card = document.getElementById("reserve-card");
  var errorBox = document.getElementById("form-error");
  var submit = document.getElementById("reserve-submit");
  var dateInput = document.getElementById("preferred_date");
  var phoneInput = document.getElementById("phone");

  /* ---------- Booking rules (edit here to open more days) ----------
     OPEN_DAYS: weekdays patients can book (0 = Sun ... 6 = Sat).
     Other days inside the window are greyed out.
     OPENING_DATE: no bookings before the clinic opens.
     The reservation server function enforces the same three values. */
  var SUPABASE_URL = "https://pnsufyerzcestmmfnqks.supabase.co";
  var closed = {};   // dates staff have marked as closed (loaded below)
  var OPEN_DAYS = [1, 2, 3];
  var OPENING_DATE = "2027-03-14";
  var WINDOW_DAYS = 90;

  var DOW = ["일", "월", "화", "수", "목", "금", "토"];
  var today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

  function iso(y, m, d) { return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10); }
  function dow(s) { return new Date(s + "T00:00:00Z").getUTCDay(); }
  function addDays(s, n) { var d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function longDate(s) { return Number(s.slice(0, 4)) + "년 " + Number(s.slice(5, 7)) + "월 " + Number(s.slice(8, 10)) + "일 " + DOW[dow(s)] + "요일"; }

  var firstDay = today > OPENING_DATE ? today : OPENING_DATE;
  var lastDay = addDays(firstDay, WINDOW_DAYS);
  function inWindow(s) { return s >= firstDay && s <= lastDay; }
  function isOpen(s) { return inWindow(s) && OPEN_DAYS.indexOf(dow(s)) !== -1 && !closed[s]; }

  var firstOpen = firstDay;
  function findFirstOpen() {
    var d = firstDay;
    while (d <= lastDay && !isOpen(d)) d = addDays(d, 1);
    return d;
  }
  var minMonth = firstDay.slice(0, 7);
  var view = { y: Number(firstDay.slice(0, 4)), m: Number(firstDay.slice(5, 7)) - 1 };

  var grid = document.getElementById("cal-grid");
  var prev = document.getElementById("cal-prev");
  var next = document.getElementById("cal-next");

  if (today < OPENING_DATE) {
    document.getElementById("cal-opening").textContent =
      Number(OPENING_DATE.slice(0, 4)) + "년 " + Number(OPENING_DATE.slice(5, 7)) + "월 " + Number(OPENING_DATE.slice(8, 10)) + "일 개원 예정이며, 개원일 이후 날짜로 예약하실 수 있습니다.";
  }

  // Called once the list of closed days has loaded (or failed to load).
  function applyClosed(list) {
    closed = {};
    (list || []).forEach(function (r) { closed[r.day] = true; });
    if (dateInput.value && !isOpen(dateInput.value)) {
      dateInput.value = "";
      document.getElementById("cal-picked").textContent = "";
    }
    firstOpen = findFirstOpen();
    var anyOpen = firstOpen <= lastDay;
    document.getElementById("soonest-date").textContent = anyOpen ? longDate(firstOpen) : "";
    document.getElementById("soonest").hidden = !anyOpen;
    if (!anyOpen) {
      document.getElementById("cal-opening").textContent = "현재 온라인으로 예약 가능한 날짜가 없습니다. 전화로 문의해 주세요.";
      firstOpen = firstDay;
    }
    if (!dateInput.value) view = { y: Number(firstOpen.slice(0, 4)), m: Number(firstOpen.slice(5, 7)) - 1 };
    renderCal();
  }
  function loadClosed() {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 3000);
    return fetch(SUPABASE_URL + "/rest/v1/closed_days?select=day&day=gte." + today, {
      headers: { apikey: PUBLISHABLE_KEY }, signal: ctl.signal
    }).then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (list) { clearTimeout(timer); return list; });
  }

  function renderCal() {
    document.getElementById("cal-title").textContent = view.y + "년 " + (view.m + 1) + "월";
    var html = DOW.map(function (d) { return '<div class="cal__dow">' + d + "</div>"; }).join("");
    var startDow = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay();
    var days = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
    for (var i = 0; i < startDow; i++) html += "<div></div>";
    for (var d = 1; d <= days; d++) {
      var s = iso(view.y, view.m, d);
      var open = isOpen(s);
      // Every day that cannot be booked is simply greyed out, with no label.
      // (마감 means "fully booked", which would be untrue for any of them.)
      var off = !open && inWindow(s);
      var full = false;
      var picked = s === dateInput.value;
      var soon = s === firstOpen;
      var cls = "cal__day" + (open ? " is-open" : "") + (full ? " is-full" : "") + (off ? " is-off" : "") + (soon ? " is-soonest" : "") +
        (s === today ? " is-today" : "") + (picked ? " is-selected" : "");
      var label = (view.m + 1) + "월 " + d + "일 " + DOW[dow(s)] + "요일" + (open ? "" : full ? ", 예약 마감" : ", 예약 불가");
      html += '<button type="button" class="' + cls + '" data-date="' + s + '"' +
        (open ? "" : " disabled") + (picked ? ' aria-pressed="true"' : "") + ' aria-label="' + label + '">' +
        '<span class="cal__num">' + d + "</span>" + (full ? '<span class="cal__full">마감</span>' : "") + (soon ? '<span class="cal__soon">가장 빠름</span>' : "") + "</button>";
    }
    grid.innerHTML = html;
    prev.disabled = iso(view.y, view.m, 1).slice(0, 7) <= minMonth;
    next.disabled = iso(view.y, view.m + 1, 1) > lastDay;
  }

  function shiftMonth(n) {
    var d = new Date(Date.UTC(view.y, view.m + n, 1));
    view.y = d.getUTCFullYear(); view.m = d.getUTCMonth();
    renderCal();
  }
  prev.addEventListener("click", function () { shiftMonth(-1); });
  next.addEventListener("click", function () { shiftMonth(1); });

  function pick(s) {
    dateInput.value = s;
    document.getElementById("cal-picked").textContent = "선택한 날짜: " + longDate(s);
    view = { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)) - 1 };
    renderCal();
    document.getElementById("soonest").classList.toggle("is-picked", s === firstOpen);
    document.getElementById("soonest-pick").textContent = s === firstOpen ? "\u2713 선택됨" : "이 날짜로 예약하기";
  }

  grid.addEventListener("click", function (e) {
    var b = e.target.closest(".cal__day.is-open");
    if (!b) return;
    pick(b.dataset.date);
    grid.querySelector(".is-selected").focus();
  });
  document.getElementById("soonest-pick").addEventListener("click", function () {
    pick(firstOpen);
    var next = !form.name.value.trim() ? form.name : (!phoneInput.value.trim() ? phoneInput : null);
    if (next) { next.scrollIntoView({ behavior: "smooth", block: "center" }); next.focus({ preventScroll: true }); }
    else document.getElementById("cal-picked").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  loadClosed().then(applyClosed);

  // Format phone as 010-1234-5678 while typing.
  phoneInput.addEventListener("input", function () {
    var d = phoneInput.value.replace(/\D/g, "").slice(0, 11);
    if (d.length > 7) d = d.slice(0, 3) + "-" + d.slice(3, d.length - 4) + "-" + d.slice(-4);
    else if (d.length > 3) d = d.slice(0, 3) + "-" + d.slice(3);
    phoneInput.value = d;
  });

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add("is-visible");
    errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function radio(name) {
    var el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : "";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorBox.classList.remove("is-visible");

    var data = {
      name: form.name.value.trim(),
      phone: phoneInput.value.trim(),
      email: form.email.value.trim(),
      visit_type: radio("visit_type"),
      preferred_date: dateInput.value,
      preferred_time: radio("preferred_time"),
      message: form.message.value.trim(),
      privacy_consent: form.privacy_consent.checked,
      website: form.website.value
    };

    if (!data.name) return showError("성함을 입력해 주세요.");
    if (!/^01[0-9]-?\d{3,4}-?\d{4}$/.test(data.phone)) return showError("휴대폰 번호를 정확히 입력해 주세요.");
    if (data.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) return showError("이메일 주소를 정확히 입력하시거나, 비워 두세요.");
    if (!data.visit_type) return showError("진료 구분을 선택해 주세요.");
    if (!data.preferred_date || !isOpen(data.preferred_date)) return showError("예약 가능한 희망 날짜를 선택해 주세요.");
    if (!data.preferred_time) return showError("희망 시간대를 선택해 주세요.");
    if (!data.privacy_consent) return showError("개인정보 수집 및 이용에 동의해 주세요.");

    submit.disabled = true;
    submit.textContent = "전송 중입니다...";

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: PUBLISHABLE_KEY },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        if (res.ok) {
          card.classList.add("is-done");
          card.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (body.error === "closed") {
            // The clinic closed that day after the page loaded: refresh the calendar and say so.
            loadClosed().then(applyClosed);
            showError("선택하신 날짜는 휴진입니다. 다른 날짜를 선택해 주세요.");
            submit.disabled = false;
            submit.textContent = "예약 신청하기";
            return;
          }
          if (res.status === 429) {
            showError("짧은 시간에 요청이 많이 접수되었습니다. 잠시 후 다시 시도하시거나 전화로 문의해 주세요.");
            submit.disabled = false;
            submit.textContent = "예약 신청하기";
            return;
          }
          throw new Error(res.status);
        });
      })
      .catch(function () {
        showError("일시적인 오류로 접수되지 않았습니다. 잠시 후 다시 시도해 주시거나 전화로 문의해 주세요.");
        submit.disabled = false;
        submit.textContent = "예약 신청하기";
      });
  });
});
