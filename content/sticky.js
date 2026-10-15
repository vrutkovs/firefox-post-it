(() => {
  'use strict';
  if (globalThis.__postitLoaded) return;
  globalThis.__postitLoaded = true;

  const { parse, build } = globalThis.PostitRender;
  const { showTodoist } = globalThis.PostitTodoist;

  const SAVE_DELAY_MS = 500;
  const POS_DELAY_MS = 300;
  const NOTICE_MS = 4000;
  const RELOAD_THROTTLE_MS = 1000;
  const MARGIN_PX = 16;
  const CASCADE_PX = 24;
  const MIN_VISIBLE_PX = 40;
  const TITLE_CHARS = 40;
  const COLORS = {
    yellow: '#fff59d',
    pink: '#f8bbd0',
    green: '#c5e1a5',
    blue: '#b3e5fc',
    purple: '#d1c4e9',
    orange: '#ffcc80',
  };
  const DEFAULTS = { color: 'yellow', w: 240, h: 180 };
  const TASK_LINE_RE = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/;
  const NOTE_FIELDS = ['id', 'rel', 'url', 'body', 'color', 'tags', 'ignore_query', 'mtime'];

  const notes = new Set();
  let todoistLinks = [];
  let pageUrl = cleanUrl(location.href);
  let generation = 0;
  let clock = 0;
  let lastReload = 0;
  let settings = { ...DEFAULTS };
  let mouse = null; // last pointer position, where new notes appear

  // Shadow DOM keeps page CSS out and ours in.
  const host = document.createElement('postit-layer');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = el('style');
  const layer = el('div', 'layer');
  const toast = el('div', 'toast');
  toast.hidden = true;
  shadow.append(style, layer, toast);
  document.documentElement.append(host);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, title) {
    const b = el('button', '', text);
    b.type = 'button';
    b.title = title;
    return b;
  }

  function cleanUrl(href) {
    const u = new URL(href);
    u.hash = '';
    return u.href;
  }

  function pick(n) {
    return Object.fromEntries(NOTE_FIELDS.map((k) => [k, n[k]]));
  }

  const posKey = (st) => `pos:${st.rel}`;

  async function call(payload) {
    try {
      return (await browser.runtime.sendMessage({ type: 'host', payload })) || { error: 'no reply' };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  }

  let toastTimer = null;
  function notice(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), NOTICE_MS);
  }

  // --- note lifecycle ---------------------------------------------------

  function defaultPos() {
    const i = notes.size;
    return {
      x: innerWidth - settings.w - MARGIN_PX - CASCADE_PX * i,
      y: MARGIN_PX + CASCADE_PX * i,
      w: settings.w,
      h: settings.h,
      minimized: false,
    };
  }

  function add(n, pos) {
    const st = {
      ...pick(n),
      pos: { ...defaultPos(), ...pos },
      dirty: false,
      saving: false,
      editing: false,
      touched: 0,
      timer: null,
      posTimer: null,
      chain: Promise.resolve(),
    };
    st.el = makeNote(st);
    notes.add(st);
    layer.append(st.el.root);
    setMinimized(st, st.pos.minimized, false);
    applyColor(st);
    renderBody(st);
    return st;
  }

  function detach(st) {
    clearTimeout(st.posTimer);
    st.el.root.remove();
    notes.delete(st);
  }

  // Top-left corner at the pointer, shifted so the whole note fits the viewport.
  function mousePos() {
    if (!mouse) return undefined;
    return {
      x: Math.max(0, Math.min(mouse.x, innerWidth - settings.w - MARGIN_PX)),
      y: Math.max(0, Math.min(mouse.y, innerHeight - settings.h - MARGIN_PX)),
    };
  }

  function create(ignoreQuery) {
    const st = add({
      id: null,
      rel: null,
      url: cleanUrl(location.href),
      body: '',
      color: settings.color,
      tags: [],
      ignore_query: ignoreQuery,
      mtime: null,
    }, mousePos());
    st.dirty = true;
    flush(st);
    startEdit(st);
  }

  async function destroy(st) {
    if (!confirm('Delete this note?')) return;
    clearTimeout(st.timer);
    st.dirty = false;
    await st.chain;

    if (st.id) {
      const res = await call({ op: 'delete', url: st.url, id: st.id });
      if (res.error) {
        notice(`Delete failed: ${res.error}`);
        return;
      }
      browser.storage.local.remove(posKey(st));
    }
    detach(st);
  }

  // --- saving -------------------------------------------------------------

  function touch(st) {
    st.touched = ++clock;
  }

  function schedule(st) {
    st.dirty = true;
    touch(st);
    clearTimeout(st.timer);
    st.timer = setTimeout(() => flush(st), SAVE_DELAY_MS);
  }

  // Saves are chained per note so a new note gets its id before any update.
  function flush(st) {
    clearTimeout(st.timer);
    st.timer = null;
    if (st.dirty) st.chain = st.chain.then(() => save(st));
    return st.chain;
  }

  function flushAll() {
    for (const st of notes) flush(st);
  }

  async function save(st) {
    if (!st.dirty) return;
    st.dirty = false;
    st.saving = true;
    touch(st);

    const note = { id: st.id, body: st.body, color: st.color, tags: st.tags, ignore_query: st.ignore_query };
    const res = await call({ op: 'save', url: st.url, note, mtime: st.mtime });
    st.saving = false;
    touch(st);

    if (res.error === 'conflict') {
      notice('Note changed on disk; reloaded from file.');
      await reloadOne(st);
      return;
    }
    if (res.error === 'not_found') {
      notice('Note was deleted on disk.');
      detach(st);
      return;
    }
    if (res.error) {
      st.dirty = true;
      notice(`Save failed: ${res.error}`);
      return;
    }

    const isNew = !st.rel;
    Object.assign(st, { id: res.id, rel: res.rel, mtime: res.mtime });
    if (isNew) storePos(st);
  }

  function storePos(st) {
    clearTimeout(st.posTimer);
    st.posTimer = setTimeout(() => {
      if (st.rel) browser.storage.local.set({ [posKey(st)]: { ...st.pos } });
    }, POS_DELAY_MS);
  }

  // --- loading ------------------------------------------------------------

  async function load() {
    const gen = generation;
    const startClock = clock;
    const res = await call({ op: 'load', url: pageUrl });
    if (gen !== generation) return;
    if (res.error) {
      if (res.error.startsWith('too_large')) notice(`Post-it: ${res.error}`);
      console.warn('postit:', res.error);
      return;
    }

    const stored = await browser.storage.local.get(res.notes.map((n) => `pos:${n.rel}`));
    if (gen !== generation) return;
    todoistLinks = res.todoist;
    for (const st of notes) showTodoist(st.el.todoist, todoistLinks);

    // Notes changed locally since this load started keep their local state.
    const busy = (st) => st.editing || st.dirty || st.saving || st.touched > startClock;
    const byId = new Map([...notes].filter((st) => st.id).map((st) => [st.id, st]));
    const seen = new Set();
    // A create in flight may already be on disk; adding it now would duplicate it.
    const creating = [...notes].some((st) => !st.id);

    for (const n of res.notes) {
      seen.add(n.id);
      const st = byId.get(n.id);
      if (!st) {
        if (!creating) add(n, stored[`pos:${n.rel}`]);
        continue;
      }
      if (busy(st) || st.mtime === n.mtime) continue;
      Object.assign(st, pick(n));
      applyColor(st);
      renderBody(st);
    }

    for (const st of [...notes]) {
      if (st.id && !seen.has(st.id) && !busy(st)) detach(st);
    }
  }

  function reload() {
    if (Date.now() - lastReload < RELOAD_THROTTLE_MS) return;
    lastReload = Date.now();
    load();
  }

  async function reloadOne(st) {
    const res = await call({ op: 'load', url: st.url });
    if (res.error) return;
    const n = res.notes.find((x) => x.id === st.id);
    if (!n) {
      detach(st);
      return;
    }

    Object.assign(st, pick(n));
    applyColor(st);
    if (st.editing) st.el.textarea.value = st.body;
    else renderBody(st);
  }

  function navigate(url) {
    const u = cleanUrl(url);
    if (u === pageUrl) return;
    flushAll();
    for (const st of [...notes]) detach(st);
    pageUrl = u;
    todoistLinks = [];
    generation++;
    load();
  }

  // --- DOM ----------------------------------------------------------------

  function makeNote(st) {
    const root = el('div', 'note');
    const head = el('div', 'head');
    const min = button('–', 'Minimize');
    const title = el('span', 'title');
    const colorBtn = button('', 'Color');
    colorBtn.setAttribute('aria-label', 'Color');
    const svgNS = 'http://www.w3.org/2000/svg';
    const paletteIcon = document.createElementNS(svgNS, 'svg');
    paletteIcon.setAttribute('viewBox', '0 0 24 24');
    paletteIcon.setAttribute('width', '14');
    paletteIcon.setAttribute('height', '14');
    paletteIcon.setAttribute('fill', 'none');
    paletteIcon.setAttribute('stroke', 'currentColor');
    paletteIcon.setAttribute('stroke-width', '2');
    paletteIcon.setAttribute('stroke-linecap', 'round');
    paletteIcon.setAttribute('stroke-linejoin', 'round');
    paletteIcon.setAttribute('aria-hidden', 'true');
    const outline = document.createElementNS(svgNS, 'path');
    outline.setAttribute('d', 'M12 22a10 10 0 1 1 10-10c0 1.7-1.3 3-3 3h-1.8a2 2 0 0 0-1.8 2.9l.4.9A2 2 0 0 1 14 22z');
    const spots = [[8, 8], [13, 6], [18, 10], [7, 13]].map(([cx, cy]) => {
      const spot = document.createElementNS(svgNS, 'circle');
      spot.setAttribute('cx', cx);
      spot.setAttribute('cy', cy);
      spot.setAttribute('r', '1');
      spot.setAttribute('fill', 'currentColor');
      spot.setAttribute('stroke', 'none');
      return spot;
    });
    paletteIcon.append(outline, ...spots);
    colorBtn.append(paletteIcon);
    const todoist = el('div', 'todoist');
    showTodoist(todoist, todoistLinks);
    const del = button('×', 'Delete');
    head.append(min, title, todoist, colorBtn, del);

    const palette = el('div', 'palette');
    palette.hidden = true;
    for (const [name, hex] of Object.entries(COLORS)) {
      const sw = button('', name);
      sw.className = 'swatch';
      sw.style.background = hex;
      sw.addEventListener('click', () => {
        palette.hidden = true;
        st.color = name;
        applyColor(st);
        st.dirty = true;
        touch(st);
        flush(st);
      });
      palette.append(sw);
    }

    const body = el('div', 'body');
    root.append(head, palette, body);

    min.addEventListener('click', () => setMinimized(st, !st.pos.minimized));
    colorBtn.addEventListener('click', () => (palette.hidden = !palette.hidden));
    del.addEventListener('click', () => destroy(st));
    body.addEventListener('click', (e) => {
      if (st.editing || e.target.closest('a, input')) return;
      startEdit(st);
    });
    body.addEventListener('change', (e) => {
      if (e.target.matches('input[type=checkbox]')) toggleTask(st, Number(e.target.dataset.line));
    });

    // Keys typed into a note must not trigger page shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());

    enableDrag(st, head);
    new ResizeObserver(() => onResize(st)).observe(root);
    return { root, title, min, body, palette, todoist, textarea: null };
  }

  function enableDrag(st, head) {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, a')) return;
      e.preventDefault();
      const dx = e.clientX - st.pos.x;
      const dy = e.clientY - st.pos.y;
      head.setPointerCapture(e.pointerId);

      const move = (ev) => {
        st.pos.x = ev.clientX - dx;
        st.pos.y = ev.clientY - dy;
        applyPos(st);
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        storePos(st);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }

  function onResize(st) {
    const { root } = st.el;
    if (st.pos.minimized || !root.offsetWidth) return;
    if (root.offsetWidth === st.pos.w && root.offsetHeight === st.pos.h) return;
    st.pos.w = root.offsetWidth;
    st.pos.h = root.offsetHeight;
    storePos(st);
  }

  // Keep at least part of the note on screen so it can be dragged back.
  function applyPos(st) {
    const p = st.pos;
    p.x = Math.min(Math.max(p.x, MIN_VISIBLE_PX - p.w), innerWidth - MIN_VISIBLE_PX);
    p.y = Math.min(Math.max(p.y, 0), innerHeight - MIN_VISIBLE_PX);

    const s = st.el.root.style;
    s.left = `${p.x}px`;
    s.top = `${p.y}px`;
    s.width = `${p.w}px`;
    s.height = p.minimized ? '' : `${p.h}px`;
  }

  function applyColor(st) {
    st.el.root.style.setProperty('--bg', COLORS[st.color] || COLORS[DEFAULTS.color]);
  }

  function setMinimized(st, minimized, persist = true) {
    if (minimized && st.editing) st.el.textarea.blur();
    st.pos.minimized = minimized;
    st.el.root.classList.toggle('minimized', minimized);
    st.el.min.textContent = minimized ? '+' : '–';
    st.el.min.title = minimized ? 'Restore' : 'Minimize';
    applyPos(st);
    if (persist) storePos(st);
  }

  function minimizeAll() {
    const all = [...notes];
    const target = all.some((st) => !st.pos.minimized);
    for (const st of all) setMinimized(st, target);
  }

  function renderBody(st) {
    const first = st.body.split('\n').find((l) => l.trim()) || '';
    st.el.title.textContent = first.trim().slice(0, TITLE_CHARS);
    if (st.editing) return;

    if (!st.body.trim()) {
      st.el.body.replaceChildren(el('span', 'placeholder', 'Click to edit'));
      return;
    }
    st.el.body.replaceChildren(build(parse(st.body)));
  }

  function startEdit(st) {
    if (st.editing) return;
    if (st.pos.minimized) setMinimized(st, false);
    st.editing = true;

    const ta = el('textarea');
    ta.value = st.body;
    ta.addEventListener('input', () => {
      st.body = ta.value;
      schedule(st);
    });
    ta.addEventListener('blur', () => stopEdit(st));
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      ta.blur();
    });

    st.el.textarea = ta;
    st.el.body.replaceChildren(ta);
    ta.focus();
  }

  function stopEdit(st) {
    if (!st.editing) return;
    st.editing = false;
    st.el.textarea = null;
    flush(st);
    renderBody(st);
  }

  // "- [ ] x" <-> "- [x] x" on the clicked source line
  function toggleTask(st, line) {
    const lines = st.body.split('\n');
    const src = lines[line] ?? '';
    if (TASK_LINE_RE.test(src)) {
      lines[line] = src.replace(TASK_LINE_RE, (_, a, x, b) => a + (x === ' ' ? 'x' : ' ') + b);
      st.body = lines.join('\n');
      st.dirty = true;
      touch(st);
      flush(st);
    }
    renderBody(st);
  }

  // --- events -------------------------------------------------------------

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'new') create(msg.ignoreQuery === true);
    else if (msg?.type === 'minimizeAll') minimizeAll();
    else if (msg?.type === 'navigate') navigate(msg.url);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) settings = { ...DEFAULTS, ...changes.settings.newValue };
  });

  document.addEventListener('visibilitychange', () => (document.hidden ? flushAll() : reload()));
  window.addEventListener('focus', (e) => e.target === window && reload());
  window.addEventListener('pagehide', flushAll);
  window.addEventListener('resize', () => notes.forEach(applyPos));
  for (const type of ['mousemove', 'contextmenu']) {
    window.addEventListener(type, (e) => (mouse = { x: e.clientX, y: e.clientY }), { capture: true, passive: true });
  }

  (async () => {
    const [css, stored] = await Promise.all([
      browser.runtime.sendMessage({ type: 'css' }).catch(() => ''),
      browser.storage.local.get('settings'),
    ]);
    style.textContent = css;
    settings = { ...DEFAULTS, ...stored.settings };
    lastReload = Date.now();
    load();
  })();
})();
