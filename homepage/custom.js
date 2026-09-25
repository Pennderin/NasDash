/* NasDash custom.js — dashboard add-ons for Homepage
 *
 *  1. Audiobookshelf player: lives on the right half of the (full-width)
 *     Audiobookshelf card — book switcher, chapters, volume, speed.
 *  2. Spotify: now-playing + transport, volume and device picker on the
 *     left; a scrollable browser (recent / playlists / top artists / queue)
 *     on the right.
 *
 * All traffic goes through the media-bridge container (:7792), which holds
 * the ABS API key and the Spotify tokens. Nothing secret lives in this file.
 *
 * Homepage renders services client-side and re-renders widgets on refresh,
 * so each module re-mounts its UI from in-memory state whenever its node
 * disappears. The ABS <audio> element lives in JS memory, not the DOM, so
 * re-renders never interrupt playback.
 */
(() => {
  'use strict';
  if (window.__ndAddons) return;            // guard against double-load
  window.__ndAddons = true;

  const BRIDGE = 'http://192.168.0.190:7792';

  // ─── shared helpers ───────────────────────────────────────────────────────
  const api = async (path, opts = {}) => {
    const r = await fetch(BRIDGE + path, {
      ...opts,
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const e = new Error(body.error || `bridge ${r.status}`); e.status = r.status; throw e;
    }
    return r.json();
  };
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

  const fmt = s => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
             : `${m}:${String(sec).padStart(2, '0')}`;
  };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const barFrac = (e, el) => { const r = el.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };

  // One DOM observer for all modules. Uses a timer rather than
  // requestAnimationFrame: rAF is paused while the window isn't being
  // painted (e.g. NasDash behind other windows), which left cards unmounted.
  const injectors = [];
  let pending = false;
  const runInjectors = () => { pending = false; injectors.forEach(fn => { try { fn(); } catch (e) { console.error('[nd]', e); } }); };
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(runInjectors, 30);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(runInjectors, 2000);   // safety net: re-mount if anything slipped

  // Mount `root` as the last child of the named service card (Homepage's
  // widget content renders after us, so keep re-appending to stay last).
  function mount(name, root, hostClass) {
    const card = document.querySelector(`li.service[data-name="${name}"] .service-card`);
    if (!card) return null;
    if (!card.contains(root) || card.lastElementChild !== root) card.appendChild(root);
    card.classList.add('nd-host', hostClass);
    return card;
  }

  // Stop add-on clicks from reaching Homepage's card handlers.
  const isolate = el => {
    el.addEventListener('pointerdown', e => e.stopPropagation());
    el.addEventListener('mousedown', e => e.stopPropagation());
  };

  // ═══ 1. Audiobookshelf ════════════════════════════════════════════════════
  (() => {
    const SYNC_MS = 15000, SKIP_S = 30;
    const SPEEDS = [1, 1.1, 1.2, 1.25, 1.5, 1.75, 2];

    const audio = new Audio();
    audio.preload = 'none';
    // volume applied once state exists (below)

    const st = {
      books: [], book: null, session: null, trackIdx: 0,
      pendingSeek: null, listened: 0, lastTick: 0, busy: false, error: '',
      speed: parseFloat(localStorage.getItem('ndAbsSpeed')) || 1,
      volume: (() => { const v = parseFloat(localStorage.getItem('ndAbsVol')); return isNaN(v) ? 1 : Math.min(1, Math.max(0, v)); })(),
      showVol: false, draggingVol: false,
    };

    const cleanTitle = t => String(t || '').replace(/\s*\((un)?abridged\)\s*$/i, '');
    const duration = () => st.session?.duration || st.book?.duration || 0;
    const playing = () => !audio.paused && !audio.ended;

    const globalTime = () => {
      if (!st.session) return st.book?.currentTime || 0;
      if (st.pendingSeek != null) return st.pendingSeek;
      const t = st.session.tracks[st.trackIdx];
      return (t ? t.startOffset : 0) + (audio.currentTime || 0);
    };

    const chapterAt = t => {
      const ch = st.session?.chapters || [];
      for (let i = ch.length - 1; i >= 0; i--) if (t >= ch[i].start) return { ...ch[i], index: i };
      return null;
    };

    // ── data ──
    async function loadBooks() {
      try {
        const { books } = await api('/abs/in-progress');
        st.books = books;
        // Keep the selected book unless it vanished; otherwise take the newest.
        if (!st.book || !books.some(b => b.id === st.book.id)) {
          if (!st.session) st.book = books[0] || null;
        } else if (!st.session) {
          st.book = books.find(b => b.id === st.book.id);   // fresh saved position
        }
        st.error = books.length ? '' : 'Nothing in progress';
      } catch { st.error = 'media-bridge unreachable'; }
      render();
    }
    loadBooks();
    setInterval(() => { if (!playing()) loadBooks(); }, 60000);

    // ── playback ──
    async function openSession() {
      const s = await api(`/abs/play/${st.book.id}`, { method: 'POST' });
      st.session = s;
      st.listened = 0;
      seekTo(s.currentTime || 0);
      updateMediaSession();
    }

    function seekTo(t) {
      const s = st.session;
      if (!s) return;
      t = Math.max(0, Math.min(t, s.duration - 1));
      let idx = s.tracks.findIndex(tr => t >= tr.startOffset && t < tr.startOffset + tr.duration);
      if (idx < 0) idx = s.tracks.length - 1;
      const tr = s.tracks[idx];
      if (idx !== st.trackIdx || !audio.src) {
        st.trackIdx = idx;
        st.pendingSeek = t;
        audio.src = BRIDGE + tr.url;
        audio.load();
      } else {
        audio.currentTime = t - tr.startOffset;
      }
      renderProgress();
    }

    audio.addEventListener('loadedmetadata', () => {
      if (st.pendingSeek != null) {
        audio.currentTime = st.pendingSeek - st.session.tracks[st.trackIdx].startOffset;
        st.pendingSeek = null;
      }
      audio.playbackRate = st.speed;
    });

    audio.addEventListener('ended', () => {
      const s = st.session;
      if (s && st.trackIdx < s.tracks.length - 1) {
        seekTo(s.tracks[st.trackIdx + 1].startOffset);
        audio.play().catch(() => {});
      } else {
        sync(true);
      }
    });

    async function togglePlay() {
      if (st.busy) return;
      st.error = '';
      try {
        if (playing()) { audio.pause(); return; }
        st.busy = true; render();
        if (!st.book) await loadBooks();
        if (!st.book) return;
        if (!st.session) await openSession();
        await audio.play();
      } catch (e) {
        st.error = 'Playback failed — is media-bridge up?';
        console.error('[nd-abs]', e);
      } finally {
        st.busy = false; render();
      }
    }

    async function switchBook(id) {
      if (st.book?.id === id) return;
      const wasPlaying = playing();
      if (st.session) {
        audio.pause();
        await sync(true);
        st.session = null;
        audio.removeAttribute('src'); audio.load();
      }
      st.book = st.books.find(b => b.id === id) || st.book;
      render();
      if (wasPlaying) togglePlay();
    }

    const skip = d => { if (st.session) seekTo(globalTime() + d); };

    function jumpChapter(dir) {
      const ch = st.session?.chapters || [];
      if (!ch.length) return;
      const t = globalTime(), cur = chapterAt(t), i = cur ? cur.index : 0;
      const target = dir < 0 ? (t - (cur?.start || 0) > 3 ? i : i - 1) : i + 1;
      if (target >= 0 && target < ch.length) seekTo(ch[target].start + 0.01);
    }

    function cycleSpeed() {
      st.speed = SPEEDS[(SPEEDS.indexOf(st.speed) + 1) % SPEEDS.length];
      audio.playbackRate = st.speed;
      localStorage.setItem('ndAbsSpeed', String(st.speed));
      render();
    }

    function setVolume(v, persist) {
      st.volume = Math.min(1, Math.max(0, v));
      audio.volume = st.volume;
      if (persist) localStorage.setItem('ndAbsVol', String(st.volume));
      const pct = Math.round(st.volume * 100) + '%';
      const lbl = root.querySelector('.nd-abs-volpill'), out = root.querySelector('.nd-abs-volval');
      if (lbl) lbl.innerHTML = '&#128266; ' + pct + ' &#9662;';
      if (out) out.textContent = pct;
    }

    // ── progress sync ──
    audio.addEventListener('play',  () => { st.lastTick = performance.now(); render(); });
    audio.addEventListener('pause', () => { tick(); sync(false); render(); });
    audio.addEventListener('timeupdate', () => {
      tick();
      renderProgress();
    });

    function tick() {
      if (!st.lastTick) return;
      const now = performance.now();
      if (playing()) st.listened += Math.min(5, (now - st.lastTick) / 1000);
      st.lastTick = now;
    }

    async function sync(close) {
      if (!st.session) return;
      const body = JSON.stringify({ currentTime: globalTime(), timeListened: st.listened, duration: duration() });
      st.listened = 0;
      try {
        await api(`/abs/${close ? 'close' : 'sync'}/${st.session.sessionId}`, { method: 'POST', body });
      } catch (e) {
        if (!close && (e.status === 410 || e.status === 404)) {
          const t = globalTime(), wasPlaying = playing();
          st.session = null;
          try { await openSession(); seekTo(t); if (wasPlaying) audio.play().catch(() => {}); } catch {}
        }
      }
    }

    setInterval(() => { if (playing()) sync(false); }, SYNC_MS);

    window.addEventListener('pagehide', () => {
      if (!st.session) return;
      tick();
      const body = JSON.stringify({ currentTime: globalTime(), timeListened: st.listened, duration: duration() });
      navigator.sendBeacon(`${BRIDGE}/abs/close/${st.session.sessionId}`, new Blob([body], { type: 'text/plain' }));
    });

    // ── OS media keys ──
    function updateMediaSession() {
      if (!('mediaSession' in navigator) || !st.session) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: cleanTitle(st.session.title),
        artist: st.session.author || '',
        album: st.book?.series || '',
        artwork: [{ src: BRIDGE + st.session.cover, sizes: '300x300', type: 'image/webp' }],
      });
      const ms = navigator.mediaSession;
      ms.setActionHandler('play',          () => togglePlay());
      ms.setActionHandler('pause',         () => audio.pause());
      ms.setActionHandler('seekbackward',  () => skip(-SKIP_S));
      ms.setActionHandler('seekforward',   () => skip(SKIP_S));
      ms.setActionHandler('previoustrack', () => jumpChapter(-1));
      ms.setActionHandler('nexttrack',     () => jumpChapter(1));
    }

    // ── UI ──
    const root = document.createElement('div');
    root.className = 'nd-abs';
    isolate(root);
    root.addEventListener('click', e => {
      e.stopPropagation();
      const el = e.target.closest('[data-act]');
      if (!el) return;
      e.preventDefault();
      const a = el.dataset.act;
      if (a === 'play')  togglePlay();
      else if (a === 'back')  skip(-SKIP_S);
      else if (a === 'fwd')   skip(SKIP_S);
      else if (a === 'prev')  jumpChapter(-1);
      else if (a === 'next')  jumpChapter(1);
      else if (a === 'speed') cycleSpeed();
      else if (a === 'vol')   { st.showVol = !st.showVol; render(); }
      else if (a === 'book')  switchBook(el.dataset.id);
      else if (a === 'bar') {
        const f = barFrac(e, el);
        if (!st.session) return;
        const ch = chapterAt(globalTime());
        seekTo(ch ? ch.start + f * (ch.end - ch.start) : f * duration());
      }
    });

    // Book shelf sits in the card's left column, under the stats.
    const shelf = document.createElement('div');
    shelf.className = 'nd-abs-shelf';
    isolate(shelf);
    shelf.addEventListener('click', e => {
      e.stopPropagation();
      const el = e.target.closest('[data-act="book"]');
      if (el) { e.preventDefault(); switchBook(el.dataset.id); }
    });

    audio.volume = st.volume;
    root.addEventListener('input', e => {
      if (!e.target.matches('.nd-abs-vol')) return;
      st.draggingVol = true;
      setVolume(e.target.value / 100, false);       // live
    });
    root.addEventListener('change', e => {
      if (!e.target.matches('.nd-abs-vol')) return;
      st.draggingVol = false;
      setVolume(e.target.value / 100, true);        // remember
    });
    document.addEventListener('pointerdown', () => { if (st.showVol) { st.showVol = false; render(); } });

    let card = null;
    injectors.push(() => {
      const c = mount('Audiobookshelf', root, 'nd-abs-host');
      if (c && !c.contains(shelf)) c.insertBefore(shelf, root);
      if (c && c !== card) { card = c; render(); }
    });

    function render() {
      if (st.draggingVol) return;
      const b = st.book, isPlaying = playing();
      const others = st.books.filter(x => x.id !== b?.id);
      root.innerHTML = `
        <div class="nd-abs-main">
          ${b ? `<img class="nd-abs-cover" src="${BRIDGE + b.cover}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'nd-abs-cover nocover',textContent:'\u{1F4D6}'}))">` : '<div class="nd-abs-cover"></div>'}
          <div class="nd-abs-body">
            <div class="nd-abs-top">
              <div class="nd-abs-meta">
                <div class="nd-abs-title" title="${esc(b?.title)}">${esc(cleanTitle(b?.title) || st.error || 'Loading…')}</div>
                <div class="nd-abs-sub">${esc(b?.author || '')}${b?.series ? ` · <span class="nd-abs-series">${esc(b.series)}</span>` : ''}</div>
                <div class="nd-abs-chapter"></div>
              </div>
              <div class="nd-abs-opts">
                <button data-act="vol" class="nd-abs-volpill ${st.showVol ? 'on' : ''}" title="Volume">&#128266; ${Math.round(st.volume * 100)}% &#9662;</button>
              </div>
            </div>
            <div class="nd-bar nd-abs-bar" data-act="bar"><div class="nd-fill"></div></div>
            <div class="nd-times"><span class="nd-abs-t-cur"></span><span class="nd-abs-t-total"></span></div>
            <div class="nd-ctrls">
              <button data-act="prev" title="Previous chapter">&#9198;</button>
              <button data-act="back" title="Back ${SKIP_S}s">&#8634;<small>${SKIP_S}</small></button>
              <button data-act="play" class="nd-main" title="Play/Pause">${st.busy ? '&#8230;' : (isPlaying ? '&#9208;' : '&#9654;')}</button>
              <button data-act="fwd"  title="Forward ${SKIP_S}s"><small>${SKIP_S}</small>&#8635;</button>
              <button data-act="next" title="Next chapter">&#9197;</button>
              <button data-act="speed" class="nd-abs-speed" title="Playback speed">${st.speed}×</button>
            </div>
          </div>
        </div>
        ${st.showVol ? `<div class="nd-sp-pop nd-abs-pop"><div class="nd-sp-volrow">&#128264;<input type="range" class="nd-sp-vol nd-abs-vol" min="0" max="100" value="${Math.round(st.volume * 100)}"><b class="nd-abs-volval">${Math.round(st.volume * 100)}%</b></div></div>` : ''}
        ${st.error && b ? `<div class="nd-err">${esc(st.error)}</div>` : ''}`;
      shelf.innerHTML = others.length ? `<span class="nd-abs-shelf-label">Also listening</span>` + others.map(o => `
        <button class="nd-abs-shelf-item" data-act="book" data-id="${esc(o.id)}" title="${esc(cleanTitle(o.title))} — ${Math.round(o.progress * 100)}%">
          <img src="${BRIDGE + o.cover}" alt="" onerror="this.parentElement.classList.add('nocover')"><i style="width:${Math.round(o.progress * 100)}%"></i>
        </button>`).join('') : '';
      renderProgress();
    }

    function renderProgress() {
      const fill = root.querySelector('.nd-abs-bar .nd-fill');
      if (!fill) return;
      const t = globalTime(), total = duration(), ch = chapterAt(t);
      const cur = root.querySelector('.nd-abs-t-cur'), tot = root.querySelector('.nd-abs-t-total');
      const chEl = root.querySelector('.nd-abs-chapter');
      if (ch) {
        fill.style.width = `${Math.min(100, ((t - ch.start) / (ch.end - ch.start)) * 100)}%`;
        cur.textContent = fmt(t - ch.start);
        tot.textContent = `-${fmt(ch.end - t)} · ${Math.round((t / total) * 100)}% of book`;
        chEl.textContent = ch.title;
      } else {
        fill.style.width = total ? `${(t / total) * 100}%` : '0%';
        cur.textContent = fmt(t);
        tot.textContent = total ? `${fmt(total)} · ${Math.round((t / total) * 100)}%` : '';
        chEl.textContent = st.book ? 'Press play to resume' : '';
      }
    }
  })();

  // ═══ 2. Spotify ═══════════════════════════════════════════════════════════
  // Mirrors the Audiobookshelf card: player on the right (art, title, accent
  // line, option pills, progress, centered controls); browser on the left
  // (tab chips + scrolling list) in place of ABS's "Also listening" shelf.
  (() => {
    const POLL_MS = 5000;
    const TABS = [['recent', 'Recent'], ['playlists', 'Playlists'], ['artists', 'Artists'], ['queue', 'Up next']];

    const st = {
      now: null, error: '', fetchedAt: 0, busy: false,
      tab: localStorage.getItem('ndSpTab') || 'recent',
      lists: {}, listErr: {}, listAt: {},
      devices: null, showDevices: false, draggingVol: false,
      lastTrack: null, lastRescope: undefined,
    };

    const root = document.createElement('div');   // player — right column
    root.className = 'nd-sp';
    const side = document.createElement('div');   // browser — left column
    side.className = 'nd-sp-side';
    for (const el of [root, side]) { isolate(el); el.addEventListener('click', onClick); }
    root.addEventListener('input', onVolInput);
    root.addEventListener('change', onVolChange);

    let card = null;
    // Spotify card mirrors the Audiobookshelf card: same height, kept in sync.
    let absObs = null, absWatched = null;
    function syncHeight() {
      const abs = document.querySelector('li.service[data-name="Audiobookshelf"] .service-card');
      if (!card || !abs) return;
      card.style.height = abs.getBoundingClientRect().height + 'px';
      if (abs !== absWatched) { absObs?.disconnect(); absObs = new ResizeObserver(syncHeight); absObs.observe(abs); absWatched = abs; }
    }
    injectors.push(() => {
      const c = mount('Spotify', root, 'nd-sp-host');
      if (c && !c.contains(side)) c.insertBefore(side, root);
      if (c && c !== card) { card = c; renderPlayer(); renderSide(); }
      syncHeight();
    });

    // Close the device popover on outside click.
    document.addEventListener('pointerdown', () => { if (st.showDevices) { st.showDevices = false; renderPlayer(); } });

    // ── data ──
    async function poll() {
      if (document.hidden) return;
      try {
        st.now = await api('/spotify/now');
        st.error = '';
      } catch (e) {
        st.error = e.status === 503 ? 'Spotify not configured on media-bridge' : 'media-bridge unreachable';
      }
      st.fetchedAt = Date.now();
      const key = st.now?.active ? st.now.title + '|' + st.now.artist : null;
      if (key !== st.lastTrack) { st.lastTrack = key; delete st.listAt.queue; if (st.tab === 'queue') loadList('queue'); }
      renderPlayer();
      const rs = !!st.now?.needsRescope;
      if (rs !== st.lastRescope) { st.lastRescope = rs; st.listErr = {}; st.listAt = {}; renderSide(); }
      else if (!side.dataset.ready) renderSide();
    }
    setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    poll();

    setInterval(() => { if (st.now?.active && st.now.isPlaying) renderProgress(); }, 1000);

    const liveProgress = () => {
      const n = st.now;
      if (!n?.active) return 0;
      const drift = n.isPlaying ? Date.now() - (n.at || st.fetchedAt) : 0;
      return Math.min(n.durationMs, n.progressMs + drift);
    };

    async function control(action, body) {
      if (st.busy) return;
      st.busy = true;
      if (st.now?.active && (action === 'play' || action === 'pause') && !body?.contextUri && !body?.uris) {
        st.now.progressMs = liveProgress(); st.now.at = Date.now();
        st.now.isPlaying = action === 'play';
        renderPlayer();
      }
      try {
        await post(`/spotify/${action}`, body);
        st.error = '';
      } catch (e) {
        if (e.message === 'no-computer' && action === 'play') {
          // Spotify isn't running on the PC: start it (hidden) and play there.
          launchOnPc(body);
        } else if (e.message === 'no-computer') {
          st.error = 'Spotify isn\u2019t open on your PC';
        } else {
          st.error = /PREMIUM/i.test(e.message) ? 'Spotify Premium required' : e.message.replace(/^upstream \d+ spotify \S+ ?/, '');
        }
        renderPlayer();
      } finally {
        st.busy = false;
        setTimeout(poll, 500);
      }
    }

    // Start Spotify on the PC via the Steam agent (it launches hidden, no window),
    // wait for the PC to appear as a Spotify device, then start playback on it.
    async function launchOnPc(body) {
      const giveUp = () => {
        st.notice = '';
        st.error = 'Couldn\u2019t start Spotify on your PC';
        renderPlayer();
      };
      st.notice = 'Starting Spotify on your PC\u2026'; st.error = ''; renderPlayer();
      try {
        const r = await fetch('http://192.168.0.74:7790/spotify/launch', { method: 'POST' });
        if (!r.ok) return giveUp();
      } catch { return giveUp(); }
      for (let i = 0; i < 15; i++) {
        await new Promise(res => setTimeout(res, 1000));
        let pc = null;
        try { pc = ((await api('/spotify/devices')).devices || []).find(d => d.type === 'Computer'); } catch {}
        if (pc) {
          try { await post('/spotify/play', { ...(body || {}), deviceId: pc.id }); st.notice = ''; st.error = ''; }
          catch { st.notice = ''; st.error = 'Spotify started \u2014 press play again'; }
          renderPlayer(); setTimeout(poll, 800);
          return;
        }
      }
      giveUp();
    }

    const LIST_TTL = { recent: 120000, playlists: 300000, artists: 900000, queue: 10000 };
    async function loadList(tab, force) {
      if (!force && st.listAt[tab] && Date.now() - st.listAt[tab] < LIST_TTL[tab]) return renderSide();
      const path = { recent: '/spotify/recent', playlists: '/spotify/playlists', artists: '/spotify/top', queue: '/spotify/queue' }[tab];
      try {
        st.lists[tab] = await api(path);
        st.listErr[tab] = '';
        st.listAt[tab] = Date.now();
      } catch (e) {
        st.listErr[tab] = /scope/i.test(e.message) ? 'scope' : e.message;
      }
      if (st.tab === tab) renderSide();
    }
    setInterval(() => { if (st.tab === 'queue' && st.now?.active && !document.hidden) loadList('queue', true); }, 10000);

    async function loadDevices() {
      try { st.devices = (await api('/spotify/devices')).devices; } catch { st.devices = []; }
      renderPlayer();
    }

    // ── events ──
    function onClick(e) {
      e.stopPropagation();
      const el = e.target.closest('[data-act]');
      if (!el) return;
      e.preventDefault();
      const a = el.dataset.act, n = st.now;
      if (a === 'connect')  return window.open(`${BRIDGE}/spotify/login`, '_blank');
      if (a === 'toggle')   return control(n?.isPlaying ? 'pause' : 'play');
      if (a === 'next' || a === 'prev') return control(a);
      if (a === 'shuffle')  return control('shuffle', { state: !n?.shuffle });
      if (a === 'repeat')   return control('repeat', { state: { off: 'context', context: 'track', track: 'off' }[n?.repeat || 'off'] });
      if (a === 'bar' && n?.active) return control('seek', { ms: barFrac(e, el) * n.durationMs });
      if (a === 'devices')  { st.showDevices = !st.showDevices; if (st.showDevices) loadDevices(); return renderPlayer(); }
      if (a === 'device')   { st.showDevices = false; renderPlayer(); return control('transfer', { deviceId: el.dataset.id, play: true }); }
      if (a === 'tab')      { const again = st.tab === el.dataset.tab; st.tab = el.dataset.tab; localStorage.setItem('ndSpTab', st.tab); renderSide(); return loadList(st.tab, again); }
      if (a === 'ctx')      return control('play', { contextUri: el.dataset.uri });
      if (a === 'track')    return control('play', { uris: [el.dataset.uri] });
      if (a === 'refresh')  return loadList(st.tab, true);
    }

    function onVolInput(e) {
      if (!e.target.matches('.nd-sp-vol')) return;
      st.draggingVol = true;
      const out = root.querySelector('.nd-sp-volval');
      if (out) out.textContent = e.target.value + '%';
    }
    function onVolChange(e) {
      if (!e.target.matches('.nd-sp-vol')) return;
      st.draggingVol = false;
      if (st.now?.device) st.now.device.volume = +e.target.value;
      control('volume', { percent: +e.target.value });
    }

    // ── render: player (right) ──
    function renderPlayer() {
      if (!card || st.draggingVol) return;
      const n = st.now;

      if (!n) { root.innerHTML = `<div class="nd-sp-msg">${esc(st.error || 'Loading…')}</div>`; return; }

      if (!n.connected) {
        card.classList.add('nd-sp-off');
        const exp = n.reason === 'expired';
        root.innerHTML = `
          <div class="nd-sp-connect">
            <button data-act="connect" class="nd-sp-connect-btn">${exp ? 'Reconnect Spotify' : 'Connect Spotify'}</button>
            <span class="nd-sp-hint">${exp ? 'Login expired — Spotify requires this every 6 months' : 'One-time login'}</span>
          </div>`;
        return;
      }
      card.classList.remove('nd-sp-off');

      const dev = n.device, vol = dev?.volume;
      const sub = n.active ? [n.artist, n.album].filter(Boolean).join(' · ') : 'Pick something on the left, or press play';
      const accent = st.notice ? st.notice : n.active && dev ? `${n.isPlaying ? 'Playing' : 'Paused'} on ${dev.name}` : (dev ? `Ready on ${dev.name}` : 'No active device');

      const pop = !st.showDevices ? '' : `
        <div class="nd-sp-pop">
          ${vol != null && dev?.supportsVolume ? `
            <div class="nd-sp-volrow">&#128264;<input type="range" class="nd-sp-vol" min="0" max="100" value="${vol}"><b class="nd-sp-volval">${vol}%</b></div>` : ''}
          <div class="nd-sp-pop-label">Play on</div>
          ${st.devices == null ? '<div class="nd-sp-dev dim">Looking for devices…</div>'
            : !st.devices.length ? '<div class="nd-sp-dev dim">Spotify isn\u2019t running on your PC — press play to start it</div>'
            : st.devices.map(d => `<button class="nd-sp-dev ${d.active ? 'on' : ''}" data-act="device" data-id="${esc(d.id)}">${esc(d.name)} <small>${esc(d.type)}</small></button>`).join('')}
        </div>`;

      root.innerHTML = `
        <div class="nd-sp-main">
          ${n.active && n.art ? `<img class="nd-sp-cover" src="${esc(n.art)}" alt="">` : '<div class="nd-sp-cover nd-sp-cover-empty">&#9835;</div>'}
          <div class="nd-sp-body">
            <div class="nd-sp-top">
              <div class="nd-sp-meta">
                <div class="nd-sp-title" title="${esc(n.title)}">${esc(n.active ? n.title : 'Nothing playing')}</div>
                <div class="nd-sp-sub" title="${esc(sub)}">${esc(sub)}</div>
                <div class="nd-sp-accent">${esc(accent)}</div>
              </div>
              <div class="nd-sp-opts">
                <button data-act="devices" class="${st.showDevices ? 'on' : ''}" title="Volume and device">&#128266; ${vol != null ? vol + '%' : ''} &#9662;</button>
              </div>
            </div>
            <div class="nd-bar nd-sp-bar" data-act="bar"><div class="nd-fill"></div></div>
            <div class="nd-times"><span class="nd-sp-cur"></span><span class="nd-sp-dur"></span></div>
            <div class="nd-ctrls">
              <button data-act="shuffle" class="nd-toggle ${n.shuffle ? 'on' : ''}" title="Shuffle">&#8644;</button>
              <button data-act="prev" title="Previous">&#9198;</button>
              <button data-act="toggle" class="nd-main" title="${n.isPlaying ? 'Pause' : 'Play'}">${n.isPlaying ? '&#9208;' : '&#9654;'}</button>
              <button data-act="next" title="Next">&#9197;</button>
              <button data-act="repeat" class="nd-toggle ${n.repeat && n.repeat !== 'off' ? 'on' : ''}" title="Repeat: ${esc(n.repeat || 'off')}">&#8635;${n.repeat === 'track' ? '<small>1</small>' : ''}</button>
            </div>
          </div>
        </div>
        ${pop}
        ${st.error ? `<div class="nd-err">${esc(st.error)}</div>` : ''}`;
      renderProgress();
    }

    function renderProgress() {
      const n = st.now, fill = root.querySelector('.nd-sp-bar .nd-fill');
      if (!fill) return;
      const p = liveProgress();
      fill.style.width = n?.active && n.durationMs ? `${(p / n.durationMs) * 100}%` : '0%';
      root.querySelector('.nd-sp-cur').textContent = n?.active ? fmt(p / 1000) : '';
      root.querySelector('.nd-sp-dur').textContent = n?.active ? fmt(n.durationMs / 1000) : '';
    }

    // ── render: browser (left) ──
    function item(it, act, sub) {
      return `
        <button class="nd-sp-item" data-act="${act}" data-uri="${esc(it.uri)}" title="${esc(it.name || '')}">
          ${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy">` : '<span class="nd-sp-noimg">&#9835;</span>'}
          <span class="nd-sp-item-text"><b>${esc(it.name || 'Unknown')}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
        </button>`;
    }

    function renderSide() {
      if (!card) return;
      const n = st.now;
      if (!n || !n.connected) { side.innerHTML = ''; return; }
      side.dataset.ready = '1';

      const tabs = `<div class="nd-sp-tabs">${TABS.map(([k, label]) =>
        `<button data-act="tab" data-tab="${k}" class="${st.tab === k ? 'on' : ''}">${label}</button>`).join('')}</div>`;

      let body;
      const data = st.lists[st.tab], err = st.listErr[st.tab];
      if (st.tab !== 'queue' && (n.needsRescope || err === 'scope')) {
        body = `<div class="nd-sp-msg">Spotify needs one more permission to show your library.
          <button data-act="connect" class="nd-sp-connect-btn small">Reconnect Spotify</button></div>`;
      } else if (err) {
        body = `<div class="nd-sp-msg">${esc(err)}</div>`;
      } else if (!data) {
        body = '<div class="nd-sp-msg">Loading…</div>';
        loadList(st.tab);
      } else if (st.tab === 'recent') {
        const ctx = (data.contexts || []).filter(c => c.name);
        body = (ctx.map(c => item(c, 'ctx', c.type)).join('') + (data.tracks || []).map(t => item(t, 'track', t.artist)).join(''))
               || '<div class="nd-sp-msg">No recent listening yet.</div>';
      } else if (st.tab === 'playlists') {
        body = (data.playlists || []).map(p => item(p, 'ctx', `${p.tracks != null ? p.tracks + ' tracks' : ''}`)).join('')
               || '<div class="nd-sp-msg">No playlists found.</div>';
      } else if (st.tab === 'artists') {
        body = (data.artists || []).map(a => item(a, 'ctx', 'Artist')).join('')
               || '<div class="nd-sp-msg">Not enough listening history yet.</div>';
      } else {
        body = !n.active ? '<div class="nd-sp-msg">Nothing playing.</div>'
             : (data.queue || []).map(t => item(t, 'track', t.artist)).join('') || '<div class="nd-sp-msg">Queue is empty.</div>';
      }

      const scroller = side.querySelector('.nd-sp-list');
      const keepScroll = scroller && scroller.dataset.tab === st.tab ? scroller.scrollTop : 0;
      side.innerHTML = `${tabs}<div class="nd-sp-list" data-tab="${st.tab}">${body}</div>`;
      side.querySelector('.nd-sp-list').scrollTop = keepScroll;
    }
  })();

  // ═══ 3. Systems strip (PC / NAS / JARVIS via Beszel) ══════════════════════
  (() => {
    const HUB = 'http://192.168.0.190:8093';
    const HUE = { PC: '#e3e8ef', NAS: '#e3e8ef', JARVIS: '#e3e8ef' };   // terminal steel
    const OS_ICON = { PC: 'windows-11', NAS: 'unraid', JARVIS: 'ubuntu-linux' };
    const icon = n => OS_ICON[n] ? `<img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${OS_ICON[n]}.png" alt="" onerror="this.remove()">` : '';
    const st = { systems: null, error: '' };

    const root = document.createElement('div');
    root.className = 'nd-sys';
    isolate(root);
    root.addEventListener('click', e => {
      e.stopPropagation();
      const t = e.target.closest('.nd-sys-tile'); if (!t) return;
      // The Unraid logo on the NAS tile opens the Unraid web UI.
      if (t.dataset.sys === 'NAS' && e.target.closest('.nd-sys-head img')) return window.open('http://192.168.0.190/Main', '_blank');
      // NAS / JARVIS: detail panel (module 12). PC: open Beszel.
      if (t.dataset.sys === 'NAS' || t.dataset.sys === 'JARVIS') document.dispatchEvent(new CustomEvent('nd-sys-detail', { detail: t.dataset.sys }));
      else window.open(HUB, '_blank');
    });

    // Sits at the top of Homepage's information-widgets row, above search/weather.
    let host = null;
    injectors.push(() => {
      const h = document.getElementById('information-widgets');
      if (!h) return;
      if (h.firstElementChild !== root) h.insertBefore(root, h.firstElementChild);
      if (h !== host) { host = h; render(); }
    });

    async function poll() {
      if (document.hidden) return;
      try { st.systems = (await api('/systems')).systems; st.error = ''; }
      catch { st.error = 'Stats unavailable'; }
      render();
    }
    setInterval(poll, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    poll();

    const uptime = s => {
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
      return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm';
    };

    function ring(v, hue, label) {
      const r = 17, C = 2 * Math.PI * r, val = v == null ? 0 : Math.max(0, Math.min(100, v));
      const warn = val >= 90 ? '#E24B4A' : val >= 75 ? '#EF9F27' : hue;
      return `<div class="nd-sys-ring">
        <svg viewBox="0 0 46 46" width="46" height="46">
          <circle cx="23" cy="23" r="${r}" fill="none" stroke="rgb(255 255 255 / .08)" stroke-width="5"/>
          <circle cx="23" cy="23" r="${r}" fill="none" stroke="${warn}" stroke-width="5" stroke-linecap="round"
            stroke-dasharray="${(C * val / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 23 23)"/>
          <text x="23" y="27" text-anchor="middle">${v == null ? '–' : Math.round(v) + '%'}</text>
        </svg>
        <span>${esc(label)}</span>
      </div>`;
    }

    function spark(vals, hue) {
      const pts = (vals || []).filter(v => v != null);
      if (pts.length < 2) return '<div class="nd-sys-spark nd-sys-spark-empty">collecting history…</div>';
      const max = Math.max(10, ...pts) * 1.15, W = 200, H = 24, step = W / (pts.length - 1);
      const xy = pts.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`);
      return `<svg class="nd-sys-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <polygon points="0,${H} ${xy.join(' ')} ${W},${H}" fill="${hue}" fill-opacity=".12"/>
        <polyline points="${xy.join(' ')}" fill="none" stroke="${hue}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      </svg>`;
    }

    function gpuLabel(g, all) {
      if (all.length > 1) return 'GPU' + (g.name.match(/(\d{1,2})$/)?.[1] ?? all.indexOf(g));
      return g.name.replace(/^(RTX|GTX|Tesla)\s+/i, '');
    }

    function tile(s) {
      const hue = HUE[s.name] || '#888780';
      if (s.status === 'missing') return `<div class="nd-sys-tile"><div class="nd-sys-head"><div><b>${esc(s.name)}</b><small>agent not connected</small></div><i class="nd-sys-dot down"></i></div></div>`;
      const gpus = (s.gpus || []).map(g => `
        <div class="nd-sys-gpu">
          <span class="nd-sys-gpu-l">${esc(gpuLabel(g, s.gpus))}</span>
          <span class="nd-sys-gpu-bar"><i style="width:${Math.max(2, g.util || 0)}%;background:${hue}"></i></span>
          <span class="nd-sys-gpu-v">${g.util ?? '–'}%${g.temp != null ? ' · ' + g.temp + '°' : ''}</span>
        </div>`).join('');
      const tip = s.name === 'PC' ? 'Open Beszel' : 'Show details';
      return `<div class="nd-sys-tile" data-sys="${esc(s.name)}" title="${tip}">
        <div class="nd-sys-head">
          ${icon(s.name)}<div><b>${esc(s.name)}</b><small>${esc(s.subtitle || '')}</small></div>
          <i class="nd-sys-dot ${s.status === 'up' ? '' : 'down'}"></i>
        </div>
        <div class="nd-sys-rings">${s.rings.map(r => ring(r.value, hue, r.label)).join('')}</div>
        ${gpus}
        ${spark(s.cpuHistory, hue)}
        <div class="nd-sys-foot"><span>CPU 1h</span><span>up ${uptime(s.uptime)}</span></div>
      </div>`;
    }

    function render() {
      if (!host) return;
      if (!st.systems) { root.innerHTML = `<div class="nd-sys-msg">${esc(st.error || 'Loading system stats…')}</div>`; return; }
      root.innerHTML = st.systems.map(tile).join('');
    }
  })();

  // ═══ 4. Home (Home Assistant on JARVIS) ═══════════════════════════════════
  // Compact card: four stat blocks in Homepage's own block style. A "Controls"
  // pill opens a floating panel (lights, fans, AC) over the cards below.
  // Everything goes through the bridge's allow-list; the alarm is read-only.
  (() => {
    const st = { s: null, error: '', open: false, busy: false };
    const ALARM = { disarmed: 'Disarmed', armed_home: 'Home', armed_away: 'Away', armed_night: 'Night',
                    arming: 'Arming', pending: 'Pending', triggered: 'TRIGGERED' };
    const MODE  = { off: 'Off', cool: 'Cool', heat: 'Heat', heat_cool: 'Auto', fan_only: 'Fan', dry: 'Dry' };
    const FAN_STEPS = [[0, 'Off'], [33, 'Low'], [66, 'Med'], [100, 'High']];

    const root = document.createElement('div');   // compact stats + pill (inside the card)
    root.className = 'nd-ha';
    const panel = document.createElement('div');  // floating controls
    panel.className = 'nd-ha-panel';
    for (const el of [root, panel]) { isolate(el); el.addEventListener('click', onClick); }

    let card = null;
    injectors.push(() => {
      const c = mount('Home', root, 'nd-ha-host');
      if (!c) return;
      if (st.open && !c.contains(panel)) c.appendChild(panel);
      if (c !== card) { card = c; render(); }
    });

    document.addEventListener('pointerdown', () => { if (st.open) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.open) setOpen(false); });

    async function poll() {
      if (document.hidden || st.busy) return;
      try { st.s = await api('/ha/state'); st.error = ''; }
      catch (e) { st.error = e.status === 503 ? 'Not configured' : 'Unreachable'; }
      render();
    }
    let timer = null;
    function schedule() { clearInterval(timer); timer = setInterval(poll, st.open ? 3000 : 15000); }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    poll(); schedule();

    function setOpen(v) {
      st.open = v;
      card?.classList.toggle('nd-ha-open', v);
      if (v && card && !card.contains(panel)) card.appendChild(panel);
      if (!v) panel.remove();
      schedule();
      if (v) poll();
      render();
    }

    async function send(what, body) {
      st.busy = true;
      try { await post('/ha/' + what, body); st.error = ''; }
      catch (e) { st.error = 'Command failed'; }
      finally { st.busy = false; setTimeout(poll, 600); }
    }

    function onClick(e) {
      e.stopPropagation();
      const el = e.target.closest('[data-act]');
      if (!el) return;
      e.preventDefault();
      const a = el.dataset.act, s = st.s;
      if (a === 'toggle-panel') return setOpen(!st.open);
      if (!s) return;
      if (a === 'light') {
        const l = s.lights.find(x => x.id === el.dataset.id);
        if (!l || !l.available) return;
        l.on = !l.on; s.lightsOn = s.lights.filter(x => x.on).length; render();      // optimistic
        return send('light', { id: l.id, on: l.on });
      }
      if (a === 'fan') {
        const f = s.fans.find(x => x.id === el.dataset.id), pct = +el.dataset.pct;
        if (!f) return;
        f.pct = pct; f.on = pct > 0; render();
        return send('fan', { id: f.id, pct });
      }
      if (a === 'mode' && s.ac) { s.ac.mode = el.dataset.mode; render(); return send('ac', { mode: el.dataset.mode }); }
      if ((a === 'tdown' || a === 'tup') && s.ac?.target != null) {
        const next = Math.min(s.ac.max, Math.max(s.ac.min, s.ac.target + (a === 'tup' ? 1 : -1) * s.ac.step));
        s.ac.target = next; render();
        return send('ac', { target: next });
      }
    }

    const fmtT = v => v == null ? '–' : (Math.round(v * 2) / 2) + '°';
    const fanStep = pct => FAN_STEPS.reduce((best, s) => Math.abs(s[0] - pct) < Math.abs(best[0] - pct) ? s : best)[0];

    function block(value, label, extra = '') {
      return `<div class="bg-theme-200/50 dark:bg-theme-900/20 rounded-sm m-1 flex-1 flex flex-col items-center justify-center text-center p-1 service-block ${extra}">
        <div class="font-thin text-sm">${value}</div><div class="font-bold text-xs uppercase">${label}</div></div>`;
    }

    function render() {
      if (!card) return;
      const s = st.s;
      const ac = s?.ac;
      const acVal = !ac ? '–' : ac.mode === 'off' ? 'Off' : `${MODE[ac.mode] || ac.mode}${ac.target != null ? ' ' + fmtT(ac.target) : ''}`;
      const alarm = s?.alarm ? (ALARM[s.alarm] || s.alarm) : '–';
      root.innerHTML = `
        <button class="nd-ha-pill ${st.open ? 'on' : ''}" data-act="toggle-panel" title="Home controls">Controls ${st.open ? '&#9652;' : '&#9662;'}</button>
        <div class="relative flex flex-row w-full service-container">
          ${block(s ? s.lightsOn : (st.error || '…'), 'Lights on')}
          ${block(s?.temp ? fmtT(s.temp.value) : '–', 'Bedroom')}
          ${block(esc(acVal), 'AC')}
          ${block(esc(alarm), 'Alarm', s?.alarm === 'triggered' ? 'nd-ha-alert' : (s?.alarm && s.alarm !== 'disarmed' ? 'nd-ha-armed' : ''))}
        </div>`;
      if (st.open) renderPanel();
    }

    function renderPanel() {
      const s = st.s;
      if (!s) { panel.innerHTML = `<div class="nd-ha-msg">${esc(st.error || 'Loading…')}</div>`; return; }
      const lights = s.lights.map(l => `
        <button class="nd-ha-light ${l.on ? 'on' : ''} ${l.available ? '' : 'na'}" data-act="light" data-id="${l.id}" ${l.available ? '' : 'title="Unavailable"'}>
          <span>${esc(l.name)}</span><i class="nd-ha-sw"><b></b></i>
        </button>`).join('');
      const fans = s.fans.map(f => `
        <div class="nd-ha-row"><span class="nd-ha-row-l">${esc(f.name)}</span>
          <span class="nd-ha-seg">${FAN_STEPS.map(([p, lbl]) =>
            `<button data-act="fan" data-id="${f.id}" data-pct="${p}" class="${fanStep(f.pct) === p ? 'on' : ''}">${lbl}</button>`).join('')}</span>
        </div>`).join('');
      const ac = s.ac;
      const acHtml = !ac ? '' : `
        <div class="nd-ha-sec">AC <small>room ${fmtT(ac.current)}</small></div>
        <div class="nd-ha-row">
          <span class="nd-ha-seg">${ac.modes.map(m => `<button data-act="mode" data-mode="${m}" class="${ac.mode === m ? 'on' : ''}">${MODE[m] || m}</button>`).join('')}</span>
          <span class="nd-ha-temp ${ac.mode === 'off' || ac.target == null ? 'dim' : ''}">
            <button data-act="tdown" aria-label="Lower">&#8722;</button><b>${fmtT(ac.target)}</b><button data-act="tup" aria-label="Raise">+</button>
          </span>
        </div>`;
      panel.innerHTML = `
        <div class="nd-ha-sec">Lights</div>
        <div class="nd-ha-lights">${lights}</div>
        <div class="nd-ha-sec">Fans</div>
        ${fans}
        ${acHtml}
        ${st.error ? `<div class="nd-ha-msg err">${esc(st.error)}</div>` : ''}`;
    }
  })();

  // ═══ 5. Steam (one wide card) ═════════════════════════════════════════════
  // Left: Library / Installed stats + recently-played shelf. Right: the
  // last-played (or running) game with artwork and Play, plus Friends and
  // Library pills. Library opens a floating, searchable list of all games.
  // Data: Steam agent on the PC (:7790); friends via media-bridge (Web API).
  (() => {
    const AGENT = 'http://192.168.0.74:7790';
    const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';
    const st = { d: null, error: '', friends: null, open: false, q: '', sort: localStorage.getItem('ndStSort') || 'recent' };

    const root = document.createElement('div');   // right: game panel
    root.className = 'nd-st';
    const side = document.createElement('div');   // left: stats + shelf
    side.className = 'nd-st-side';
    const pop = document.createElement('div');    // floating library
    pop.className = 'nd-st-pop';
    for (const el of [root, side, pop]) { isolate(el); el.addEventListener('click', onClick); }
    pop.addEventListener('input', e => { if (e.target.matches('.nd-st-search')) { st.q = e.target.value; renderList(); } });

    let card = null;
    injectors.push(() => {
      const c = mount('Steam', root, 'nd-st-host');
      if (!c) return;
      if (!c.contains(side)) c.insertBefore(side, root);
      if (st.open && !c.contains(pop)) c.appendChild(pop);
      if (c !== card) { card = c; render(); }
    });

    document.addEventListener('pointerdown', () => { if (st.open) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.open) setOpen(false); });

    async function poll() {
      if (document.hidden) return;
      try {
        const r = await fetch(AGENT + '/dashboard', { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        st.d = await r.json(); st.error = '';
      } catch { st.error = 'PC offline'; }
      render();
    }
    async function pollFriends() {
      if (document.hidden) return;
      try { st.friends = await api('/steam/friends'); } catch { st.friends = null; }
      renderPills();
    }
    setInterval(poll, 20000); setInterval(pollFriends, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); pollFriends(); } });
    poll(); pollFriends();

    const initials = n => String(n || '?').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
    const launch = appid => window.open('steam://rungameid/' + appid, '_blank');
    const hours = m => !m ? 'No playtime' : m < 60 ? m + 'm played' : (m / 60 >= 100 ? Math.round(m / 60) : Math.round(m / 6) / 10) + 'h played';

    function setOpen(v) {
      st.open = v;
      card?.classList.toggle('nd-st-open', v);
      if (v && card && !card.contains(pop)) card.appendChild(pop);
      if (!v) pop.remove();
      if (v) { renderPop(); fitPop(); setTimeout(() => pop.querySelector('.nd-st-search')?.focus(), 30); }
      renderPills();
    }

    function onClick(e) {
      e.stopPropagation();
      const el = e.target.closest('[data-act]');
      if (!el) return;
      e.preventDefault();
      const a = el.dataset.act;
      if (a === 'library') return setOpen(!st.open);
      if (a === 'friends') return window.open('steam://open/friends', '_blank');
      if (a === 'steam')   return window.open('steam://open/library', '_blank');
      if (a === 'play')    { launch(el.dataset.appid); if (st.open) setOpen(false); return; }
      if (a === 'sort')    { st.sort = el.dataset.sort; localStorage.setItem('ndStSort', st.sort); return renderPop(); }
    }

    function hero() {
      const d = st.d; if (!d?.games?.length) return null;
      if (d.running?.appid) return d.games.find(g => g.appid === d.running.appid) || { appid: d.running.appid, name: d.running.name || 'Running game' };
      return d.games[0];
    }

    function block(value, label, act) {
      return `<div class="bg-theme-200/50 dark:bg-theme-900/20 rounded-sm m-1 flex-1 flex flex-col items-center justify-center text-center p-1 service-block ${act ? 'nd-st-click' : ''}" ${act ? `data-act="${act}" title="Browse library"` : ''}>
        <div class="font-thin text-sm">${value}</div><div class="font-bold text-xs uppercase">${label}</div></div>`;
    }

    function renderPills() {
      const box = root.querySelector('.nd-st-opts');
      if (!box) return;
      const f = st.friends;
      const fr = !f || !f.configured ? 'Friends'
               : f.error ? 'Friends'
               : `<i class="nd-st-dot ${f.online ? 'on' : ''}"></i>${f.online} online`;
      const tip = f?.list?.length ? f.list.map(p => p.name + (p.game ? ' — ' + p.game : '')).join('\n') : 'Open Steam friends';
      box.innerHTML = `
        <button data-act="friends" title="${esc(tip)}">${fr}</button>
        <button data-act="library" class="${st.open ? 'on' : ''}" title="${st.d ? st.d.count + ' games · ' + esc(st.d.totalSizeHuman) + ' installed' : 'Browse library'}">Library ${st.open ? '&#9652;' : '&#9662;'}</button>`;
    }

    function render() {
      if (!card) return;
      const d = st.d, g = hero();
      const running = !!(d?.running && g && d.running.appid === g.appid);
      const upd = d?.updating?.[0];
      const accent = running ? '<span class="nd-st-live">&#9679; Playing now</span>'
                   : upd ? `<span class="nd-st-upd">Updating ${esc(upd.name)}${upd.progress != null ? ' · ' + upd.progress + '%' : ''}</span>`
                   : (st.error ? `<span class="nd-st-err">${esc(st.error)}</span>` : '<span class="nd-st-ready">Ready to play</span>');

      side.innerHTML = `
        ${d?.games?.length > 1 ? `<div class="nd-st-shelf">
          <span class="nd-st-shelf-label">Recently played</span>
          ${d.games.filter(x => x.appid !== g?.appid).slice(0, 5).map(x => `
            <button class="nd-st-cap" data-act="play" data-appid="${x.appid}" data-i="${esc(initials(x.name))}" title="${esc(x.name)} — ${esc(x.lastPlayedRel)}">
              <img src="${AGENT}/art/${x.appid}/capsule" alt="" loading="lazy" onerror="if(!this.dataset.f){this.dataset.f=1;this.src='${AGENT}/art/${x.appid}/header'}else{this.parentElement.classList.add('nd-st-noart');this.remove()}">
            </button>`).join('')}
        </div>` : ''}`;

      root.innerHTML = `
        <div class="nd-st-main">
          ${g ? `<img class="nd-st-art" src="${AGENT}/art/${g.appid}/header" alt="" onerror="if(!this.dataset.f){this.dataset.f=1;this.src='${CDN + g.appid}/header.jpg';return}this.replaceWith(Object.assign(document.createElement('div'),{className:'nd-st-art nd-st-noart',dataset:{}}));">` : '<div class="nd-st-art"></div>'}
          <div class="nd-st-body">
            <div class="nd-st-top">
              <div class="nd-st-meta">
                <div class="nd-st-title" title="${esc(g?.name)}">${esc(g?.name || (st.error || 'Loading…'))}</div>
                <div class="nd-st-sub">${g ? (running ? 'Running now' : 'Last played ' + esc(g.lastPlayedRel || '')) + (g.playtimeMin ? ' · ' + hours(g.playtimeMin).replace(' played', ' total') : '') : ''}</div>
                <div class="nd-st-accent">${accent}</div>
              </div>
              <div class="nd-st-opts"></div>
            </div>
            <div class="nd-st-ctrls">
              ${g ? `<button class="nd-st-play ${running ? 'running' : ''}" data-act="play" data-appid="${g.appid}">${running ? '&#9679; Running' : '&#9654; Play'}</button>` : ''}
            </div>
          </div>
        </div>`;
      renderPills();
      if (st.open) renderPop();
    }

    // Let the list use the space below the card, stopping just above the window edge.
    function fitPop() {
      requestAnimationFrame(() => {
        const list = pop.querySelector('.nd-st-list');
        if (!list) return;
        const room = window.innerHeight - list.getBoundingClientRect().top - 16;
        list.style.maxHeight = Math.max(160, room) + 'px';
      });
    }

    function renderPop() {
      const d = st.d;
      pop.innerHTML = `
        <div class="nd-st-pophead">
          <input class="nd-st-search" type="search" placeholder="Search ${d ? d.count : ''} games" value="${esc(st.q)}">
          <span class="nd-st-seg">${[['recent', 'Recent'], ['name', 'A–Z'], ['size', 'Size'], ['played', 'Most played']].map(([k, l]) =>
            `<button data-act="sort" data-sort="${k}" class="${st.sort === k ? 'on' : ''}">${l}</button>`).join('')}</span>
          <button class="nd-st-open-steam" data-act="steam" title="Open the Steam library">Open Steam</button>
        </div>
        <div class="nd-st-list"></div>`;
      renderList();
      fitPop();
    }

    function renderList() {
      const list = pop.querySelector('.nd-st-list');
      if (!list) return;
      const d = st.d;
      if (!d) { list.innerHTML = `<div class="nd-st-msg">${esc(st.error || 'Loading…')}</div>`; return; }
      const q = st.q.trim().toLowerCase();
      let games = d.games.filter(g => !q || g.name.toLowerCase().includes(q));
      const by = { recent: (a, b) => b.lastPlayed - a.lastPlayed, name: (a, b) => a.name.localeCompare(b.name),
                   size: (a, b) => b.size - a.size, played: (a, b) => b.playtimeMin - a.playtimeMin }[st.sort];
      games = games.slice().sort(by);
      list.innerHTML = games.map(g => {
        const running = d.running?.appid === g.appid;
        return `<button class="nd-st-row" data-act="play" data-appid="${g.appid}" title="Play ${esc(g.name)}">
          <span class="nd-st-rowart" data-i="${esc(initials(g.name))}"><img src="${AGENT}/art/${g.appid}/header" alt="" loading="lazy" onerror="if(!this.dataset.f){this.dataset.f=1;this.src='${CDN + g.appid}/capsule_184x69.jpg'}else{this.parentElement.classList.add('nd-st-noart');this.remove()}"></span>
          <span class="nd-st-row-t"><b>${esc(g.name)}</b>
            <small>${running ? '<em class="live">Playing now</em> · ' : g.updating ? '<em class="upd">Updating</em> · ' : ''}${esc(g.lastPlayedRel)} · ${hours(g.playtimeMin)} · ${esc(g.sizeHuman)}</small></span>
          <span class="nd-st-row-play">&#9654;</span>
        </button>`;
      }).join('') || '<div class="nd-st-msg">No games match.</div>';
    }
  })();

  // ═══ 6. Plex: who's watching (Active Streams block) ═══════════════════════
  // Hover the "Active Streams" block for a quick peek; click to pin it open.
  (() => {
    const st = { d: null, error: '', open: false, pinned: false, hoverTimer: null };
    const panel = document.createElement('div');
    panel.className = 'nd-px-panel';
    isolate(panel);
    panel.addEventListener('click', e => e.stopPropagation());
    panel.addEventListener('mouseenter', () => clearTimeout(st.hoverTimer));
    panel.addEventListener('mouseleave', () => { if (!st.pinned) scheduleClose(); });

    let card = null, block = null;
    injectors.push(() => {
      const c = document.querySelector('li.service[data-name="Plex"] .service-card');
      if (!c) return;
      const b = [...c.querySelectorAll('.service-block')].find(x => /stream/i.test(x.textContent));
      if (b && b !== block) {
        block = b;
        b.classList.add('nd-px-block');
        b.title = 'Who\u2019s watching';
        b.addEventListener('mouseenter', () => { clearTimeout(st.hoverTimer); if (!st.open) setOpen(true, false); });
        b.addEventListener('mouseleave', () => { if (!st.pinned) scheduleClose(); });
        b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); if (st.pinned) setOpen(false); else setOpen(true, true); });
        b.addEventListener('pointerdown', e => e.stopPropagation());
      }
      card = c;
      if (st.open && !c.contains(panel)) c.appendChild(panel);
      if (block) block.classList.toggle('nd-px-live', !!st.d?.streams?.some(s => s.state === 'playing'));
    });

    document.addEventListener('pointerdown', () => { if (st.open) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.open) setOpen(false); });

    function scheduleClose() { clearTimeout(st.hoverTimer); st.hoverTimer = setTimeout(() => setOpen(false), 250); }

    function setOpen(v, pin) {
      st.open = v; st.pinned = v && !!pin;
      card?.classList.toggle('nd-px-open', v);
      if (v && card && !card.contains(panel)) card.appendChild(panel);
      if (!v) panel.remove();
      if (v) { render(); poll(); }
    }

    async function poll() {
      if (document.hidden) return;
      try { st.d = await api('/plex/sessions'); st.error = ''; }
      catch (e) { st.error = e.status === 503 ? 'Plex not configured on media-bridge' : 'Plex unreachable'; }
      if (block) block.classList.toggle('nd-px-live', !!st.d?.streams?.some(s => s.state === 'playing'));
      if (st.open) render();
    }
    // Fast while open, slow in the background (just for the live dot).
    setInterval(() => { if (st.open) poll(); }, 5000);
    setInterval(() => { if (!st.open) poll(); }, 30000);
    poll();

    const mbps = k => k >= 1000 ? (k / 1000).toFixed(1) + ' Mbps' : k + ' kbps';

    function render() {
      const d = st.d;
      if (!d) { panel.innerHTML = `<div class="nd-px-msg">${esc(st.error || 'Loading…')}</div>`; return; }
      if (!d.streams.length) { panel.innerHTML = '<div class="nd-px-msg">Nobody is watching right now.</div>'; return; }
      panel.innerHTML = `
        <div class="nd-px-head"><span>// now watching</span><span>${d.streams.length} stream${d.streams.length > 1 ? 's' : ''}${d.totalBandwidthKbps ? ' · ' + mbps(d.totalBandwidthKbps) : ''}</span></div>
        ${d.streams.map(s => `
          <div class="nd-px-row">
            ${s.thumb ? `<img src="${BRIDGE + s.thumb}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<span class="nd-px-noimg">&#9654;</span>'}
            <div class="nd-px-body">
              <div class="nd-px-top">
                <b title="${esc(s.title)}">${esc(s.title)}</b>
                <span class="nd-px-state ${s.state}">${s.state === 'paused' ? '&#10074;&#10074; paused' : s.state === 'buffering' ? '&#8230; buffering' : '&#9654; playing'}</span>
              </div>
              ${s.subtitle ? `<div class="nd-px-sub" title="${esc(s.subtitle)}">${esc(s.subtitle)}</div>` : ''}
              <div class="nd-px-who">${esc(s.user)} · ${esc(s.player || s.platform)}${s.local ? '' : ' · <span class="nd-px-remote">remote</span>'}</div>
              <div class="nd-px-bar"><i style="width:${s.progress ?? 0}%"></i></div>
              <div class="nd-px-foot">
                <span>${s.remainingMin != null ? s.remainingMin + ' min left' : ''}</span>
                <span class="nd-px-dec ${s.decision === 'Transcode' ? 'tx' : ''}">${esc(s.decision)}${s.quality ? ' · ' + esc(s.quality) : ''}</span>
              </div>
            </div>
          </div>`).join('')}`;
    }
  })();

  // ═══ 7. SABnzbd: pause pill + queue panel ═════════════════════════════════
  // Title-bar pill pauses/resumes. Hover the Queue block to peek at the queue,
  // click to pin it (with timed-pause options).
  (() => {
    const st = { d: null, error: '', open: false, pinned: false, t: null, busy: false };
    const pill = document.createElement('button');
    pill.className = 'nd-ha-pill nd-sab-pill';
    const panel = document.createElement('div');
    panel.className = 'nd-px-panel nd-sab-panel';
    for (const el of [pill, panel]) { isolate(el); el.addEventListener('click', onClick); }
    panel.addEventListener('mouseenter', () => clearTimeout(st.t));
    panel.addEventListener('mouseleave', () => { if (!st.pinned) later(); });

    let card = null, block = null;
    injectors.push(() => {
      const c = document.querySelector('li.service[data-name="SABnzbd"] .service-card');
      if (!c) return;
      card = c;
      if (!c.contains(pill)) { c.classList.add('nd-ha-host'); c.appendChild(pill); renderPill(); }
      const b = [...c.querySelectorAll('.service-block')].find(x => /queue/i.test(x.textContent));
      if (b && b !== block) {
        block = b; b.classList.add('nd-px-block'); b.title = 'Download queue';
        b.addEventListener('mouseenter', () => { clearTimeout(st.t); if (!st.open) setOpen(true, false); });
        b.addEventListener('mouseleave', () => { if (!st.pinned) later(); });
        b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); st.pinned ? setOpen(false) : setOpen(true, true); });
        b.addEventListener('pointerdown', e => e.stopPropagation());
      }
      if (st.open && !c.contains(panel)) c.appendChild(panel);
    });
    document.addEventListener('pointerdown', () => { if (st.open) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.open) setOpen(false); });
    const later = () => { clearTimeout(st.t); st.t = setTimeout(() => setOpen(false), 250); };

    function setOpen(v, pin) {
      st.open = v; st.pinned = v && !!pin;
      card?.classList.toggle('nd-px-open', v);
      if (v && card && !card.contains(panel)) card.appendChild(panel);
      if (!v) panel.remove();
      if (v) { render(); poll(); }
    }

    async function poll() {
      if (document.hidden) return;
      try { st.d = await api('/sab/queue'); st.error = ''; } catch (e) { st.error = e.status === 503 ? 'SABnzbd not configured' : 'SABnzbd unreachable'; }
      renderPill(); if (st.open) render();
    }
    setInterval(() => { if (st.open) poll(); }, 3000);
    setInterval(() => { if (!st.open) poll(); }, 15000);
    poll();

    async function act(action, body) {
      if (st.busy) return; st.busy = true;
      try { await post('/sab/' + action, body); } catch { st.error = 'Command failed'; }
      finally { st.busy = false; setTimeout(poll, 400); }
    }

    function onClick(e) {
      e.stopPropagation();
      const el = e.target.closest('[data-act]'); if (!el) return;
      e.preventDefault();
      const a = el.dataset.act;
      if (a === 'toggle') return st.d?.paused ? act('resume') : act('pause');
      if (a === 'pause') return act('pause', { minutes: +el.dataset.min || 0 });
      if (a === 'resume') return act('resume');
    }

    function renderPill() {
      const p = st.d?.paused;
      pill.dataset.act = 'toggle';
      pill.classList.toggle('on', !!p);
      pill.title = p ? 'Resume downloads' : 'Pause downloads';
      pill.innerHTML = p ? '&#9654; resume' : '&#10074;&#10074; pause';
    }

    function render() {
      const d = st.d;
      if (!d) { panel.innerHTML = `<div class="nd-px-msg">${esc(st.error || 'Loading…')}</div>`; return; }
      const head = `<div class="nd-px-head"><span>// download queue${d.paused ? ' · <b class="nd-sab-paused">paused</b>' : ''}</span>
        <span>${d.total} item${d.total === 1 ? '' : 's'}${d.kbpersec ? ' · ' + (d.kbpersec >= 1024 ? (d.kbpersec / 1024).toFixed(1) + ' MB/s' : Math.round(d.kbpersec) + ' KB/s') : ''}${d.mbleft ? ' · ' + (d.mbleft >= 1024 ? (d.mbleft / 1024).toFixed(1) + ' GB' : Math.round(d.mbleft) + ' MB') + ' left' : ''}</span></div>`;
      const ctrls = `<div class="nd-sab-ctrls">${d.paused
        ? '<button data-act="resume" class="primary">&#9654; resume</button>'
        : '<span>pause for</span><button data-act="pause" data-min="30">30m</button><button data-act="pause" data-min="60">1h</button><button data-act="pause" data-min="180">3h</button><button data-act="pause" data-min="0">until resumed</button>'}</div>`;
      const items = d.items.length ? d.items.map(x => `
        <div class="nd-sab-row">
          <div class="nd-px-top"><b title="${esc(x.name)}">${esc(x.name)}</b><span class="nd-px-state">${esc(x.status === 'Downloading' ? x.pct + '%' : x.status.toLowerCase())}</span></div>
          <div class="nd-px-bar"><i style="width:${x.pct}%"></i></div>
          <div class="nd-px-foot"><span>${esc(x.cat && x.cat !== '*' ? x.cat : '')}${x.mb ? ' · ' + (x.mb >= 1024 ? (x.mb / 1024).toFixed(1) + ' GB' : Math.round(x.mb) + ' MB') : ''}</span><span>${esc(x.timeleft || '')}</span></div>
        </div>`).join('') : '<div class="nd-px-msg">Queue is empty.</div>';
      panel.innerHTML = head + ctrls + items + (st.error ? `<div class="nd-px-msg" style="color:#f87171">${esc(st.error)}</div>` : '');
    }
  })();

  // ═══ 8. Seerr: title-bar search (and no Pending block) ═════════════════════
  // Type a title, press Enter: Seerr opens in the browser with that search.
  (() => {
    const SEERR = 'http://192.168.0.190:5055';
    const box = document.createElement('form');
    box.className = 'nd-seerr-search';
    box.innerHTML = '<input type="search" placeholder="search seerr…" aria-label="Search Seerr" spellcheck="false"><button type="submit" aria-label="Search">&#8981;</button>';
    isolate(box);
    box.addEventListener('click', e => e.stopPropagation());
    box.addEventListener('keydown', e => e.stopPropagation());
    box.addEventListener('submit', e => {
      e.preventDefault(); e.stopPropagation();
      const input = box.querySelector('input'), q = input.value.trim();
      if (!q) return input.focus();
      window.open(SEERR + '/search?query=' + encodeURIComponent(q), '_blank');
      input.value = ''; input.blur();
    });
    injectors.push(() => {
      const c = document.querySelector('li.service[data-name="Seerr"] .service-card');
      if (!c) return;
      if (!c.contains(box)) { c.classList.add('nd-ha-host'); c.appendChild(box); }
      // Seerr is just a title bar with the search box: hide its stat row entirely
      const sc = c.querySelector('.service-container'); if (sc) sc.style.display = 'none';
    });
  })();

  // ═══ 9. Security: Ring camera buttons ═════════════════════════════════════
  // One button per camera (status dot: green online / red offline; pulses on
  // motion). Click → live window for that camera. Title pill → all cameras.
  // In NasDash these open as their own draggable windows (see main.js).
  (() => {
    const st = { cams: null, error: '' };
    const root = document.createElement('div');
    root.className = 'nd-sec';
    const pill = document.createElement('button');
    pill.className = 'nd-ha-pill nd-sec-all';
    pill.title = 'All cameras in one window';
    pill.innerHTML = '&#9638; all';
    for (const el of [root, pill]) { isolate(el); el.addEventListener('click', onClick); }
    pill.dataset.act = 'all';

    const CAM_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="2" y="6" width="14" height="12" rx="2" fill="currentColor"/><path d="M16 10.5 22 7v10l-6-3.5z" fill="currentColor"/></svg>';

    let card = null;
    injectors.push(() => {
      const c = mount('Security', root, 'nd-ha-host');
      if (!c) return;
      if (!c.contains(pill)) c.appendChild(pill);
      if (c !== card) { card = c; render(); }
    });

    async function poll() {
      if (document.hidden) return;
      try { st.cams = (await api('/ring/cameras')).cameras; st.error = ''; }
      catch (e) { st.error = e.status === 503 ? 'Not configured' : 'Unreachable'; }
      render();
    }
    setInterval(poll, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    poll();

    function onClick(e) {
      e.stopPropagation();
      const el = e.target.closest('[data-act]'); if (!el) return;
      e.preventDefault();
      if (el.dataset.act === 'all') return window.open(BRIDGE + '/cams', '_blank');
      if (el.dataset.act === 'cam') return window.open(BRIDGE + '/cams?src=' + encodeURIComponent(el.dataset.id), '_blank');
    }

    function render() {
      if (!card) return;
      if (!st.cams) { root.innerHTML = `<div class="nd-sec-msg">${esc(st.error || 'Loading cameras…')}</div>`; return; }
      root.innerHTML = st.cams.map(c => `
        <button class="nd-sec-cam ${c.online ? '' : 'off'} ${c.motion ? 'motion' : ''}" data-act="cam" data-id="${esc(c.id)}"
                title="${esc(c.name)} — ${c.online ? (c.motion ? 'motion now' : 'online') : 'offline'}">
          ${CAM_SVG}<span>${esc(c.name)}</span><i class="nd-sec-dot"></i>
        </button>`).join('');
    }
  })();


  // ═══ 10. Services: terminal-style table (arr stack + tools) ═══════════════
  // service · status · wanted · missing · queued · library. Apps without those
  // numbers show a one-line summary instead. Click a row to open the app.
  (() => {
    const st = { list: null, error: '' };
    const root = document.createElement('div');
    root.className = 'nd-svc';
    isolate(root);
    root.addEventListener('click', e => {
      e.stopPropagation();
      const el = e.target.closest('[data-url]'); if (!el) return;
      e.preventDefault(); window.open(el.dataset.url, '_blank');
    });
    let card = null;
    injectors.push(() => { const c = mount('Services', root, 'nd-host'); if (c && c !== card) { card = c; render(); } });
    async function poll() {
      if (document.hidden) return;
      try { st.list = (await api('/services/status')).services; st.error = ''; } catch { st.error = 'status unavailable'; }
      render();
    }
    setInterval(poll, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    poll();

    const n = v => v == null ? '<span class="dim">-</span>' : Number(v).toLocaleString();
    const warn = v => v ? `<span class="warn">${n(v)}</span>` : n(v);
    const blue = v => v ? `<span class="blue">${n(v)}</span>` : n(v);

    function cells(s) {
      const x = s.stats;
      if (!s.online) return '<td colspan="4" class="dim">not responding</td>';
      if (s.id === 'radarr' && x) return `<td>${n(x.wanted)}</td><td>${warn(x.missing)}</td><td>${blue(x.queued)}</td><td>${n(x.library)}</td>`;
      if (s.id === 'sonarr' && x) return `<td>${n(x.wanted)}</td><td><span class="dim">-</span></td><td>${blue(x.queued)}</td><td>${n(x.library)}</td>`;
      if (s.id === 'bazarr' && x) return `<td colspan="4">${warn(x.subsEpisodes)} eps · ${warn(x.subsMovies)} movies need subs</td>`;
      if (s.id === 'prowlarr' && x) return `<td colspan="4">${n(x.indexers)} indexers · ${x.failing ? `<span class="bad">${x.failing} failing</span>` : '0 failing'}</td>`;
      if (s.id === 'hunterr') return `<td colspan="4">torznab proxy · ${s.ms ?? '?'} ms</td>`;
      return '<td colspan="4" class="dim">-</td>';
    }

    function render() {
      if (!card) return;
      if (!st.list) { root.innerHTML = `<div class="nd-sec-msg">${esc(st.error || 'checking services…')}</div>`; return; }
      root.innerHTML = `<table class="nd-svc-t">
        <thead><tr><th>service</th><th>status</th><th>wanted</th><th>missing</th><th>queued</th><th>library</th></tr></thead>
        <tbody>${st.list.map(s => `
          <tr data-url="${esc(s.url)}" title="Open ${esc(s.name)}">
            <td class="name">${esc(s.id)}</td>
            <td class="${s.online ? 'up' : 'down'}">${s.online ? 'up' : 'down'}</td>
            ${cells(s)}
          </tr>`).join('')}</tbody></table>`;
    }
  })();

  // ═══ 10b. Claude Door toggle (far right of the Services title) ════════════
  // Green = claude-door running, red = stopped. Click to flip it; while Docker
  // works the dot pulses amber with "starting…"/"stopping…" and further
  // clicks are ignored. Goes through media-bridge -> door-toggle sidecar.
  (() => {
    const ICON = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/claude-ai.svg';
    const TIMEOUT_MS = 45000;
    const st = { s: null, pending: null, since: 0, err: '' };
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nd-door unk';
    btn.innerHTML = `<span class="nd-door-lbl"></span><span class="nd-door-ico"><img src="${ICON}" alt="Claude Door"><i class="nd-door-dot"></i></span>`;
    isolate(btn);
    const lbl = btn.querySelector('.nd-door-lbl');

    btn.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      if (st.pending || !st.s || st.s.busy || st.s.state === 'missing') return;
      const action = st.s.running ? 'stop' : 'start';
      st.pending = action; st.since = Date.now(); st.err = ''; render();
      try { st.s = await post('/door/' + action); }
      catch (x) { st.pending = null; st.err = x.message; render(); return; }
      fastPoll();
    });

    injectors.push(() => {
      const t = document.querySelector('li.service[data-name="Services"] .service-title');
      if (t && btn.parentElement !== t) t.appendChild(btn);
    });

    async function poll() {
      try { st.s = await api('/door/status'); if (!st.pending) st.err = st.s.error || ''; }
      catch (x) { st.s = null; st.err = x.message; }
      if (st.pending && st.s && !st.s.busy) {
        if (st.s.error) { st.err = st.s.error; st.pending = null; }
        else if (st.s.running === (st.pending === 'start')) st.pending = null;
      }
      if (st.pending && Date.now() - st.since > TIMEOUT_MS) { st.err = `${st.pending} is taking too long`; st.pending = null; }
      render();
    }
    let fast = null;
    function fastPoll() {
      clearInterval(fast);
      fast = setInterval(async () => { await poll(); if (!st.pending) { clearInterval(fast); fast = null; } }, 1000);
    }
    setInterval(() => { if (!document.hidden && !fast) poll(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    poll();

    function render() {
      const s = st.s;
      let cls, tip, text = '';
      if (st.pending || s?.busy) {
        const a = st.pending || s.busy;
        cls = 'busy'; text = a === 'start' ? 'starting…' : 'stopping…';
        tip = `Claude Door ${text}`;
      } else if (!s) { cls = 'unk'; tip = `Claude Door: status unavailable${st.err ? ' (' + st.err + ')' : ''}`; }
      else if (s.state === 'missing') { cls = 'unk'; tip = 'Claude Door container not found'; }
      else if (s.running) { cls = 'on'; tip = 'Claude Door running — click to stop'; }
      else { cls = 'off'; tip = 'Claude Door stopped — click to start'; }
      if (st.err && s) { tip += `\n${st.err}`; if (cls !== 'busy') text = 'failed'; }
      btn.className = 'nd-door ' + cls + (text === 'failed' ? ' err' : '');
      btn.title = tip;
      lbl.textContent = text;
    }
  })();

  // ═══ 11. Status badges on cards Homepage doesn't monitor ══════════════════
  // Same icon-corner dot as the monitored cards: green up · amber partial · red down.
  (() => {
    const st = { health: {}, services: null, cams: null };
    async function poll() {
      if (document.hidden) return;
      try { const d = await api('/services/status'); st.health = d.health || {}; st.services = d.services; } catch { st.health = null; }
      try { st.cams = (await api('/ring/cameras')).cameras; } catch { st.cams = null; }
      apply();
    }
    setInterval(poll, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    poll();
    injectors.push(apply);

    function level(card) {
      const h = st.health;
      if (card === 'Speed') return h ? (h.speedtest ? 'up' : 'down') : null;
      if (card === 'Home') return h ? (h.homeassistant ? 'up' : 'down') : null;
      if (card === 'JARVIS') return h ? (h.openwebui ? 'up' : 'down') : null;
      if (card === 'Services' && st.services) { const up = st.services.filter(s => s.online).length; return up === st.services.length ? 'up' : up ? 'warn' : 'down'; }
      if (card === 'Security' && st.cams) { const up = st.cams.filter(c => c.online).length; return up === st.cams.length ? 'up' : up ? 'warn' : 'down'; }
      return null;
    }
    const LABEL = { up: 'online', warn: 'partly offline', down: 'offline' };
    function apply() {
      // Services and Security show per-app / per-camera status, so no card-level dot.
      for (const name of ['Speed', 'Home', 'JARVIS']) {
        const title = document.querySelector(`li.service[data-name="${name}"] .service-title`);
        if (!title) continue;
        let b = title.querySelector(':scope > .nd-badge');
        const lv = level(name);
        if (!lv) { b?.remove(); continue; }
        if (!b) { b = document.createElement('span'); title.appendChild(b); }
        b.className = 'nd-badge ' + lv;
        b.title = LABEL[lv];
      }
    }
  })();

  // ═══ 12. System detail panels (NAS / JARVIS tiles) ════════════════════════
  // Click the NAS or JARVIS tile: a terminal-style panel drops over the page.
  // Refreshes every 5 s while open; ✕, Esc or clicking outside closes it.
  (() => {
    const HUB = 'http://192.168.0.190:8093';
    const st = { name: null, d: null, error: '' };
    const panel = document.createElement('div');
    panel.className = 'nd-sd';
    isolate(panel);
    panel.addEventListener('click', e => {
      e.stopPropagation();
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'close') close();
      if (a === 'beszel') window.open(HUB, '_blank');
    });
    document.addEventListener('nd-sys-detail', e => { st.name === e.detail ? close() : open(e.detail); });
    document.addEventListener('pointerdown', () => { if (st.name) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.name) close(); });

    let timer = null;
    function open(name) {
      st.name = name; st.d = null; st.error = '';
      const strip = document.querySelector('.nd-sys'); if (!strip) return;
      strip.classList.add('nd-sd-open');
      strip.appendChild(panel);
      document.querySelectorAll('.nd-sys-tile').forEach(t => t.classList.toggle('sel', t.dataset.sys === name));
      render(); poll();
      clearInterval(timer); timer = setInterval(poll, 5000);
    }
    function close() {
      st.name = null; clearInterval(timer); panel.remove();
      document.querySelector('.nd-sys')?.classList.remove('nd-sd-open');
      document.querySelectorAll('.nd-sys-tile.sel').forEach(t => t.classList.remove('sel'));
    }
    async function poll() {
      const name = st.name; if (!name) return;
      try { const d = await api('/system/detail?name=' + encodeURIComponent(name)); if (st.name === name) { st.d = d; st.error = ''; } }
      catch { st.error = 'details unavailable'; }
      if (st.name === name) render();
    }

    // ── formatting ──
    const up = s => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
    const rate = b => b == null ? '-' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB/s' : b >= 1024 ? Math.round(b / 1024) + ' KB/s' : b + ' B/s';
    const tb = kb => kb >= 1e9 ? (kb / 1e9).toFixed(2) + ' TB' : Math.round(kb / 1e6) + ' GB';
    const mem = mb => mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
    const date = t => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const dur = s => { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h}h ${m}m` : `${m}m`; };
    const bar = pct => `<span class="nd-sd-bar"><i style="width:${Math.max(0, Math.min(100, pct))}%" class="${pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : ''}"></i></span>`;
    const tempClass = c => c >= 55 ? 'bad' : c >= 45 ? 'warn' : '';
    // Friendly sensor names; one line per physical device.
    const SENSOR = [[/k10temp_tctl|coretemp_package_id_\d+|cpu_package/i, 'cpu'], [/k10temp_tccd(\d+)/i, 'cpu ccd$1'], [/coretemp_core_(\d+)/i, 'core $1'],
                    [/cputin/i, 'cpu socket'], [/systin/i, 'board'], [/pch/i, 'chipset'], [/nvme_composite|nvme_sensor_1/i, 'nvme'], [/acpi|thermalzone/i, 'acpi']];
    const sensorName = n => { for (const [re, lbl] of SENSOR) { const m = n.match(re); if (m) return lbl.replace('$1', m[1] ?? ''); } return n.replace(/^nct\d+_/, '').replace(/_/g, ' '); };
    const dedupeTemps = list => { const seen = new Set(); return list.filter(t => { if (/nvme_sensor_[2-9]/i.test(t.name)) return false; const k = sensorName(t.name); if (seen.has(k)) return false; seen.add(k); return true; }); };

    function sysBlock(d) {
      // auxtin channels on this board's sensor chip report garbage (70–95 °C): skip them
      const temps = dedupeTemps((d.temps || []).filter(t => !/auxtin/i.test(t.name) && !/^GeForce|^Tesla/i.test(t.name))).slice(0, 5);
      return `
        <div class="nd-sd-sec">// system</div>
        <div class="nd-sd-kv"><span>cpu</span><b>${d.cpu ?? '-'}%</b>${d.load ? `<em>load ${d.load.map(x => (+x).toFixed(2)).join(' ')}</em>` : ''}</div>
        <div class="nd-sd-kv"><span>memory</span><b>${d.mem.usedGB} / ${d.mem.totalGB} GB</b>${bar(d.mem.pct)}</div>
        ${d.swap ? `<div class="nd-sd-kv"><span>swap</span><b class="${d.swap.usedGB / d.swap.totalGB > .5 ? 'warn' : ''}">${d.swap.usedGB} / ${d.swap.totalGB} GB</b></div>` : ''}
        ${d.name !== 'NAS' ? `<div class="nd-sd-kv"><span>disk</span><b>${d.disk.usedGB} / ${d.disk.totalGB} GB</b>${bar(d.disk.pct)}</div>` : ''}
        ${d.net ? `<div class="nd-sd-kv"><span>network</span><b>&#8595; ${rate(d.net.recvBps)} &#8593; ${rate(d.net.sentBps)}</b></div>` : ''}
        ${d.diskIO ? `<div class="nd-sd-kv"><span>disk i/o</span><b>r ${rate(d.diskIO.readBps)} · w ${rate(d.diskIO.writeBps)}</b></div>` : ''}
        ${temps.length ? `<div class="nd-sd-kv"><span>temps</span><b>${temps.map(t => `<i class="${tempClass(t.c)}">${esc(sensorName(t.name))} ${t.c}&deg;</i>`).join(' · ')}</b></div>` : ''}
        ${d.fans?.length ? `<div class="nd-sd-kv"><span>fans</span><b>${d.fans.map(f => `${esc(f.name)} ${f.rpm}`).join(' · ')} rpm</b></div>` : ''}`;
    }
    function gpuBlock(d) {
      if (!d.gpus?.length) return '';
      return `<div class="nd-sd-sec">// gpu${d.gpus.length > 1 ? 's' : ''}</div>
        <table class="nd-sd-t"><thead><tr><th>gpu</th><th>load</th><th>vram</th><th>power</th><th>temp</th></tr></thead><tbody>
        ${d.gpus.map(g => `<tr><td>${esc(g.name.toLowerCase())}</td><td>${g.util ?? 0}%</td>
          <td>${mem(g.vramUsedMB)} / ${mem(g.vramTotalMB)} ${bar(g.vramTotalMB ? g.vramUsedMB / g.vramTotalMB * 100 : 0)}</td>
          <td>${g.power ?? '-'} W</td><td class="${tempClass(g.temp)}">${g.temp ?? '-'}&deg;</td></tr>`).join('')}</tbody></table>`;
    }
    function containerBlock(d) {
      const c = d.containers; if (!c) return '';
      return `<div class="nd-sd-sec">// containers · ${c.running} running · top memory</div>
        <div class="nd-sd-ct">${c.top.map(x => `<span><b>${esc(x.name)}</b> ${mem(x.memMB)}${x.cpu >= 1 ? ` · ${x.cpu}%` : ''}</span>`).join('')}</div>`;
    }
    function nasBlock(d) {
      const u = d.unraid;
      if (!u) return '<div class="nd-sd-sec">// array</div><div class="nd-sd-msg">array status unavailable</div>';
      const data = u.disks.filter(x => x.type === 'Data'), par = u.disks.filter(x => x.type === 'Parity');
      const errs = u.disks.reduce((a, x) => a + x.errors, 0);
      const p = u.parity;
      const parity = p.running
        ? `<div class="nd-sd-kv"><span>parity</span><b class="blue">${esc(/check/i.test(p.action) ? 'check' : 'sync')} running · ${p.pct}%</b>${bar(p.pct)}<em>${p.speedMBs} MB/s · ${p.etaSec ? dur(p.etaSec) + ' left' : ''}</em></div>`
        : `<div class="nd-sd-kv"><span>parity</span><b class="${p.lastErrors ? 'bad' : ''}">${p.lastEnd ? `last check ${date(p.lastEnd)} · ${p.lastStart && p.lastEnd > p.lastStart ? dur(p.lastEnd - p.lastStart) + ' · ' : ''}${p.lastErrors} errors` : 'no check on record'}</b></div>`;
      return `
        <div class="nd-sd-sec">// array</div>
        <div class="nd-sd-kv"><span>state</span><b class="${u.state === 'STARTED' ? 'ok' : 'bad'}">${esc(u.state.toLowerCase())}</b><em>${data.length} data · ${par.length} parity${u.disabled ? ` · <i class="bad">${u.disabled} disabled</i>` : ''}${u.missing ? ` · <i class="bad">${u.missing} missing</i>` : ''} · ${errs} disk errors</em></div>
        ${parity}
        <table class="nd-sd-t nd-sd-disks"><thead><tr><th>disk</th><th>temp</th><th>err</th><th>used</th></tr></thead><tbody>
        ${u.disks.map(x => `<tr class="${x.status !== 'DISK_OK' ? 'bad' : ''}"><td>${esc(x.name)}</td>
          <td class="${x.temp != null ? tempClass(x.temp) : 'dim'}">${x.temp != null ? x.temp + '&deg;' : (x.type === 'Flash' ? '-' : 'idle')}</td>
          <td class="${x.errors ? 'bad' : ''}">${x.errors}</td>
          <td>${x.sizeKB ? `${bar(x.usedKB / x.sizeKB * 100)} ${tb(x.usedKB)} / ${tb(x.sizeKB)}` : '<span class="dim">parity</span>'}</td></tr>`).join('')}
        </tbody></table>`;
    }
    function jarvisBlock(d) {
      const l = d.llm;
      return `<div class="nd-sd-sec">// llm</div>
        <div class="nd-sd-kv"><span>server</span><b class="${l?.ok ? 'ok' : 'bad'}">${esc(l?.server || 'llama.cpp')} · ${l?.ok ? 'ok' : 'not responding'}</b></div>
        <div class="nd-sd-kv"><span>model</span><b>${esc(l?.model || '-')}</b></div>
        ${gpuBlock(d)}`;
    }

    function render() {
      const d = st.d, name = (st.name || '').toLowerCase();
      const head = `<div class="nd-sd-head"><b>[ ${esc(name)} ]</b>
        <span>${d ? `${d.name === 'NAS' ? 'unraid' : 'ubuntu'} · up ${up(d.uptime)}` : ''}</span>
        <button data-act="beszel">open beszel &#8599;</button><button data-act="close" aria-label="Close">&#10005;</button></div>`;
      if (!d) { panel.innerHTML = head + `<div class="nd-sd-msg">${esc(st.error || 'loading…')}</div>`; return; }
      const left = d.name === 'NAS' ? nasBlock(d) : jarvisBlock(d);
      const right = sysBlock(d) + (d.name === 'NAS' ? gpuBlock(d) : '') + containerBlock(d);
      panel.innerHTML = head + `<div class="nd-sd-cols"><div>${left}</div><div>${right}</div></div>` + (st.error ? `<div class="nd-sd-msg bad">${esc(st.error)}</div>` : '');
    }
  })();

  // ═══ 13. Coms: mic + listen device + Windows default guard ════════════════
  // Talks to NasDash's own loopback API (coms.js in the NasDash app), so it
  // only works when the dashboard is shown inside NasDash on this PC.
  (() => {
    const API = 'http://127.0.0.1:8889';
    const st = { s: null, err: '', busy: false, meter: 0, muted: false };
    const root = document.createElement('div'); root.className = 'nd-coms';
    const pill = document.createElement('button'); pill.className = 'nd-ha-pill nd-coms-pill'; pill.dataset.act = 'mute';
    for (const el of [root, pill]) { isolate(el); el.addEventListener('click', onClick); }
    root.addEventListener('change', e => {
      if (e.target.matches('select[data-act=input]')) send('/coms/input', { id: e.target.value });
      if (e.target.matches('select[data-act=output]')) send('/coms/output', { id: e.target.value });
    });
    let card = null;
    injectors.push(() => {
      const c = mount('Coms', root, 'nd-ha-host'); if (!c) return;
      if (!c.contains(pill)) c.appendChild(pill);
      if (c !== card) { card = c; render(); }
    });

    const get = p => fetch(API + p, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    async function send(p, body) {
      if (st.busy) return; st.busy = true;
      try { const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NasDash': '1' }, body: JSON.stringify(body) });
            const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); st.s = j; st.err = ''; }
      catch (e) { st.err = String(e.message || e); }
      finally { st.busy = false; render(); }
    }
    async function poll() {
      if (document.hidden) return;
      try { st.s = await get('/coms/state'); st.err = ''; } catch { st.s = null; st.err = 'offline'; }
      render();
    }
    setInterval(poll, 5000); poll();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    // live mic meter (10/s) while visible and the API is reachable
    setInterval(async () => {
      if (document.hidden || !st.s) return;
      try { const m = await get('/coms/meter'); st.meter = m.level || 0; st.muted = m.muted; paintMeter(); } catch {}
    }, 100);

    function onClick(e) {
      e.stopPropagation();
      const el = e.target.closest('[data-act]'); if (!el) return; e.preventDefault();
      const s = st.s; if (!s) return;
      const a = el.dataset.act;
      if (a === 'mute' && s.mic) return send('/coms/mic', { muted: !s.mic.muted });
      if (a === 'gain' && s.mic) return send('/coms/mic', { gainDb: s.mic.gainDb + Number(el.dataset.d) });
      if (a === 'out') return send('/coms/output', { id: el.dataset.id });
      if (a === 'vol' && s.output.volume) return send('/coms/volume', { volume: s.output.volume.volume + Number(el.dataset.d) });
      if (a === 'outmute' && s.output.volume) return send('/coms/volume', { muted: !s.output.volume.muted });
      if (a === 'guard') return send('/coms/enforce', { on: !s.enforce });
    }

    const SEGS = 14;
    function paintMeter() {
      const m = root.querySelector('.nd-coms-meter'); if (!m) return;
      // level is 0..1 from NasDash; square-root scale so normal speech fills the middle of the bar
      const lit = st.muted ? 0 : Math.round(Math.sqrt(Math.min(1, Math.max(0, st.meter))) * SEGS);
      [...m.children].forEach((seg, i) => { seg.className = i < lit ? (i >= SEGS - 2 ? 'hot' : i >= SEGS - 5 ? 'warm' : 'on') : ''; });
    }

    function render() {
      if (!card) return;
      const s = st.s;
      if (!s) {
        pill.style.display = 'none';
        root.innerHTML = `<div class="nd-coms-msg">${st.err === 'offline' ? 'audio controls work inside nasdash on this pc' : 'loading…'}</div>`;
        return;
      }
      pill.style.display = '';
      const mic = s.mic;
      pill.classList.toggle('muted', !!mic?.muted);
      pill.innerHTML = !mic ? 'wave link off' : mic.muted ? '&#10005; muted' : '&#9679; mic live';
      pill.title = mic ? (mic.muted ? 'Unmute mic' : 'Mute mic') : 'Wave Link is not running';
      const o = s.output, i = s.input, v = o.volume;
      root.innerHTML = `
        <div class="nd-coms-row"><span class="k">mic</span>
          <span class="nd-coms-meter">${'<i></i>'.repeat(SEGS)}</span>
          ${mic ? `<span class="nd-coms-step"><button data-act="gain" data-d="-1" aria-label="Lower gain">&#8722;</button><b>${mic.gainDb} dB</b><button data-act="gain" data-d="1" aria-label="Raise gain">+</button></span>` : '<span class="dim">wave link offline</span>'}
        </div>
        <div class="nd-coms-row"><span class="k">listen</span>
          <select data-act="output" title="Windows default output">${o.choices.map(c => `<option value="${esc(c.id)}" ${o.current?.id === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select><b class="${o.ok ? 'ok' : 'warn'}">${o.ok ? '&#10003;' : '&#9888;'}</b>
          ${v ? `<span class="nd-coms-step"><button data-act="vol" data-d="-5" aria-label="Volume down">&#8722;</button><b class="${v.muted ? 'dim' : ''}" data-act="outmute" title="Click to ${v.muted ? 'unmute' : 'mute'}">${v.muted ? 'muted' : v.volume + '%'}</b><button data-act="vol" data-d="5" aria-label="Volume up">+</button></span>` : ''}
        </div>
        <div class="nd-coms-row"><span class="k">input</span>
          <span><select data-act="input" title="Windows default microphone">${i.choices.map(c => `<option value="${esc(c.id)}" ${i.current?.id === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select><b class="${i.ok ? 'ok' : 'warn'}">${i.ok ? '&#10003;' : '&#9888;'}</b></span>
          <button data-act="guard" class="nd-coms-guard ${s.enforce ? 'on' : ''}" title="Guard: ${s.enforce ? 'on — Windows is kept on these devices' : 'off'}">guard ${s.enforce ? 'on' : 'off'}</button>
        </div>
        ${st.err ? `<div class="nd-coms-msg bad">${esc(st.err)}</div>` : ''}`;
      paintMeter();
    }
  })();

  // ═══ 14. JARVIS quick chat ════════════════════════════════════════════════
  // "> ask jarvis…" prompt in the card; the conversation opens in a panel ABOVE
  // the card (it sits at the bottom of the page). Replies stream in. Nothing is
  // saved: the conversation only lives in this page until "new" or a reload.
  (() => {
    const st = { msgs: [], open: false, streaming: false, ctrl: null, model: null, ok: null };
    const root = document.createElement('div'); root.className = 'nd-jv';
    root.innerHTML = `<form class="nd-jv-form" autocomplete="off">
        <span class="nd-jv-gt">&gt;</span><input type="text" placeholder="ask jarvis…" aria-label="Ask JARVIS" spellcheck="true">
        <button type="submit" class="nd-jv-send" aria-label="Send">&#9166;</button>
        <button type="button" data-act="new" class="nd-jv-new" title="Start a new chat">new</button>
      </form>`;
    const panel = document.createElement('div'); panel.className = 'nd-jv-panel';
    for (const el of [root, panel]) { isolate(el); el.addEventListener('pointerdown', e => e.stopPropagation()); }
    const form = root.querySelector('form'), input = root.querySelector('input'), sendBtn = root.querySelector('.nd-jv-send');
    ['keydown', 'keyup', 'keypress'].forEach(t => input.addEventListener(t, e => e.stopPropagation()));   // keep Homepage's search hotkeys out
    input.addEventListener('keydown', e => { if (e.key === 'Escape') { setOpen(false); input.blur(); } });
    input.addEventListener('focus', () => { if (st.msgs.length) setOpen(true); });
    form.addEventListener('submit', e => { e.preventDefault(); e.stopPropagation(); st.streaming ? stop() : ask(input.value); });
    root.addEventListener('click', e => { e.stopPropagation(); if (e.target.closest('[data-act=new]')) { stop(); st.msgs = []; setOpen(false); input.value = ''; input.focus(); } });
    panel.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'close') setOpen(false);
      if (b.dataset.act === 'copy') { const m = st.msgs[+b.dataset.i]; navigator.clipboard?.writeText(m.content).then(() => { b.textContent = 'copied'; setTimeout(() => (b.textContent = 'copy'), 1200); }).catch(() => {}); }
    });
    document.addEventListener('pointerdown', () => { if (st.open) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.open) setOpen(false); });

    let card = null;
    injectors.push(() => {
      const c = mount('JARVIS', root, 'nd-jv-host'); if (!c) return;
      if (st.open && !c.contains(panel)) c.appendChild(panel);
      card = c; showModel();
    });

    async function info() { try { const j = await api('/llm/info'); st.model = j.model; st.ok = j.ok; } catch { st.ok = false; } showModel(); }
    info(); setInterval(info, 60000);
    function showModel() {
      const d = card?.querySelector('.service-description'); if (!d) return;
      d.textContent = st.ok === false ? 'offline' : (st.model || 'local ai chat').toLowerCase();
    }

    function setOpen(v) {
      st.open = v && st.msgs.length > 0;
      card?.classList.toggle('nd-jv-open', st.open);
      if (st.open && card && !card.contains(panel)) card.appendChild(panel);
      if (!st.open) panel.remove(); else render();
    }
    function stop() { st.ctrl?.abort(); }

    async function ask(q) {
      q = q.trim(); if (!q || st.streaming) return;
      input.value = '';
      st.msgs.push({ role: 'user', content: q }, { role: 'assistant', content: '', pending: true });
      st.streaming = true; sendBtn.innerHTML = '&#9632;'; sendBtn.setAttribute('aria-label', 'Stop'); sendBtn.classList.add('stop');
      setOpen(true);
      const reply = st.msgs[st.msgs.length - 1];
      st.ctrl = new AbortController();
      try {
        const r = await fetch(BRIDGE + '/llm/chat', { method: 'POST', signal: st.ctrl.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: st.msgs.filter(m => !m.pending || m.content).map(({ role, content }) => ({ role, content })).filter(m => m.content) }) });
        if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'JARVIS did not answer (' + r.status + ')'); }
        const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '', raf = 0;
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const l of lines) {
            if (!l.startsWith('data: ') || l.includes('[DONE]')) continue;
            try { const c = JSON.parse(l.slice(6)).choices?.[0]?.delta?.content; if (c) reply.content += c; } catch {}
          }
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
        }
      } catch (e) {
        if (e.name === 'AbortError') reply.content += reply.content ? '\n\n_(stopped)_' : '_(stopped)_';
        else reply.error = String(e.message || e);
      } finally {
        reply.pending = false; st.streaming = false; st.ctrl = null;
        reply.content = reply.content.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
        sendBtn.innerHTML = '&#9166;'; sendBtn.setAttribute('aria-label', 'Send'); sendBtn.classList.remove('stop');
        render(); input.focus();
      }
    }

    // Minimal, safe Markdown: escape first, then code blocks, inline code, bold, lists.
    function md(t) {
      const parts = String(t).split(/```/);
      return parts.map((p, i) => {
        if (i % 2) { const body = p.replace(/^[\w+-]*\n/, ''); return `<pre>${esc(body.replace(/\n$/, ''))}</pre>`; }
        return esc(p)
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
          .replace(/(^|\n)\s*[-*] (.*)/g, '$1<span class="li">&#8226; $2</span>')
          .replace(/(^|\n)\s*(\d+)\. (.*)/g, '$1<span class="li">$2. $3</span>')
          .replace(/_\(([^)]*)\)_/g, '<i>($1)</i>')
          .replace(/\n/g, '<br>');
      }).join('');
    }

    function render() {
      if (!st.open) return;
      panel.innerHTML = `
        <div class="nd-jv-head"><span>// jarvis · ${esc((st.model || '').toLowerCase())}</span><span class="dim">not saved · esc to close</span>
          <button data-act="close" aria-label="Close">&#10005;</button></div>
        <div class="nd-jv-log">${st.msgs.map((m, i) => m.role === 'user'
          ? `<div class="nd-jv-q"><span class="gt">&gt;</span>${esc(m.content)}</div>`
          : `<div class="nd-jv-a">${m.error ? `<span class="bad">${esc(m.error)}</span>` : md(m.content) || ''}${m.pending ? '<span class="nd-jv-cursor"></span>' : ''}
               ${!m.pending && m.content && !m.error ? `<button data-act="copy" data-i="${i}" class="nd-jv-copy">copy</button>` : ''}</div>`).join('')}</div>`;
      const log = panel.querySelector('.nd-jv-log'); log.scrollTop = log.scrollHeight;
    }
  })();
})();
