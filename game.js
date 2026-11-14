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
  ink: '#e9e4d4', dim: '#6f7682', accent: '#ffb43b', cool: '#6fd3c4', danger: '#ff5d5d'
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
  t: 0, drops: 0, anim: 0, animFrom: null, animHole: null, clock: 0,
  maxRow: 0,   // hole rows the ball has climbed level with this attempt (0..level.rows.length)
  overAt: 0,   // performance.now() when the round ended (won/lost), for the retry delay
  armed: true  // false while a J/K held from before the level loaded is still down: a level only
               // starts on a fresh press, so a key held through a run's LEVEL CLEAR beat can't start it
};
let bests = {};   // seed -> { t, drops }
let saved = [];   // [{ seed, at }]
// Run mode: null, or the run in progress { code, i: current level (1-based), t: total time of
// cleared levels, drops: their drops }. The run ends at the first TOPPED OUT (the card keeps RUN set
// so R / J / K / RETRY RUN restart the same code). N, D, a saved or pasted plain seed leave the run.
let RUN = null;
let runBest = {}; // tu_runbest: { R: { n, t, code } }, best run per run schedule (one schedule so far: 'R')
const RUN_BEAT = 700; // ms between clearing a run level and loading the next
// tu_runs: this device's progress in each run, code -> { i, t, drops, cur, curDrops, mid, at }
// (cur/curDrops: time and drops already spent on level i; mid: closed mid-attempt). Kept for the
// RUNS_KEPT most recent runs. Only reopening the game (tu_last) or the SAVED list resumes a run;
// a pasted, typed or linked run code, U and R always start at level 1, so a shared code is the
// same full run for everyone. A top-out deletes the entry.
let runs = {};
const RUNS_KEPT = 10;

const barY = (x) => G.hL + (G.hR - G.hL) * (x / W);
const ballY = () => barY(G.bx) - BALL_R - 1;
const leftHeld = () => keys.j || keys.padJ;
const rightHeld = () => keys.k || keys.padK;
const isOver = () => G.state === 'won' || G.state === 'lost';
const dropsText = (n) => `${n} drop${n === 1 ? '' : 's'}`;
const roundT = (t) => Math.round(t * 10) / 10; // times are kept and shown to 0.1 s
// Instant retry after TOPPED OUT: J/K or a pad restarts the seed, but only RETRY_DELAY ms after
// the loss and only on a fresh press (never key auto-repeat), so a key held at the moment of loss can't.
const RETRY_DELAY = 400;
const canRetry = () => G.state === 'lost' && performance.now() - G.overAt >= RETRY_DELAY;

// Loads a level. A run code (R-XXXXXX) starts that run: from level 1, or with `resume` from this
// device's saved progress in it (tu_runs). `run` is passed only by the run itself. tu_last keeps the
// run code during a run, so reopening the game picks the run up where it was left.
function loadLevel(seed, run = null, resume = false) {
  seed = cleanSeed(seed) || randomSeed('N');
  if (!run && isRunCode(seed)) return startRun(seed, resume);
  RUN = run;
  G.level = generateLevel(seed);
  restart();
  $('seedText').textContent = currentCode();
  $('hudSeed').textContent = hudLabel(seed);
  store.set('tu_last', currentCode());
}

// What SAVE, SHARE and tu_last refer to: the run code during a run, otherwise the level's seed.
const currentCode = () => (RUN ? RUN.code : G.level.seed);

function startRun(code, resume = false) {
  const p = resume && runs[code];
  if (p) {
    loadLevel(runSeed(code, p.i), { code, i: p.i, t: p.t, drops: p.drops });
    // The level restarts from the bottom, but time already spent on it stays on the clock.
    // Closing mid-attempt counts as a drop, so closing the popup can't dodge a top-out for free.
    G.t = p.cur;
    G.drops = p.curDrops + (p.mid ? 1 : 0);
  } else {
    loadLevel(runSeed(code, 1), { code, i: 1, t: 0, drops: 0 });
  }
  saveRun();
}

