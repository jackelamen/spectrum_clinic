document.addEventListener("DOMContentLoaded", function () {
  var ENDPOINT = "https://pnsufyerzcestmmfnqks.supabase.co/functions/v1/reservation";
  var PUBLISHABLE_KEY = "sb_publishable_UKR4VVAmkroQxQ_8oCI21Q_r6QXRVgq";

  var form = document.getElementById("reserve-form");
  var card = document.getElementById("reserve-card");
  var errorBox = document.getElementById("form-error");
  var submit = document.getElementById("reserve-submit");
  var dateInput = document.getElementById("preferred_date");
  var phoneInput = document.getElementById("phone");

  // Earliest selectable date is today in Korea time.
  var today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  dateInput.min = today;

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
      visit_type: radio("visit_type"),
      preferred_date: dateInput.value,
      preferred_time: radio("preferred_time"),
      message: form.message.value.trim(),
      privacy_consent: form.privacy_consent.checked,
      website: form.website.value
    };

    if (!data.name) return showError("성함을 입력해 주세요.");
    if (!/^01[0-9]-?\d{3,4}-?\d{4}$/.test(data.phone)) return showError("휴대폰 번호를 정확히 입력해 주세요.");
    if (!data.visit_type) return showError("진료 구분을 선택해 주세요.");
    if (!data.preferred_date || data.preferred_date < today) return showError("희망 날짜를 선택해 주세요.");
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
        if (!res.ok) throw new Error(res.status);
        card.classList.add("is-done");
        card.scrollIntoView({ behavior: "smooth", block: "start" });
      })
      .catch(function () {
        showError("일시적인 오류로 접수되지 않았습니다. 잠시 후 다시 시도해 주시거나 전화로 문의해 주세요.");
        submit.disabled = false;
        submit.textContent = "예약 신청하기";
      });
  });
});
