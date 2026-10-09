/*
 * Page motion for the bttrfly Studio landing page and its pricing page.
 * - The header highlight slides to the link under the pointer and rests on the section in view
 *   (on the pricing page it rests on Pricing).
 * - Links within the page move the visitor behind a curtain when the trip crosses the film
 *   (scrubbing the whole film past in a second looks broken) or is long, and with a short
 *   eased scroll otherwise.
 * - Links to the other page, and out to Studio (sign in, claim), close the curtain before the
 *   browser leaves.
 * - The sections after the film rise into view as they arrive.
 * - The offer pop-up shows once a visit, never by itself over the film: the first time a
 *   "Get started" button (data-offer) is clicked, in place of leaving, or shortly after
 *   arriving on the pricing page. A link to #offer opens it any time. While it's open the
 *   film hears no gestures.
 * While it moves the visitor it sets "is-jumping" on <html>, which film.js respects.
 */
(() => {
  const root = document.documentElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const film = document.getElementById("film");
  const curtain = document.getElementById("curtain");
  const label = curtain && curtain.querySelector("span");
  const pills = document.querySelector(".nav-pills");
  const glow = pills && pills.querySelector(".nav-glow");
  const links = pills ? Array.from(pills.querySelectorAll("a.text")) : [];
  const onPricing = !!document.querySelector("[data-page='pricing']");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Header highlight. A link marked as the current page keeps it; otherwise it follows the
  // section in view.
  const pinned = links.find((a) => a.getAttribute("aria-current") === "page") || null;
  let active = pinned;
  let hovering = null;
  const place = (a) => {
    if (!glow) return;
    if (!a) { glow.style.opacity = "0"; return; }
    glow.style.width = a.offsetWidth + "px";
    glow.style.transform = "translateX(" + a.offsetLeft + "px)";
    glow.style.opacity = "1";
  };
  links.forEach((a) => {
    a.addEventListener("pointerenter", () => { hovering = a; place(a); });
    a.addEventListener("focus", () => place(a));
    a.addEventListener("blur", () => place(hovering || active));
  });
  if (pills) pills.addEventListener("pointerleave", () => { hovering = null; place(active); });

  const samePath = (url) => url.origin === location.origin && url.pathname === location.pathname && url.search === location.search;
  const targets = links.map((a) => {
    const url = new URL(a.getAttribute("href"), location.href);
    return samePath(url) && url.hash ? document.getElementById(url.hash.slice(1)) : null;
  });
  const updateActive = () => {
    if (pinned) return;
    const line = window.innerHeight * 0.4;
    let found = null;
    targets.forEach((section, i) => {
      if (!section) return;
      const r = section.getBoundingClientRect();
      if (r.top <= line && r.bottom > line) found = links[i];
    });
    if (found === active) return;
    if (active) active.classList.remove("active");
    active = found;
    if (active) active.classList.add("active");
    if (!hovering) place(active);
  };
  let queued = false;
  window.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; updateActive(); });
  }, { passive: true });
  window.addEventListener("resize", () => place(hovering || active));
  if (pinned) {
    place(pinned);
    // The link widths change once the web font arrives.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => place(hovering || active));
  }
  updateActive();

  // Curtain
  const cover = async (text) => {
    label.textContent = text || "";
    curtain.classList.remove("lift");
    curtain.classList.add("on");
    await wait(440);
  };
  const reset = () => {
    curtain.classList.add("instant");
    curtain.classList.remove("on", "lift");
    void curtain.offsetWidth; // apply the reset before transitions come back
    curtain.classList.remove("instant");
  };
  const uncover = async () => {
    curtain.classList.add("lift");
    await wait(580);
    reset();
  };

  const inFilm = (y) => {
    if (!film || !film.classList.contains("live")) return false;
    return y < film.offsetTop + film.offsetHeight - window.innerHeight - 1;
  };
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const scrollToY = (y, ms) => new Promise((resolve) => {
    const from = window.scrollY, start = performance.now();
    const step = (t) => {
      const x = ms > 0 ? Math.min(1, (t - start) / ms) : 1;
      window.scrollTo(0, from + (y - from) * easeInOut(x));
      if (x < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });

  let busy = false;
  const goTo = async (el, hash) => {
    if (busy) return;
    busy = true;
    root.classList.add("is-jumping");
    const y = el ? Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY)) : 0;
    const far = Math.abs(y - window.scrollY) > window.innerHeight * 1.6;
    if (hash !== location.hash) history.pushState(null, "", hash || location.pathname + location.search);
    if (reduced || !curtain) {
      window.scrollTo(0, y);
    } else if (inFilm(window.scrollY) || inFilm(y) || far) {
      await cover("");
      window.scrollTo(0, y);
      await wait(80);
      await uncover();
    } else {
      await scrollToY(y, 700);
    }
    root.classList.remove("is-jumping");
    busy = false;
  };

  const leave = async (href, text) => {
    root.classList.add("is-jumping");
    await cover(text);
    window.location.href = href;
    // If the browser didn't leave (a blocked or cancelled navigation), give the page back.
    setTimeout(() => { reset(); root.classList.remove("is-jumping"); }, 4000);
  };
  // Coming back with the Back button restores this page from memory, curtain and all.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && curtain) { reset(); root.classList.remove("is-jumping"); }
  });

  // Offer pop-up
  const offer = document.getElementById("offer");
  const canOffer = !!(offer && typeof offer.showModal === "function");
  const SEEN = "bttrfly-offer-seen";
  const offerSeen = () => { try { return sessionStorage.getItem(SEEN) === "1"; } catch (e) { return false; } };
  const markOfferSeen = () => { try { sessionStorage.setItem(SEEN, "1"); } catch (e) { /* storage blocked */ } };
  let leaving = 0;
  const showOffer = () => {
    if (!canOffer || offer.open) return;
    markOfferSeen();
    clearTimeout(leaving);
    offer.classList.remove("leaving");
    offer.showModal();
  };
  const closeOffer = (now) => {
    if (!canOffer || !offer.open) return;
    clearTimeout(leaving);
    if (now || reduced) { offer.close(); return; }
    offer.classList.add("leaving");
    leaving = setTimeout(() => offer.close(), 200);
  };
  if (canOffer) {
    offer.querySelector(".offer-close").addEventListener("click", () => closeOffer());
    // A click beside the card lands on the dialog itself.
    offer.addEventListener("click", (e) => { if (e.target === offer) closeOffer(); });
    // Escape. Chrome sometimes makes this event uncancelable, and then the dialog just closes.
    offer.addEventListener("cancel", (e) => { if (e.cancelable) { e.preventDefault(); closeOffer(); } });
    offer.addEventListener("close", () => { clearTimeout(leaving); offer.classList.remove("leaving"); });

    const copy = offer.querySelector(".offer-copy");
    const code = offer.querySelector(".offer-code code");
    const copyLabel = copy.textContent;
    let copyReset = 0;
    copy.addEventListener("click", async () => {
      const text = code.textContent.trim();
      let done = false;
      try { await navigator.clipboard.writeText(text); done = true; } catch (e) { /* no clipboard access here */ }
      if (!done) {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        try { done = document.execCommand("copy"); } catch (e) { /* leave it selected */ }
      }
      copy.textContent = done ? "Copied" : "Selected";
      clearTimeout(copyReset);
      copyReset = setTimeout(() => { copy.textContent = copyLabel; }, 2400);
    });

    // While it's open, gestures reach neither the film (these capture listeners run before
    // film.js's) nor the page behind; the dialog itself scrolls only if it's taller than the
    // screen.
    const still = (e) => {
      if (!offer.open) return;
      e.stopImmediatePropagation();
      if (e.cancelable && offer.scrollHeight <= offer.clientHeight + 1) e.preventDefault();
    };
    window.addEventListener("wheel", still, { capture: true, passive: false });
    window.addEventListener("touchmove", still, { capture: true, passive: false });
    window.addEventListener("keydown", (e) => {
      if (!offer.open) return;
      e.stopImmediatePropagation();
      const scrollKey = /^(?: |PageDown|PageUp|ArrowDown|ArrowUp|Home|End)$/.test(e.key);
      if (scrollKey && !(e.target.closest && e.target.closest("button")) && offer.scrollHeight <= offer.clientHeight + 1) e.preventDefault();
    }, true);

    if (location.hash === "#offer") showOffer();
    // On the pricing page, once the plans have had a moment on screen.
    else if (onPricing && !offerSeen()) setTimeout(() => { if (!offerSeen()) showOffer(); }, 1400);
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const url = new URL(a.getAttribute("href"), location.href);
    const samePage = samePath(url);
    const inOffer = canOffer && offer.open && offer.contains(a);
    if (samePage && url.hash === "#offer" && canOffer) {
      e.preventDefault();
      showOffer();
      return;
    }
    // The first "Get started" of a visit shows the offer instead; its own button carries on.
    if (a.hasAttribute("data-offer") && canOffer && !offerSeen()) {
      e.preventDefault();
      showOffer();
      return;
    }
    // "View pricing" from the pop-up on the pricing page itself just puts it away.
    if (inOffer && samePage && !url.hash) {
      e.preventDefault();
      closeOffer();
      return;
    }
    // The pop-up sits above everything, the curtain included, so it goes first.
    if (inOffer) closeOffer(true);
    if (samePage) {
      if (!url.hash) {
        e.preventDefault();
        goTo(null, "");
        return;
      }
      const el = document.getElementById(decodeURIComponent(url.hash.slice(1)));
      if (!el) return;
      e.preventDefault();
      goTo(el, url.hash);
    } else if (/^https?:$/.test(url.protocol) && curtain && !reduced) {
      e.preventDefault();
      leave(url.href, /(^|\.)bttrfly\.studio$/.test(url.hostname) ? "Opening bttrfly Studio" : "");
    }
  });

  // Sections rise into view, each group in turn
  if (!reduced && "IntersectionObserver" in window) {
    const picks = Array.from(document.querySelectorAll(
      ".section .eyebrow, .section h1, .section h2, .section .lead, .step, .plan, .plans-note, .studio-shot, .feature-list li, .features-more, .faq details, .closing .mark, .closing p, .closing .actions"
    ));
    picks.forEach((el) => {
      const siblings = Array.from(el.parentElement.children).filter((c) => picks.includes(c));
      el.style.setProperty("--i", String(siblings.indexOf(el)));
      el.classList.add("reveal");
    });
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        seen.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -10% 0px" });
    picks.forEach((el) => seen.observe(el));
  }
})();