// Saves this device's progress in the current run (see tu_runs). Called on load, every second of
// play, on pause/close, and by runCleared. A finished level (won/lost) is saved by runCleared/runOver.
function saveRun() {
  if (!RUN || isOver()) return;
  putRun(RUN.code, {
    i: RUN.i, t: RUN.t, drops: RUN.drops,
    cur: roundT(G.t), curDrops: G.drops, mid: G.state !== 'ready', at: Date.now()
  });
}
function putRun(code, p) {
  if (p) runs[code] = p; else delete runs[code];
  const keep = Object.keys(runs).sort((a, b) => runs[b].at - runs[a].at).slice(0, RUNS_KEPT);
  runs = Object.fromEntries(keep.map((k) => [k, runs[k]]));
  store.set('tu_runs', runs);
}
function newRun() { startRun(randomRunCode()); }
// R / REPLAY: replays the seed, or during a run restarts the run from level 1.
function replay() { if (RUN) startRun(RUN.code); else restart(); }

// Today's daily is just "DAILY"; an older one shows its date (MM-DD) so it isn't mistaken for today's.
function hudLabel(seed) {
  if (RUN) return `RUN ${RUN.i} · ${G.level.diff}`;
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
  G.maxRow = 0;
  G.armed = !(leftHeld() || rightHeld());
  renderOverlay();
}

function newLevel() { loadLevel(randomSeed($('diff').value)); }
function daily() { loadLevel(dailySeed()); }

