'use strict';
/*
 * Tilt Up — a tilt-the-bar arcade climb.
 * J raises the left end of the bar, K raises the right end (Shift lowers).
 * The ball rolls along the bar. Holes are traps; the lit hole in the top row is the goal.
 * Levels are generated from a seed string, so any seed always rebuilds the same board.
 */

// Constants, RNG, seeds and generateLevel() live in level.js (loaded first).

// Flat palette for the canvas. Keep in sync with the CSS tokens in styles.css.
const PAL = {
  field: '#1a1d22', dot: '#23272e', rail: '#2c3139', rim: '#3a404a', hole: '#07080a',
  ink: '#e9e4d4', dim: '#6f7682', accent: '#ffb43b', danger: '#ff5d5d'
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Extension APIs exist only when running as the installed extension (not when index.html is opened as a file).
const ext = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id ? chrome : null;

// ---------- storage (chrome.storage.local, falls back to localStorage when opened as a plain page) ----------
const store = {
  async get(key, fallback) {
    try {
      if (ext) {
        const r = await chrome.storage.local.get(key);
        return r[key] === undefined ? fallback : r[key];
      }
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  async set(key, value) {
    try {
      if (ext) await chrome.storage.local.set({ [key]: value });
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage unavailable: game still works, just doesn't remember */ }
  }
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const overlay = $('overlay');
const params = new URLSearchParams(location.search);
const isTab = params.has('tab');
// Web mode: the same game served as a web page (GitHub Pages) with no extension APIs.
// It's what phones and friends without the extension get from a shared link.
const isWeb = !ext && location.protocol.startsWith('http');
const LINKS = window.TILT_LINKS || {};
if (isTab || isWeb) document.body.classList.add('tab');
if (isWeb) document.body.classList.add('web');

// ---------- game state ----------
const keys = { j: false, k: false, shift: false, padJ: false, padK: false };
const G = {
  level: null, state: 'ready', paused: false,
  hL: BAR_BOTTOM, hR: BAR_BOTTOM, bx: 0, vx: 0,
  t: 0, drops: 0, anim: 0, animFrom: null, animHole: null, clock: 0
};
let bests = {};   // seed -> { t, drops }
let saved = [];   // [{ seed, at }]

const barY = (x) => G.hL + (G.hR - G.hL) * (x / W);
const ballY = () => barY(G.bx) - BALL_R - 1;
const leftHeld = () => keys.j || keys.padJ;
const rightHeld = () => keys.k || keys.padK;
const isOver = () => G.state === 'won' || G.state === 'lost';
const dropsText = (n) => `${n} drop${n === 1 ? '' : 's'}`;

function loadLevel(seed) {
  seed = cleanSeed(seed) || randomSeed('N');
  G.level = generateLevel(seed);
  restart();
  $('seedText').textContent = seed;
  $('hudSeed').textContent = hudLabel(seed);
  store.set('tu_last', seed);
}

// Today's daily is just "DAILY"; an older one shows its date (MM-DD) so it isn't mistaken for today's.
function hudLabel(seed) {
  if (seed === dailySeed()) return 'DAILY';
  if (isDailySeed(seed)) return `DAILY ${seed.slice(6, 8)}-${seed.slice(8, 10)}`;
  return `${DIFFS[G.level.diff].name} ${seed}`;
}

function restart() {
  G.state = 'ready';
  G.paused = false;
  G.hL = G.hR = BAR_BOTTOM;
  G.bx = G.level.startX;
  G.vx = 0;
  G.t = 0;
  G.drops = 0;
  renderOverlay();
}

function newLevel() { loadLevel(randomSeed($('diff').value)); }
function daily() { loadLevel(dailySeed()); }

// ---------- update ----------
function update(dt) {
  G.clock += dt;
  if (G.paused) return;

  if (G.state === 'ready' && (leftHeld() || rightHeld())) {
    G.state = 'play';
    renderOverlay();
  }
  if (G.state === 'play' || G.state === 'drop' || G.state === 'reset') G.t += dt;

  if (G.state === 'play') {
    stepBar(dt);
    stepBall(dt);
    checkHoles();
    // Loss: an end of the bar hit the ceiling, so it can't go any higher.
    if (G.state === 'play' && (G.hL <= BAR_TOP || G.hR <= BAR_TOP)) lose();
  } else if (G.state === 'drop' || G.state === 'won') {
    G.anim += dt;
    if (G.state === 'drop' && G.anim >= DROP_TIME) G.state = 'reset';
  } else if (G.state === 'reset') {
    G.hL = Math.min(BAR_BOTTOM, G.hL + RESET_SPEED * dt);
    G.hR = Math.min(BAR_BOTTOM, G.hR + RESET_SPEED * dt);
    if (G.hL >= BAR_BOTTOM && G.hR >= BAR_BOTTOM) {
      G.bx = G.level.startX;
      G.vx = 0;
      G.state = 'play';
    }
  }
}

function stepBar(dt) {
  const step = RAISE_SPEED * dt;
  const dir = keys.shift ? 1 : -1; // canvas y grows downward: raising = smaller y
  let nL = G.hL, nR = G.hR;
  if (leftHeld()) nL += dir * step;
  if (rightHeld()) nR += dir * step;
  nL = clamp(nL, BAR_TOP, BAR_BOTTOM);
  nR = clamp(nR, BAR_TOP, BAR_BOTTOM);

  // Tilt limit: the side that moved more gets held back.
  const d = nL - nR;
  if (Math.abs(d) > MAX_TILT) {
    const excess = Math.abs(d) - MAX_TILT;
    const s = Math.sign(d);
    if (Math.abs(nL - G.hL) >= Math.abs(nR - G.hR)) nL -= s * excess;
    else nR += s * excess;
  }
  G.hL = nL;
  G.hR = nR;
}

function stepBall(dt) {
  const slope = (G.hR - G.hL) / W; // > 0 means right end is lower: ball rolls right
  const cfg = DIFFS[G.level.diff];
  const accel = GRAVITY * cfg.speed * (5 / 7) * slope / Math.sqrt(1 + slope * slope);
  G.vx += accel * dt;
  G.vx -= G.vx * cfg.friction * dt;
  G.bx += G.vx * dt;
  const lo = RAIL + BALL_R, hi = W - RAIL - BALL_R;
  if (G.bx < lo) { G.bx = lo; G.vx = -G.vx * 0.3; }
  if (G.bx > hi) { G.bx = hi; G.vx = -G.vx * 0.3; }
}

function checkHoles() {
  const by = ballY();
  for (const h of G.level.holes) {
    if (Math.hypot(G.bx - h.x, by - h.y) < G.level.fallR) {
      G.anim = 0;
      G.animFrom = { x: G.bx, y: by };
      G.animHole = h;
      if (h.goal) win();
      else { G.state = 'drop'; G.drops++; toast(`dropped! (${G.drops})`); }
      return;
    }
  }
}

async function win() {
  G.state = 'won';
  const seed = G.level.seed;
  const prev = bests[seed];
  const isBest = !prev || G.t < prev.t;
  if (isBest) {
    bests[seed] = { t: Math.round(G.t * 10) / 10, drops: G.drops };
    await store.set('tu_bests', bests);
    renderSaved();
  }
  renderOverlay({ isBest, prev });
}

function lose() {
  G.state = 'lost';
  keys.j = keys.k = keys.padJ = keys.padK = false;
  syncPads();
  renderOverlay({ lost: true });
}

// ---------- drawing ----------
function disc(cx, cy, r, color) {
  ctx.fillStyle = color;
  cx = Math.round(cx); cy = Math.round(cy); r = Math.max(0, Math.round(r));
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.floor(Math.sqrt(r * r - dy * dy) + 0.35);
    ctx.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
  }
}

function draw() {
  ctx.fillStyle = PAL.field;
  ctx.fillRect(0, 0, W, H);

  // dot grid
  ctx.fillStyle = PAL.dot;
  for (let y = 6; y < H; y += 10) for (let x = 9; x < W - 4; x += 10) ctx.fillRect(x, y, 1, 1);

  // rails + bar sliders
  ctx.fillStyle = PAL.rail;
  ctx.fillRect(0, 0, RAIL, H);
  ctx.fillRect(W - RAIL, 0, RAIL, H);

  // ceiling: touching it with either end ends the run
  const near = Math.min(G.hL, G.hR) - BAR_TOP < 14;
  ctx.fillStyle = near && (reduceMotion || Math.floor(G.clock * 6) % 2 === 0) ? PAL.danger : PAL.rim;
  for (let x = RAIL; x < W - RAIL; x += 4) ctx.fillRect(x, BAR_TOP - 1, 2, 1);

  const slider = (y, held) => (y - BAR_TOP < 14 ? PAL.danger : held ? PAL.accent : PAL.dim);
  ctx.fillStyle = slider(G.hL, leftHeld());
  ctx.fillRect(0, Math.round(G.hL) - 2, RAIL, 5);
  ctx.fillStyle = slider(G.hR, rightHeld());
  ctx.fillRect(W - RAIL, Math.round(G.hR) - 2, RAIL, 5);

  // holes
  const blinkOn = reduceMotion || Math.floor(G.clock * 2.5) % 2 === 0;
  for (const h of G.level.holes) {
    if (h.goal) {
      disc(h.x, h.y, h.r + 2, blinkOn ? PAL.accent : PAL.rim);
      disc(h.x, h.y, h.r, PAL.hole);
      disc(h.x, h.y, 1, PAL.accent);
    } else {
      disc(h.x, h.y, h.r + 1, PAL.rim);
      disc(h.x, h.y, h.r, PAL.hole);
    }
  }

  // bar
  ctx.fillStyle = PAL.ink;
  for (let x = RAIL; x < W - RAIL; x++) ctx.fillRect(x, Math.round(barY(x)), 1, 2);

  // ball
  if (G.state === 'drop' || G.state === 'won') {
    const p = Math.min(1, G.anim / DROP_TIME);
    const x = G.animFrom.x + (G.animHole.x - G.animFrom.x) * p;
    const y = G.animFrom.y + (G.animHole.y - G.animFrom.y) * p;
    disc(x, y, BALL_R * (1 - p * 0.75), G.state === 'won' ? PAL.accent : PAL.ink);
  } else if (G.state !== 'reset') {
    const by = ballY();
    disc(G.bx, by, BALL_R, PAL.ink);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(G.bx) - 2, Math.round(by) - 2, 1, 1);
  }
}

// ---------- HUD / overlay ----------
let lastHud = '';
function updateHud() {
  const s = `${G.t.toFixed(1)}s|${G.drops}`;
  if (s === lastHud) return;
  lastHud = s;
  $('hudTime').textContent = `${G.t.toFixed(1)}s`;
  $('hudDrops').textContent = dropsText(G.drops);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label, onClick, cls = 'btn small') {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => onClick());
  return b;
}

// The result card for 'won' and 'lost'.
function renderOverlay(result) {
  overlay.replaceChildren();
  if (G.paused) return overlay.append(el('div', 'tag', 'PAUSED · P TO RESUME'));
  if (G.state === 'ready') return overlay.append(el('div', 'tag blink', 'HOLD J / K'));
  if (!result || !isOver()) return;

  const lost = G.state === 'lost';
  const card = el('div', 'card');
  if (lost) {
    card.append(el('div', 'big lose', 'TOPPED OUT'), el('div', 'sub', 'the bar hit the ceiling'));
  } else {
    card.append(el('div', 'big', isDailySeed(G.level.seed) ? 'DAILY CLEAR' : 'CLEAR!'));
  }
  card.append(el('div', 'stat', `${G.t.toFixed(1)}s · ${dropsText(G.drops)}`));
  if (!lost) {
    card.append(result.isBest
      ? el('div', 'new', result.prev ? `NEW BEST (was ${result.prev.t}s)` : 'FIRST CLEAR')
      : el('div', 'sub', `best ${result.prev.t}s`));
  }

  const btns = el('div', 'btns');
  if (!lost) btns.append(button('SHARE', share));
  btns.append(button('REPLAY R', restart), button(lost ? 'NEW N' : 'NEXT N', newLevel));
  card.append(btns);
  overlay.append(card);
}

let toastTimer = 0;
function toast(msg) {
  $('toast').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 2200);
}

// ---------- social ----------
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch (e) { $('seedInput').value = text; $('seedInput').select(); toast('copy blocked - text is in the box'); }
}

