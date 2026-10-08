/*
 * Scroll-driven film for the bttrfly Studio landing page.
 *
 * The film is a chain of camera moves between "stops" (the neighbourhood, then each
 * business). Scrolling drives the current move's playback position; at every stop the
 * picture holds still while that stop's card is on screen. Each move is its own short
 * MP4 with a keyframe every few frames, fetched whole as a Blob so seeking is instant.
 * The videos are shown directly (the browser composites them on the GPU); a still of
 * the nearest stop covers any move that has not finished downloading yet.
 *
 * Config comes from assets/film/film-config.js (written by tools/build_film.py):
 *   window.BTTRFLY_FILM = { moves: [{ d: "film/move-0-d.mp4", m: "...-m.mp4", dur: 5.04 }, ...],
 *                           stops: [{ d: "film/stop-0-d.jpg", m: "..." }, ...] }
 */
(() => {
  const cfg = window.BTTRFLY_FILM;
  const section = document.getElementById("film");
  if (!cfg || !section) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  if (reduced || saveData) return; // the static layout in site.css stays

  const base = (document.currentScript && document.currentScript.src.replace(/film\.js(\?.*)?$/, "")) || "assets/";
  const holder = document.getElementById("film-videos");
  const poster = document.getElementById("film-poster");
  const bar = document.getElementById("film-bar");
  const hint = document.getElementById("film-hint");
  const cards = Array.from(section.querySelectorAll(".fcard[data-stop]"));

  // Pick the sharpest version this browser and screen can use: 1440p HEVC for large
  // high-density screens that decode HEVC (Safari, Chrome on Mac, iPhone), 1080p H.264
  // everywhere else; phones get a portrait crop.
  const probe = document.createElement("video");
  const hevc = !!probe.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"') || !!probe.canPlayType('video/mp4; codecs="hvc1"');
  const portrait = window.innerWidth / window.innerHeight < 0.8;
  const dense = Math.max(window.screen.width, window.screen.height) * (window.devicePixelRatio || 1) >= 2400;
  const order = portrait ? (hevc ? ["mh", "m"] : ["m"]) : (hevc && dense ? ["h", "d"] : ["d"]);
  const choices = (entry) => order.filter((key) => entry[key]).map((key) => base + entry[key]);

  // Fetch a clip whole (so seeking never waits on the network) into a video element,
  // falling back to the next version if this browser turns out not to play the first.
  const fetchInto = (v, urls) => {
    const attempt = (i) => {
      if (i >= urls.length) return;
      const retry = () => attempt(i + 1);
      v.addEventListener("error", retry, { once: true });
      v.addEventListener("loadeddata", () => v.removeEventListener("error", retry), { once: true });
      fetch(urls[i])
        .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
        .then((blob) => { v.src = URL.createObjectURL(blob); })
        .catch(() => { v.src = urls[i]; });
    };
    attempt(0);
  };
  const variant = portrait ? "m" : "d"; // stills

  // Scroll lengths, in viewport heights, and how closely the film follows the scroll
  // (seconds to close most of the gap). The finale's hold is short so that leaving the film
  // for the sections doesn't scroll through dead space.
  const HOLD_FIRST = 0.55, HOLD = 0.75, HOLD_LAST = 0.45, PER_SECOND = 0.2, FOLLOW = 0.055;
  const CONCURRENT = 3;

  const pieces = [];
  let length = 0;
  const addHold = (stop, w) => { pieces.push({ kind: "hold", stop, a: length, b: length + w }); length += w; };
  const addMove = (k) => { const w = cfg.moves[k].dur * PER_SECOND; pieces.push({ kind: "move", k, a: length, b: length + w }); length += w; };
  addHold(0, HOLD_FIRST);
  cfg.moves.forEach((_, k) => { addMove(k); addHold(k + 1, k === cfg.moves.length - 1 ? HOLD_LAST : HOLD); });
  const holds = new Map(pieces.filter((p) => p.kind === "hold").map((p) => [p.stop, p]));

  section.classList.add("live");
  if (portrait) poster.src = base + cfg.stops[0].m;

  // A page opened in a background tab can report a zero-height viewport at first.
  const viewportHeight = () => window.innerHeight || document.documentElement.clientHeight || 0;
  let vh = viewportHeight();
  let vw = window.innerWidth;
  const layout = () => {
    vh = viewportHeight();
    if (vh > 0) section.style.height = Math.round((length + 1) * vh) + "px";
  };
  layout();

  // One video element per move, stacked; only the active one is visible.
  let touched = false;
  const prime = (v) => { v.play().then(() => v.pause()).catch(() => {}); };
  const vids = cfg.moves.map(() => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.disablePictureInPicture = true;
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    holder.appendChild(v);
    return v;
  });
  const state = cfg.moves.map(() => ({ ready: false, loading: false, seeking: false, want: 0 }));

  // Each stop keeps living while the visitor rests there: either one seamless loop that
  // starts and ends on the stop's own frame, or a few clips that run into one another in
  // turn (each ends on the frame the next starts on, the last on the stop's frame), so a
  // busy scene doesn't visibly repeat every few seconds.
  const idles = (cfg.loops || []).map((entry) => {
    if (!entry) return null;
    const entries = Array.isArray(entry) ? entry : [entry];
    const clips = entries.map((e) => {
      const v = document.createElement("video");
      v.muted = true;
      v.loop = entries.length === 1;
      v.playsInline = true;
      v.preload = "auto";
      v.disablePictureInPicture = true;
      v.setAttribute("muted", "");
      v.setAttribute("playsinline", "");
      v.className = "loop";
      holder.appendChild(v);
      return { entry: e, v, ready: false };
    });
    return { clips, at: 0, loading: false };
  });
  const idleReady = (idle) => idle.clips.every((c) => c.ready);
  let loopStop = -1;
  // Hand over to the next clip in a single frame; it was parked on its first frame, which
  // matches the last frame of the clip that just ended.
  const nextClip = (idle) => {
    const from = idle.clips[idle.at];
    idle.at = (idle.at + 1) % idle.clips.length;
    const to = idle.clips[idle.at];
    to.v.classList.add("cut", "on");
    from.v.classList.add("cut");
    from.v.classList.remove("on");
    to.v.play().catch(() => {});
    requestAnimationFrame(() => { to.v.classList.remove("cut"); from.v.classList.remove("cut"); });
    const after = idle.clips[(idle.at + 1) % idle.clips.length];
    if (after !== to) after.v.currentTime = 0;
  };
  const loadLoop = (stop) => {
    const idle = idles[stop];
    if (!idle || idle.loading) return;
    idle.loading = true;
    idle.clips.forEach((c, i) => {
      c.v.addEventListener("loadeddata", () => { c.ready = true; }, { once: true });
      if (idle.clips.length > 1) c.v.addEventListener("ended", () => { if (idles[loopStop] === idle && idle.at === i) nextClip(idle); });
      fetchInto(c.v, choices(c.entry));
    });
  };
  const startLoop = (stop) => {
    if (loopStop === stop) return;
    stopLoop();
    const idle = idles[stop];
    if (!idle || !idleReady(idle)) return;
    idle.at = 0;
    const first = idle.clips[0];
    first.v.currentTime = 0; // its first frame is the frame the camera just stopped on
    first.v.play().catch(() => {});
    first.v.classList.add("on");
    if (idle.clips.length > 1) idle.clips[1].v.currentTime = 0;
    loopStop = stop;
  };
  const stopLoop = () => {
    if (loopStop < 0) return;
    const idle = idles[loopStop];
    idle.clips.forEach((c) => c.v.classList.remove("on"));
    setTimeout(() => idle.clips.forEach((c) => { if (!c.v.classList.contains("on")) c.v.pause(); }), 400);
    loopStop = -1;
  };

  let activeK = 0;
  let visibleK = -1;
  let stillStop = 0;
  let playing = -1; // the move a forward flight is playing as video, or -1

  const showVideo = (k) => {
    if (visibleK === k) return;
    vids.forEach((v, i) => v.classList.toggle("on", i === k));
    visibleK = k;
    poster.classList.add("gone");
  };
  const showStill = (stop) => {
    if (stillStop !== stop) {
      poster.src = base + cfg.stops[stop][variant];
      stillStop = stop;
    }
    poster.classList.remove("gone");
    visibleK = -1; // so the next ready video takes over from the still
  };

  const settle = (k) => {
    if (k === playing) return; // a forward flight is playing it; leave it be
    const st = state[k], v = vids[k];
    if (Math.abs(v.currentTime - st.want) > 0.012) {
      st.seeking = true;
      v.currentTime = st.want;
    } else if (k === activeK) {
      showVideo(k);
    }
  };

  const load = (k) => {
    const st = state[k], v = vids[k];
    st.loading = true;
    v.addEventListener("loadeddata", () => {
      st.ready = true;
      if (touched) prime(v);
      pump();
      settle(k);
    }, { once: true });
    v.addEventListener("seeked", () => {
      st.seeking = false;
      settle(k); // the scroll may have moved on while this seek ran
    });
    fetchInto(v, choices(cfg.moves[k]));
  };

  // Keep a few downloads going, nearest to where the visitor is first.
  const pump = () => {
    const order = state.map((_, k) => k).sort((a, b) => Math.abs(a - activeK) - Math.abs(b - activeK) || a - b);
    for (const k of order) {
      if (state.filter((s) => s.loading && !s.ready).length >= CONCURRENT) return;
      if (!state[k].loading) load(k);
    }
  };

  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const position = () => (vh > 0 ? Math.min(length, Math.max(0, -section.getBoundingClientRect().top / vh)) : 0);
  const resolve = (p) => {
    for (const piece of pieces) if (p <= piece.b) return piece;
    return pieces[pieces.length - 1];
  };

  let shown = position();
  let last = performance.now();
  let warmed = 0;

  const frame = (now) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    const target = position();
    shown += (target - shown) * (1 - Math.exp(-dt / FOLLOW));
    // A flight already moves the page smoothly, so the film tracks it exactly.
    if (flight || !Number.isFinite(shown) || Math.abs(target - shown) < 0.0005) shown = target;

    const piece = resolve(shown);
    if (playing >= 0) {
      // A forward flight is playing this move as video: nothing to seek, just show it.
      if (playing !== activeK) { activeK = playing; pump(); }
      loadLoop(playing + 1);
      stopLoop();
      showVideo(playing);
    } else {
      let k, t;
      if (piece.kind === "move") {
        k = piece.k;
        t = ((shown - piece.a) / (piece.b - piece.a)) * cfg.moves[k].dur;
      } else if (piece.stop === 0) {
        k = 0; t = 0;
      } else {
        k = piece.stop - 1; t = cfg.moves[k].dur;
      }
      t = Math.max(0, Math.min(cfg.moves[k].dur - 0.05, t));
      if (k !== activeK) { activeK = k; pump(); }
      loadLoop(k);
      loadLoop(k + 1);

      const st = state[k];
      st.want = t;
      const resting = piece.kind === "hold" && Math.abs(target - shown) < 0.02;
      if (resting && st.ready && visibleK === k) startLoop(piece.stop);
      else if (piece.kind !== "hold") stopLoop();
      if (st.ready) {
        if (!st.seeking) settle(k);
      } else {
        const stop = piece.kind === "hold" ? piece.stop : (t < cfg.moves[k].dur / 2 ? k : k + 1);
        showStill(stop);
      }
      // Browsers put a paused video's decoder to sleep after a while, which would stall the
      // start of the next flight; while the visitor rests on a stop, keep the next move awake
      // on its first frame.
      const next = piece.kind === "hold" ? piece.stop : -1;
      if (resting && next > 0 && next < vids.length && state[next].ready && !state[next].seeking && now - warmed > 3000) {
        warmed = now;
        state[next].want = 0;
        vids[next].currentTime = 0;
      }
    }

    // Cards: each one lives on its stop's hold, easing in and out around it.
    for (const card of cards) {
      const stop = Number(card.dataset.stop);
      const h = holds.get(stop);
      if (!h) continue;
      const inn = stop === 0 ? 1 : smooth(h.a - 0.4, h.a + 0.08, shown);
      const out = stop === cfg.stops.length - 1 ? 1 : 1 - smooth(h.b - 0.08, h.b + 0.4, shown);
      const o = Math.min(inn, out);
      card.style.opacity = o.toFixed(3);
      card.style.visibility = o < 0.01 ? "hidden" : "visible";
      card.style.pointerEvents = o > 0.6 ? "auto" : "none";
      card.style.translate = "0 " + ((1 - o) * 18).toFixed(1) + "px";
    }
    bar.style.width = ((shown / length) * 100).toFixed(2) + "%";
    if (hint) hint.style.opacity = (1 - smooth(0.02, 0.2, shown)).toFixed(3);

    requestAnimationFrame(frame);
  };

  // Inside the film, scrolling doesn't drag the camera frame by frame. A scroll gesture
  // (wheel, trackpad, swipe or key) starts the flight to the next stop, or back to the
  // previous one, and the flight plays through at an even pace, so the picture is always
  // either moving smoothly or resting on a stop. A new gesture during a flight queues the
  // next one, and one the other way turns back. Past the finale the page scrolls on into the
  // sections as usual. Anything else that leaves the page between two stops (dragging the
  // scrollbar, a restored scroll position) flies on to the nearest stop once it settles.
  // A page transition (site.js) sets "is-jumping" on <html> while it moves the visitor, and
  // while a pop-up (a modal <dialog>) is open the film takes no gestures.
  const FRESH_MS = 140; // a pause this long between wheel events starts a new gesture
  const IDLE_MS = 160;
  const lastStop = cfg.moves.length;
  const jumping = () => document.documentElement.classList.contains("is-jumping");
  const paused = () => jumping() || !!document.querySelector("dialog[open]");
  // Where the page rests on each stop: the top for the opening, otherwise inside its hold.
  const restAt = (stop) => {
    const h = holds.get(stop);
    if (stop === 0) return 0;
    return stop === lastStop ? h.a + 0.15 : (h.a + h.b) / 2;
  };
  // Inside the film (not yet scrolled on past the finale into the sections).
  const inside = () => vh > 0 && -section.getBoundingClientRect().top / vh < restAt(lastStop) + 0.02;
  // The stop a gesture this way heads for, or -1 for none (up from the opening, or down
  // from the finale, which leaves the film for the page).
  const nextStop = (dir) => {
    const p = position();
    const piece = resolve(p);
    if (piece.kind === "move") return dir > 0 ? piece.k + 1 : piece.k;
    const here = piece.stop, rest = restAt(here);
    if (dir > 0) return p < rest - 0.01 ? here : here < lastStop ? here + 1 : -1;
    return p > rest + 0.01 ? here : here > 0 ? here - 1 : -1;
  };

  // Forward flights play the move as video, which every browser draws smoothly, and the
  // page's scroll position follows the video so the cards and the progress bar keep up.
  // Where people are on screen the film keeps its own speed: the first second leaving a stop
  // and the last two arriving at the next play in real time. Only the stretch in between,
  // mostly the camera travelling over the neighbourhood, speeds up, smoothly and by about
  // three times at most. Flights backwards (and any whose video hasn't loaded yet) scrub the
  // video on their own timeline instead, briskly, since footage running backwards looks odd
  // at its own pace; the bits of hold at either end, where the camera stands still, pass in
  // a blink.
  const DEPART = 0.8, ARRIVE = 2, EASE = 0.8; // seconds of footage
  const cruise = (k) => {
    const middle = Math.max(0, cfg.moves[k].dur - DEPART - ARRIVE);
    return Math.min(3.2, Math.max(1.2, middle / (1.2 + middle * 0.12)));
  };
  // Real time for DEPART seconds, easing up to cruise, then easing back down so the last
  // ARRIVE seconds are real time again.
  const paceAt = (k, t) => {
    const dur = cfg.moves[k].dur;
    const up = smooth(DEPART, DEPART + EASE, t), down = 1 - smooth(dur - ARRIVE - EASE, dur - ARRIVE, t);
    return 1 + (cruise(k) - 1) * Math.min(up, down);
  };
  const scrubSeconds = (k) => Math.min(3, Math.max(1.2, 0.45 + cfg.moves[k].dur * 0.22));
  const HOLD_SECONDS = 0.06; // per viewport height of hold
  const BOOST_FADE = 0.4; // seconds for a burst of extra speed to die away
  const movePieces = new Map(pieces.filter((piece) => piece.kind === "move").map((piece) => [piece.k, piece]));
  // Soft ends: it sets off at about three quarters speed rather than from a standstill.
  const ease = (x) => x - (Math.sin(2 * Math.PI * x) / (2 * Math.PI)) * 0.3;
  let flight = null, raf = 0;
  let lastP = position(), dir = 1;
  const along = (f, x) => {
    let t = ease(x) * f.total;
    for (const seg of f.segs) {
      if (t <= seg.secs) return seg.from + (seg.to - seg.from) * (seg.secs ? t / seg.secs : 1);
      t -= seg.secs;
    }
    return f.to;
  };
  const setRate = (v, rate) => { try { v.playbackRate = rate; } catch (e) { /* out of this browser's range */ } };
  const landed = () => {
    flight = null;
    raf = 0;
    lastP = position();
  };
  const step = (t) => {
    const f = flight;
    if (!f || jumping()) {
      if (f && f.video) { f.video.pause(); playing = -1; }
      flight = null; raf = 0;
      return;
    }
    const dt = Math.min(0.05, Math.max(0, (t - f.last) / 1000));
    f.last = t;
    f.boost *= Math.exp(-dt / BOOST_FADE);
    if (f.video) {
      const v = f.video, piece = movePieces.get(f.k), dur = cfg.moves[f.k].dur;
      const done = v.ended || v.currentTime >= dur - 0.04;
      if (!done) {
        const rate = paceAt(f.k, v.currentTime) * (1 + f.boost);
        if (Math.abs(v.playbackRate - rate) > 0.04) setRate(v, rate);
      }
      window.scrollTo(0, section.offsetTop + (done ? f.to : piece.a + (v.currentTime / dur) * (piece.b - piece.a)) * vh);
      if (!done) { raf = requestAnimationFrame(step); return; }
      v.pause();
      playing = -1;
      landed();
      return;
    }
    f.x = Math.min(1, f.x + (dt / f.total) * (1 + f.boost));
    window.scrollTo(0, section.offsetTop + along(f, f.x) * vh);
    if (f.x < 1) { raf = requestAnimationFrame(step); return; }
    landed();
  };
  const playTo = (stop) => {
    const k = stop - 1, v = vids[k], piece = movePieces.get(k), dur = cfg.moves[k].dur;
    const p = position();
    const from = p > piece.a ? ((p - piece.a) / (piece.b - piece.a)) * dur : 0;
    state[k].want = from;
    if (Math.abs(v.currentTime - from) > 0.04) v.currentTime = from;
    const f = { video: v, k, to: restAt(stop), back: k, dir: 1, last: performance.now(), boost: 0 };
    setRate(v, paceAt(k, from));
    flight = f;
    playing = k;
    const started = v.play();
    // If the browser won't play it (iOS Low Power Mode, say), scrub from now on.
    if (started) started.catch(() => { canPlay = false; if (flight === f) { playing = -1; flight = null; flyTo(stop); } });
    if (!raf) raf = requestAnimationFrame(step);
  };
  let canPlay = true;
  const flyTo = (stop) => {
    if (flight && flight.video) { flight.video.pause(); playing = -1; }
    const from = position(), to = restAt(stop);
    if (Math.abs(to - from) < 0.002) { flight = null; return; }
    const k = stop - 1;
    if (canPlay && to > from && k >= 0 && state[k].ready && from >= holds.get(k).a - 1e-6) return playTo(stop);
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const segs = [];
    for (const piece of pieces) {
      const a = Math.max(lo, piece.a), b = Math.min(hi, piece.b);
      if (b - a < 1e-6) continue;
      const secs = piece.kind === "move" ? ((b - a) / (piece.b - piece.a)) * scrubSeconds(piece.k) : (b - a) * HOLD_SECONDS;
      segs.push(to > from ? { from: a, to: b, secs } : { from: b, to: a, secs });
    }
    if (to < from) segs.reverse();
    const back = to > from ? stop - 1 : stop < lastStop ? stop + 1 : -1; // the stop it set off from
    flight = { segs, total: segs.reduce((n, seg) => n + seg.secs, 0), to, back, dir: to > from ? 1 : -1, last: performance.now(), x: 0, boost: 0 };
    if (!raf) raf = requestAnimationFrame(step);
  };
  const go = (d) => {
    const stop = nextStop(d);
    if (stop >= 0) flyTo(stop);
  };
  const turnBack = () => { if (flight && flight.back >= 0) flyTo(flight.back); };
  // One gesture, one flight, always to the next stop. A new gesture the same way during a
  // flight speeds it up for a moment (scrolling works as a throttle), one the other way turns
  // back, and the rest of the gesture that started it (trackpad momentum) is ignored.
  const steer = (d, fresh) => {
    if (flight) {
      if (!fresh) return;
      if (d !== flight.dir) turnBack(); else flight.boost = Math.min(3, flight.boost + 1.5);
      return;
    }
    if (fresh) go(d);
  };

  let lastWheel = 0, wheelUsed = false;
  window.addEventListener("wheel", (e) => {
    if (e.ctrlKey || paused()) return; // ctrl+wheel is pinch zoom
    const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * vh : e.deltaY;
    if (!dy) return;
    const now = performance.now();
    if (now - lastWheel > FRESH_MS) wheelUsed = false;
    lastWheel = now;
    if (!inside()) return;
    const d = dy > 0 ? 1 : -1;
    // A new gesture down from the finale carries on into the page; the momentum of the one
    // that flew there doesn't.
    if (!flight && d > 0 && nextStop(1) < 0 && !wheelUsed) return;
    e.preventDefault();
    steer(d, !wheelUsed);
    wheelUsed = true;
  }, { passive: false });

  let touchY = null, touchUsed = false, touchNative = false;
  window.addEventListener("touchstart", (e) => {
    touchY = e.touches.length === 1 ? e.touches[0].clientY : null;
    touchUsed = false;
    touchNative = false;
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (touchY === null || touchNative || paused()) return;
    const dy = touchY - e.touches[0].clientY;
    if (!dy) return;
    const d = dy > 0 ? 1 : -1;
    if (!inside() || (!flight && !touchUsed && d > 0 && nextStop(1) < 0)) { touchNative = true; return; }
    e.preventDefault();
    if (touchUsed || Math.abs(dy) < 18) return;
    touchUsed = true;
    steer(d, true);
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || paused() || !inside()) return;
    if (e.target.closest && e.target.closest("input, textarea, select, button, [contenteditable]")) return;
    const d = e.key === "ArrowDown" || e.key === "PageDown" || (e.key === " " && !e.shiftKey) ? 1
      : e.key === "ArrowUp" || e.key === "PageUp" || (e.key === " " && e.shiftKey) ? -1 : 0;
    if (!d || (!flight && d > 0 && nextStop(1) < 0)) return;
    e.preventDefault();
    steer(d, !e.repeat);
  });

  // Anything else that moves the page (the scrollbar, a restored position): once it settles
  // between two stops, fly on in the direction it was going.
  let idle = 0, held = false;
  const settleBetween = () => {
    if (held || flight || paused() || !inside()) return;
    if (resolve(position()).kind === "move") go(dir);
  };
  window.addEventListener("scroll", () => {
    if (flight) return;
    const p = position();
    if (Math.abs(p - lastP) > 0.002) dir = p > lastP ? 1 : -1;
    lastP = p;
    clearTimeout(idle);
    idle = setTimeout(settleBetween, IDLE_MS);
  }, { passive: true });
  window.addEventListener("mousedown", () => { held = true; }, { passive: true });
  window.addEventListener("mouseup", () => {
    held = false;
    clearTimeout(idle);
    idle = setTimeout(settleBetween, IDLE_MS);
  }, { passive: true });

  window.addEventListener("resize", () => {
    // Phone toolbars resize the viewport while scrolling; only relayout on real changes.
    if (window.innerWidth !== vw || Math.abs(viewportHeight() - vh) > 140) {
      vw = window.innerWidth;
      layout();
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && vh <= 0) layout(); });
  // iOS paints a paused inline video's frames only after it has played once.
  window.addEventListener("touchstart", () => {
    touched = true;
    vids.forEach((v, i) => { if (state[i].ready) prime(v); });
    idles.forEach((idle) => idle && idle.clips.forEach((c) => { if (c.ready && !c.v.classList.contains("on")) prime(c.v); }));
  }, { once: true, passive: true });

  pump();
  requestAnimationFrame(frame);
})();