// ---------- update ----------
function update(dt) {
  G.clock += dt;
  if (G.paused) return;

  if (G.state === 'ready' && G.armed && (leftHeld() || rightHeld())) {
    G.state = 'play';
    renderOverlay();
  }
  if (G.state === 'play' || G.state === 'drop' || G.state === 'reset') G.t += dt;

  if (G.state === 'play') {
    // Small physics steps (rollBall in level.js), so a fast ball can't skip over a hole between frames.
    const n = Math.ceil(dt * PHYS_HZ);
    for (let i = 0; i < n && G.state === 'play'; i++) {
      stepBar(dt / n);
      rollBall(G, G.level.diff, dt / n);
      trackRow();
      checkHoles();
      // Loss: an end of the bar hit the ceiling, so it can't go any higher.
      if (G.state === 'play' && (G.hL <= BAR_TOP || G.hR <= BAR_TOP)) lose();
    }
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

// Progress for the TOPPED OUT card: the highest hole row the ball's center has been level with.
function trackRow() {
  const by = ballY(), rows = G.level.rows;
  while (G.maxRow < rows.length && by <= rows[G.maxRow]) G.maxRow++;
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
  G.overAt = performance.now();
  const run = RUN;
  if (run) runCleared(run);
  const seed = G.level.seed;
  const prev = bests[seed];
  // Compared at the shown precision, so a "new best" is always visibly faster (no -0.0s).
  const isBest = !prev || roundT(G.t) < prev.t;
  if (isBest) {
    bests[seed] = { t: roundT(G.t), drops: G.drops };
    await store.set('tu_bests', bests);
    renderSaved();
  }
  if (!run) renderOverlay({ isBest, prev });
}

function lose() {
  G.state = 'lost';
  G.overAt = performance.now();
  keys.j = keys.k = keys.padJ = keys.padK = false;
  syncPads();
  if (RUN) return runOver();
  renderOverlay({ lost: true });
}

// A run level cleared: add its time, show a short "LEVEL N CLEAR" tag, then load the next level
// (unless the player left or restarted the run in the meantime).
function runCleared(run) {
  run.t = roundT(run.t + roundT(G.t));
  run.drops += G.drops;
  // Saved as "at the start of the next level" now, so closing during the beat loses nothing.
  putRun(run.code, { i: run.i + 1, t: run.t, drops: run.drops, cur: 0, curDrops: 0, mid: false, at: Date.now() });
  renderSaved();
  renderOverlay();
  setTimeout(() => {
    if (RUN !== run || G.state !== 'won') return;
    run.i++;
    loadLevel(runSeed(run.code, run.i), run);
  }, RUN_BEAT);
}

// The run ended (topped out). Score = levels cleared, ties broken by the lower total time.
function runOver() {
  const n = RUN.i - 1;
  const prev = runBest.R;
  putRun(RUN.code, null); // the run is over: reopening starts it again from level 1
  renderSaved();
  const isBest = n > 0 && (!prev || n > prev.n || (n === prev.n && RUN.t < prev.t));
  if (isBest) {
    runBest.R = { n, t: RUN.t, code: RUN.code };
    store.set('tu_runbest', runBest);
  }
  renderOverlay({ lost: true, run: { n, isBest, prev } });
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

  // after a top-out: a quiet dotted line at the highest row reached (no blinking)
  if (G.state === 'lost' && G.maxRow > 0) {
    ctx.fillStyle = PAL.cool;
    const y = G.level.rows[G.maxRow - 1];
    for (let x = RAIL + 1; x < W - RAIL; x += 3) ctx.fillRect(x, y, 1, 1);
  }

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
  if (G.state === 'ready') {
    // This level's own medal times, so the target is known before the clock starts.
    const [g, s, b] = levelPars(G.level);
    const box = el('div', 'ready');
    box.append(
      el('div', 'tag blink', RUN ? `LEVEL ${RUN.i} · HOLD J / K` : 'HOLD J / K'),
      el('div', 'pars', `GOLD ${g}s · SILVER ${s}s · BRONZE ${b}s`)
    );
    return overlay.append(box);
  }
  if (RUN && G.state === 'won') {
    const medal = medalFor(G.level, roundT(G.t), G.drops);
    return overlay.append(el('div', 'tag', `LEVEL ${RUN.i} CLEAR${medal ? ` · ${medal}` : ''}`));
  }
  if (result && result.run) return overlay.append(runCard(result.run));
  if (!result || !isOver()) return;

  const lost = G.state === 'lost';
  const t = roundT(G.t);
  const card = el('div', 'card');
  if (lost) {
    card.append(el('div', 'big lose', 'TOPPED OUT'), el('div', 'sub', 'the bar hit the ceiling'));
  } else {
    card.append(el('div', 'big', isDailySeed(G.level.seed) ? 'DAILY CLEAR' : 'CLEAR!'));
  }
  card.append(el('div', 'stat', `${t.toFixed(1)}s · ${dropsText(G.drops)}`));
  if (lost) {
    card.append(el('div', 'progress', `reached row ${G.maxRow} of ${G.level.rows.length}`));
  } else {
    card.append(bestLine(result, t), medalLine(medalFor(G.level, t, G.drops)));
  }

  const btns = el('div', 'btns');
  if (!lost) btns.append(button('SHARE', share));
  btns.append(saveButton(), button('REPLAY R', restart), button(lost ? 'NEW N' : 'NEXT N', newLevel));
  card.append(btns);
  if (lost) card.append(el('div', 'hint', 'J / K to retry'));
  overlay.append(card);
}

// The RUN OVER card: levels cleared in a row, their total time, and the best run on this device.
function runCard({ n, isBest, prev }) {
  const card = el('div', 'card');
  card.append(
    el('div', 'big lose', 'RUN OVER'),
    el('div', 'sub', `topped out on level ${RUN.i}`),
    el('div', 'stat', `cleared ${n} in a row`),
    el('div', 'sub', `${RUN.t.toFixed(1)}s · ${dropsText(RUN.drops)}`)
  );
  if (isBest) card.append(el('div', 'new', prev ? `NEW BEST RUN (was ${prev.n})` : 'NEW BEST RUN'));
  else if (prev) card.append(el('div', 'sub', `best run: ${prev.n} in ${prev.t.toFixed(1)}s`));
  card.append(el('div', 'progress', `level ${RUN.i}: reached row ${G.maxRow} of ${G.level.rows.length}`));
  const btns = el('div', 'btns');
  btns.append(button('SHARE', share), button('RETRY RUN R', replay), button('NEW RUN U', newRun));
  card.append(btns, el('div', 'hint', 'J / K to retry the run from level 1'));
  return card;
}

// Best-time line on the CLEAR card: first clear, new best (by how much), or how far off the best.
function bestLine({ isBest, prev }, t) {
  if (!prev) return el('div', 'new', 'FIRST CLEAR');
  const d = Math.abs(roundT(t - prev.t)).toFixed(1);
  if (isBest) return el('div', 'new', `NEW BEST −${d}s (was ${prev.t}s)`);
  return el('div', 'sub', t === prev.t ? `tied your best (${prev.t}s)` : `+${d}s off your best (${prev.t}s)`);
}

// Medal on the CLEAR card plus the next target. Each level has its own times (levelPars in level.js);
// drops add MEDAL_DROP_S each.
function medalLine(medal) {
  const pars = levelPars(G.level);
  const i = MEDALS.indexOf(medal);
  const row = el('div', 'medals');
  row.append(medal ? el('span', `medal ${medal.toLowerCase()}`, medal) : el('span', 'medal none', 'NO MEDAL'));
  if (i !== 0) {
    const next = i < 0 ? 2 : i - 1;
    row.append(el('span', 'sub', `${MEDALS[next].toLowerCase()} under ${pars[next]}s, +${MEDAL_DROP_S}s a drop`));
  }
  return row;
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

// The challenge string. findSeed() reads the seed between the first two dots, so keep that shape.
function shareText() {
  if (RUN) {
    const n = RUN.i - 1; // levels cleared so far (the whole run once it's over)
    const text = `TILT UP · ${RUN.code} · ${n ? `cleared ${n} in a row. beat it?` : 'how far can you get?'}`;
    const link = seedLink(RUN.code);
    return link ? `${text} ${link}` : text;
  }
  const seed = G.level.seed;
  const label = isDailySeed(seed) ? `daily ${seed}` : seed;
  const b = bests[seed];
  const medal = b && medalFor(G.level, b.t, b.drops);
  const text = b
    ? `TILT UP · ${label} · ${b.t}s, ${dropsText(b.drops)}${medal ? `, ${medal.toLowerCase()} medal` : ''}. beat it?`
    : `TILT UP · ${label} · can you clear it?`;
  const link = seedLink(seed);
  return link ? `${text} ${link}` : text;
}

function share() { copyText(shareText(), RUN ? 'run copied' : 'challenge copied'); }

// ---------- saved seeds ----------
function renderSaved() {
  const ul = $('savedList');
  ul.replaceChildren();
  if (!saved.length) { ul.append(el('li', 'empty', 'SAVE a seed to keep it here')); return; }
  for (const item of saved) {
    const li = el('li');
    const play = button(item.seed, () => loadLevel(item.seed, null, true), 's');
    play.title = 'play';
    const b = bests[item.seed];
    const x = button('×', async () => {
      saved = saved.filter((v) => v.seed !== item.seed);
      await store.set('tu_saved', saved);
      renderSaved();
    }, 'x');
    x.title = 'remove';
    x.setAttribute('aria-label', `remove ${item.seed}`);
    const medal = b && medalFor(item.seed, b.t, b.drops);
    // A run code shows how far this device got in it (resumes from the SAVED list), not a time.
    const prog = !b && isRunCode(item.seed) && runs[item.seed];
    li.append(play, el('span', 't', b ? `${b.t}s` : prog ? `LV ${prog.i}` : '--'));
    if (medal) li.append(el('span', `mini ${medal.toLowerCase()}`, medal[0]));
    li.append(x);
    ul.append(li);
  }
}

const isSaved = (seed) => saved.some((v) => v.seed === seed);

async function saveCurrent() {
  const seed = currentCode();
  if (isSaved(seed)) { toast('already saved'); return; }
  saved.unshift({ seed, at: Date.now() });
  saved = saved.slice(0, 30);
  await store.set('tu_saved', saved);
  renderSaved();
  toast('saved');
}

// SAVE on the result card: keeps the finished level in the SAVED list, then shows SAVED.
function saveButton() {
  const b = button('SAVE', async () => {
    await saveCurrent();
    b.textContent = 'SAVED';
    b.disabled = true;
  });
  if (isSaved(G.level.seed)) { b.textContent = 'SAVED'; b.disabled = true; }
  b.title = 'Save this seed';
  return b;
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
  saveRun();
  if (isWeb) return;
  store.set('tu_last', currentCode());
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
    if (G.state === 'lost') {
      if (e.repeat || !canRetry()) return;
      replay();
    }
    keys[e.code === 'KeyJ' ? 'j' : 'k'] = true;
    if (G.paused) setPaused(false);
  } else if (e.repeat) {
    return;
  } else if (e.code === 'KeyR') replay();
  else if (e.code === 'KeyU') newRun();
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
  if (!leftHeld() && !rightHeld()) G.armed = true;
  syncPads();
});

function bindPad(id, flag) {
  const pad = $(id);
  const on = (e) => {
    e.preventDefault();
    if (G.state === 'lost') {
      if (!canRetry()) return;
      replay();
    }
    pad.setPointerCapture?.(e.pointerId);
    keys[flag] = true;
    if (G.paused) setPaused(false);
    syncPads();
  };
  const off = () => {
    keys[flag] = false;
    if (!leftHeld() && !rightHeld()) G.armed = true;
    syncPads();
  };
  pad.addEventListener('pointerdown', on);
  pad.addEventListener('pointerup', off);
  pad.addEventListener('pointercancel', off);
  pad.addEventListener('lostpointercapture', off);
}
bindPad('padJ', 'padJ');
bindPad('padK', 'padK');

// Auto-pause whenever the game loses focus (switching tabs/windows), including mid-drop, so the timer stops.
// Run progress is saved here too: closing the popup blurs it first.
const autoPause = () => { if (G.state !== 'ready') setPaused(true); saveRun(); };
window.addEventListener('blur', () => {
  keys.j = keys.k = keys.padJ = keys.padK = keys.shift = false;
  G.armed = true;
  syncPads();
  autoPause();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
window.addEventListener('pagehide', saveRun);

$('btnDaily').addEventListener('click', daily);
$('btnNew').addEventListener('click', newLevel);
$('btnReplay').addEventListener('click', replay);
$('btnRun').addEventListener('click', newRun);
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
let lastRunSave = 0;
function frame(now) {
  const dt = Math.min(1 / 30, (now - last) / 1000);
  last = now;
  update(dt);
  draw();
  updateHud();
  // A popup can close without a blur event reaching storage in time, so a run also saves once a second.
  if (RUN && !G.paused && G.state !== 'ready' && now - lastRunSave > 1000) { lastRunSave = now; saveRun(); }
  requestAnimationFrame(frame);
}

(async function init() {
  // Storage is checked before use: a damaged value must not stop the game from starting.
  const b = await store.get('tu_bests', {});
  bests = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  const s = await store.get('tu_saved', []);
  saved = Array.isArray(s) ? s.filter((v) => v && typeof v.seed === 'string') : [];
  const rb = await store.get('tu_runbest', {});
  const r = rb && rb.R;
  runBest = r && Number.isInteger(r.n) && r.n > 0 && Number.isFinite(r.t) && typeof r.code === 'string' ? { R: r } : {};
  const rs = await store.get('tu_runs', {});
  const okRun = (p) => p && Number.isInteger(p.i) && p.i >= 1 && [p.t, p.cur, p.at].every(Number.isFinite) &&
    Number.isInteger(p.drops) && Number.isInteger(p.curDrops);
  runs = rs && typeof rs === 'object' && !Array.isArray(rs)
    ? Object.fromEntries(Object.entries(rs).filter(([k, p]) => isRunCode(k) && okRun(p)).map(([k, p]) => [k, { ...p, mid: !!p.mid }]))
    : {};
  const diff = await store.get('tu_diff', 'N');
  if (DIFFS[diff]) $('diff').value = diff;
  renderSaved();
  // A daily left over from an earlier day is swapped for today's, so "DAILY" always means today.
  let lastSeed = await store.get('tu_last', dailySeed());
  if (typeof lastSeed !== 'string' || isDailySeed(lastSeed)) lastSeed = dailySeed();
  // A shared link (?seed=N-XXXXXX) opens that level, even over the saved one.
  const linked = params.get('seed') && extractSeed(params.get('seed'));
  // A link always starts from level 1; reopening the game resumes the last run (if it was one).
  if (linked) loadLevel(linked);
  else loadLevel(lastSeed, null, true);
  if (isWeb && LINKS.store) {
    // utm_source lets the store dashboard count installs that came from the web version.
    $('getExt').href = `${LINKS.store}?utm_source=web&utm_medium=play_page`;
    $('getExt').hidden = false;
  }
  requestAnimationFrame(frame);
})();

