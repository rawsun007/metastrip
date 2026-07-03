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

  /* ----- Smooth FAQ accordion -----
     Animates the whole <details> box height so open and close both
     glide, and siblings below slide along with it. */
  if (reduced) return; // native instant toggle stays for reduced motion

  const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
  const accordions = [];

  class Accordion {
    constructor(el) {
      this.el = el;
      this.summary = el.querySelector("summary");
      this.content = el.querySelector(".faq__answer");
      this.animation = null;
      this.isClosing = false;
      this.isExpanding = false;
      this.summary.addEventListener("click", (e) => this.onClick(e));
    }

    chromeHeight() {
      const cs = getComputedStyle(this.el);
      return (
        parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
        parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
      );
    }

    onClick(e) {
      e.preventDefault();
      this.el.style.overflow = "hidden";
      if (this.isClosing || !this.el.open) {
        accordions.forEach((a) => {
          if (a !== this && a.el.open && !a.isClosing) a.shrink();
        });
        this.open();
      } else if (this.isExpanding || this.el.open) {
        this.shrink();
      }
    }

    shrink() {
      this.isClosing = true;
      this.el.style.overflow = "hidden";
      const startHeight = `${this.el.offsetHeight}px`;
      const endHeight = `${this.summary.offsetHeight + this.chromeHeight()}px`;
      if (this.animation) this.animation.cancel();
      this.animation = this.el.animate(
        { height: [startHeight, endHeight] },
        { duration: 320, easing: EASE }
      );
      this.animation.onfinish = () => this.onAnimationFinish(false);
      this.animation.oncancel = () => (this.isClosing = false);
    }

    open() {
      this.el.style.height = `${this.el.offsetHeight}px`;
      this.el.open = true;
      requestAnimationFrame(() => this.expand());
    }

    expand() {
      this.isExpanding = true;
      const startHeight = `${this.el.offsetHeight}px`;
      const endHeight = `${this.summary.offsetHeight + this.content.offsetHeight + this.chromeHeight()}px`;
      if (this.animation) this.animation.cancel();
      this.animation = this.el.animate(
        { height: [startHeight, endHeight] },
        { duration: 400, easing: EASE }
      );
      this.animation.onfinish = () => this.onAnimationFinish(true);
      this.animation.oncancel = () => (this.isExpanding = false);
    }

    onAnimationFinish(open) {
      this.el.open = open;
      this.animation = null;
      this.isClosing = false;
      this.isExpanding = false;
      this.el.style.height = "";
      this.el.style.overflow = "";
    }
  }

  document.querySelectorAll(".faq__item").forEach((el) => accordions.push(new Accordion(el)));
})();
