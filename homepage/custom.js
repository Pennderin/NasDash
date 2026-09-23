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
      if (e.target.closest('.nd-sys-tile')) window.open(HUB, '_blank');
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
      return `<div class="nd-sys-tile" title="Open Beszel">
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
})();
