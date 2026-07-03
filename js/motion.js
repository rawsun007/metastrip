/* MetaStrip — scroll reveals, smooth FAQ accordion. Respects prefers-reduced-motion. */

(function () {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ----- Scroll reveals ----- */
  const targets = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("in-view"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
    );
    targets.forEach((el) => io.observe(el));
  }

  /* ----- Smooth FAQ accordion ----- */
  if (reduced) return; // native instant toggle is the accessible default

  const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

  function expand(item, answer) {
    item.dataset.busy = "1";
    item.open = true;
    const h = answer.scrollHeight;
    const anim = answer.animate(
      [{ height: "0px", opacity: 0 }, { height: h + "px", opacity: 1 }],
      { duration: 400, easing: EASE }
    );
    anim.onfinish = () => delete item.dataset.busy;
  }

  function collapse(item, answer) {
    item.dataset.busy = "1";
    const h = answer.scrollHeight;
    const anim = answer.animate(
      [{ height: h + "px", opacity: 1 }, { height: "0px", opacity: 0 }],
      { duration: 320, easing: EASE }
    );
    anim.onfinish = () => {
      item.open = false;
      delete item.dataset.busy;
    };
  }

  document.querySelectorAll(".faq__item").forEach((item) => {
    const summary = item.querySelector("summary");
    const answer = item.querySelector(".faq__answer");
    if (!summary || !answer) return;
    summary.addEventListener("click", (e) => {
      e.preventDefault();
      if (item.dataset.busy) return;
      if (item.open) {
        collapse(item, answer);
      } else {
        document.querySelectorAll(".faq__item[open]").forEach((other) => {
          const otherAnswer = other.querySelector(".faq__answer");
          if (other !== item && otherAnswer && !other.dataset.busy) collapse(other, otherAnswer);
        });
        expand(item, answer);
      }
    });
  });
})();
