// Two-step offer form. No backend yet: point submit() at a form service or CRM webhook to go live.
(function () {
  const form = document.getElementById("offer-form");
  const steps = form.querySelectorAll(".step");
  const dots = form.querySelectorAll(".steps-indicator span");

  function show(n) {
    steps.forEach((s) => (s.hidden = s.dataset.step !== String(n)));
    dots.forEach((d, i) => d.classList.toggle("on", i < n));
    form.querySelector(".steps-indicator").hidden = n > 2;
    const first = form.querySelector(`[data-step="${n}"] input, [data-step="${n}"] a`);
    if (first) first.focus({ preventScroll: true });
  }

  function valid(step) {
    let ok = true;
    step.querySelectorAll("input[required]").forEach((el) => {
      const bad = !el.checkValidity() || (el.type === "tel" && el.value.replace(/\D/g, "").length < 10);
      el.classList.toggle("invalid", bad);
      el.setAttribute("aria-invalid", bad);
      if (bad && ok) { el.focus(); ok = false; }
    });
    return ok;
  }

  form.querySelector("[data-next]").addEventListener("click", () => {
    if (valid(form.querySelector('[data-step="1"]'))) show(2);
  });
  form.querySelector("[data-back]").addEventListener("click", () => show(1));
  form.addEventListener("input", (e) => e.target.classList.remove("invalid"));
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !form.querySelector('[data-step="1"]').hidden) {
      e.preventDefault();
      form.querySelector("[data-next]").click();
    }
  });

  // Format phone as (773) 555-0100 while typing.
  const phone = form.elements.phone;
  phone.addEventListener("input", () => {
    const d = phone.value.replace(/\D/g, "").slice(0, 10);
    phone.value = d.length > 6 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
      : d.length > 3 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : d;
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!valid(form.querySelector('[data-step="2"]'))) return;
    const lead = Object.fromEntries(new FormData(form));
    console.info("Lead (demo, not sent):", lead);
    show(3);
  });

  document.getElementById("yr").textContent = new Date().getFullYear();
})();