// Link that opens this exact level in a browser (works on phones and without the extension).
const seedLink = (seed) => (LINKS.site ? `${LINKS.site}?seed=${encodeURIComponent(seed)}` : '');

function share() {
  const seed = G.level.seed;
  const label = isDailySeed(seed) ? `daily ${seed}` : seed;
  const b = bests[seed];
  const text = b
    ? `TILT UP · ${label} · ${b.t}s, ${dropsText(b.drops)}. beat it?`
    : `TILT UP · ${label} · can you clear it?`;
  const link = seedLink(seed);
  copyText(link ? `${text} ${link}` : text, 'challenge copied');
}

// ---------- saved seeds ----------
function renderSaved() {
  const ul = $('savedList');
  ul.replaceChildren();
  if (!saved.length) { ul.append(el('li', 'empty', 'SAVE a seed to keep it here')); return; }
  for (const item of saved) {
    const li = el('li');
    const play = button(item.seed, () => loadLevel(item.seed), 's');
    play.title = 'play';
    const b = bests[item.seed];
    const x = button('×', async () => {
      saved = saved.filter((v) => v.seed !== item.seed);
      await store.set('tu_saved', saved);
      renderSaved();
    }, 'x');
    x.title = 'remove';
    x.setAttribute('aria-label', `remove ${item.seed}`);
    li.append(play, el('span', 't', b ? `${b.t}s` : '--'), x);
    ul.append(li);
  }
}

async function saveCurrent() {
  const seed = G.level.seed;
  if (saved.some((v) => v.seed === seed)) { toast('already saved'); return; }
  saved.unshift({ seed, at: Date.now() });
  saved = saved.slice(0, 30);
  await store.set('tu_saved', saved);
  renderSaved();
  toast('saved');
}

// ---------- pause / quick exit ----------
// A finished round (won/lost) can't be paused: its result card would be replaced and lost.
function setPaused(p) {
  if (isOver()) return;
  G.paused = p;
  renderOverlay();
}

function quickExit() {
  // Pause first (with its overlay): a web page can't close itself, and window.close() can
  // silently fail on a plain file:// page, so the game must never be left frozen without a PAUSED tag.
  setPaused(true);
  if (isWeb) return;
  store.set('tu_last', G.level.seed);
  if (isTab && ext) chrome.tabs.getCurrent((t) => (t ? chrome.tabs.remove(t.id) : window.close()));
  else window.close();
}

// ---------- input ----------
function syncPads() {
  $('padJ').classList.toggle('on', leftHeld());
  $('padK').classList.toggle('on', rightHeld());
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  // Leave browser shortcuts alone (Ctrl+D bookmark, Ctrl+N new window, Ctrl+J downloads, Ctrl+R reload).
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  keys.shift = e.shiftKey;
  // e.code is the physical key, so J/K work on any keyboard layout (AZERTY, Cyrillic, ...).
  if (e.code === 'KeyJ' || e.code === 'KeyK') {
    e.preventDefault();
    keys[e.code === 'KeyJ' ? 'j' : 'k'] = true;
    if (G.paused) setPaused(false);
  } else if (e.repeat) {
    return;
  } else if (e.code === 'KeyR') restart();
  else if (e.code === 'KeyN') newLevel();
  else if (e.code === 'KeyD') daily();
  else if (e.code === 'KeyP') setPaused(!G.paused);
  else if (e.key === 'Escape') quickExit();
  syncPads();
});

document.addEventListener('keyup', (e) => {
  keys.shift = e.shiftKey;
  if (e.code === 'KeyJ') keys.j = false;
  if (e.code === 'KeyK') keys.k = false;
  syncPads();
});

function bindPad(id, flag) {
  const pad = $(id);
  const on = (e) => { e.preventDefault(); pad.setPointerCapture?.(e.pointerId); keys[flag] = true; if (G.paused) setPaused(false); syncPads(); };
  const off = () => { keys[flag] = false; syncPads(); };
  pad.addEventListener('pointerdown', on);
  pad.addEventListener('pointerup', off);
  pad.addEventListener('pointercancel', off);
  pad.addEventListener('lostpointercapture', off);
}
bindPad('padJ', 'padJ');
bindPad('padK', 'padK');

// Auto-pause whenever the game loses focus (switching tabs/windows), including mid-drop, so the timer stops.
const autoPause = () => { if (G.state !== 'ready') setPaused(true); };
window.addEventListener('blur', () => {
  keys.j = keys.k = keys.padJ = keys.padK = keys.shift = false;
  syncPads();
  autoPause();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });

$('btnDaily').addEventListener('click', daily);
$('btnNew').addEventListener('click', newLevel);
$('btnReplay').addEventListener('click', restart);
$('btnShare').addEventListener('click', share);
$('btnSave').addEventListener('click', saveCurrent);
const loadFromInput = () => {
  const seed = extractSeed($('seedInput').value);
  if (!seed) { toast('enter a seed'); return; }
  $('seedInput').value = '';
  $('seedInput').blur();
  loadLevel(seed);
};
// Pasting a seed, challenge or link loads it straight away: into the seed box, or anywhere
// on the page (Ctrl+V while playing). Text with no recognizable seed in it is left alone,
// so a stray clipboard doesn't become a level; in the box it can still be loaded with GO.
document.addEventListener('paste', (e) => {
  const inBox = e.target === $('seedInput');
  if (!inBox && e.target.matches && e.target.matches('input, select, textarea')) return;
  const seed = findSeed(e.clipboardData && e.clipboardData.getData('text'));
  if (!seed) { if (!inBox) toast('no seed in that paste'); return; }
  e.preventDefault();
  $('seedInput').value = '';
  $('seedInput').blur();
  loadLevel(seed);
  toast(`loaded ${seed}`);
});
$('btnLoad').addEventListener('click', loadFromInput);
$('seedInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFromInput(); });
$('diff').addEventListener('change', () => { store.set('tu_diff', $('diff').value); $('diff').blur(); });
$('btnTab').addEventListener('click', () => {
  if (!ext) return window.open('index.html?tab=1', '_blank');
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html?tab=1') });
  window.close();
});

// ---------- loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(1 / 30, (now - last) / 1000);
  last = now;
  update(dt);
  draw();
  updateHud();
  requestAnimationFrame(frame);
}

(async function init() {
  // Storage is checked before use: a damaged value must not stop the game from starting.
  const b = await store.get('tu_bests', {});
  bests = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  const s = await store.get('tu_saved', []);
  saved = Array.isArray(s) ? s.filter((v) => v && typeof v.seed === 'string') : [];
  const diff = await store.get('tu_diff', 'N');
  if (DIFFS[diff]) $('diff').value = diff;
  renderSaved();
  // A daily left over from an earlier day is swapped for today's, so "DAILY" always means today.
  let lastSeed = await store.get('tu_last', dailySeed());
  if (typeof lastSeed !== 'string' || isDailySeed(lastSeed)) lastSeed = dailySeed();
  // A shared link (?seed=N-XXXXXX) opens that level, even over the saved one.
  const linked = params.get('seed') && extractSeed(params.get('seed'));
  loadLevel(linked || lastSeed);
  if (isWeb && LINKS.store) {
    // utm_source lets the store dashboard count installs that came from the web version.
    $('getExt').href = `${LINKS.store}?utm_source=web&utm_medium=play_page`;
    $('getExt').hidden = false;
  }
  requestAnimationFrame(frame);
})();

