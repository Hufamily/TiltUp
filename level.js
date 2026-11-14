'use strict';
/* Pure level logic: constants, seeded RNG, seed parsing, level generation. No DOM. */

// ---------- constants (logical pixels; canvas is drawn at 170x240 and CSS-scaled 2x) ----------
const W = 170, H = 240;
const RAIL = 4;
const BAR_BOTTOM = H - 8;
const BAR_TOP = 12;
const RAISE_SPEED = 32;     // px/s per side
const RESET_SPEED = 170;    // px/s when the bar drops back down
const MAX_TILT = 30;        // max height difference between the two ends
const BALL_R = 4;
const GRAVITY = 520;        // scaled per difficulty by DIFFS[d].speed
const TOP_ROW_Y = 22;
const BOTTOM_ROW_Y = H - 50;
const DROP_TIME = 0.35;
const PHYS_HZ = 240;        // physics substeps per second (see rollBall)

const DIFFS = {
  // speed = gravity multiplier, roll = rolling-resistance coefficient (see rollBall).
  // hole = points for sinking the goal, bonus = the bonus counter's starting value (see scoreFor).
  // speed/roll/hole/bonus are physics and scoring only: changing them does NOT change any seed's
  // board (generation uses rows/perRow/top/holeR/step).
  E: { name: 'EASY', rows: 6,  perRow: [2, 3], top: 3, holeR: 7, step: 40, speed: 1.2,  roll: 0.004, hole: 500,  bonus: 3000 },
  N: { name: 'NORM', rows: 8,  perRow: [3, 4], top: 4, holeR: 6, step: 50, speed: 1.55, roll: 0.0025, hole: 1000, bonus: 5000 },
  H: { name: 'HARD', rows: 10, perRow: [4, 5], top: 5, holeR: 6, step: 60, speed: 1.95, roll: 0.0015, hole: 1500, bonus: 8000 }
};

// ---------- seeded RNG ----------
function hashString(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- seeds ----------
// Format: <E|N|H>-<code> for random levels, D-YYYYMMDD for the daily, R-<code> for a run (see run mode).
// Any other string is a Normal level.
const SEED_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function cleanSeed(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
}

// Finds a seed inside pasted text, or returns '' if nothing in it looks like one. Understands:
//   a share link              https://.../?seed=HELLO&utm_source=x
//   a SHARE challenge         TILT UP · daily D-20261110 · 24.3s, 1 drop. beat it? <link>
//   a seed anywhere in text   "try n-7k3qz2 lol"   (chat apps' – — ‑ dashes count as -)
//                             only the generated formats (E/N/H/R + 6-char code, D-YYYYMMDD), so
//                             ordinary words like "E-MAIL" or "X-RAY" in a paste aren't mistaken for seeds
//   a seed typed with a space "N 7K3QZ2" (only when that's the whole input)
// Order matters: the link and the challenge carry custom seeds (HELLO) exactly, so they win.
const DASHES = /[‐-―−﹘﹣－]/g;
function findSeed(text) {
  const raw = String(text || '').replace(DASHES, '-');
  const link = raw.match(/[?&]seed=([^&#\s]+)/i);
  if (link) {
    let v = link[1];
    try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* keep it encoded */ }
    const s = cleanSeed(v);
    if (s) return s;
  }
  const card = raw.match(/TILT\s*UP\s*[·•|]\s*(?:DAILY\s+)?([^·•|]+?)\s*[·•|]/i);
  if (card && cleanSeed(card[1])) return cleanSeed(card[1]);
  const up = raw.toUpperCase();
  const tok = up.match(/(?:^|[^A-Z0-9])([ENHR]-[A-HJ-NP-Z2-9]{6}|D-\d{8})(?![A-Z0-9])/);
  if (tok) return tok[1];
  const spaced = up.trim().match(/^([ENHDR])[\s_]+([A-Z0-9]{3,16})$/);
  if (spaced) return `${spaced[1]}-${spaced[2]}`;
  return '';
}

// Seed box input: a recognized seed if there is one, otherwise the text itself as a custom seed.
function extractSeed(text) {
  return findSeed(text) || cleanSeed(String(text || '').replace(DASHES, '-'));
}

function seedDiff(seed) {
  const p = seed.slice(0, 2);
  if (p === 'E-') return 'E';
  if (p === 'H-') return 'H';
  return 'N';
}

function randomSeed(diff) {
  let s = '';
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  for (const v of buf) s += SEED_CHARS[v % SEED_CHARS.length];
  return `${diff}-${s}`;
}

function dailySeed() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `D-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// Only D-YYYYMMDD with a real calendar date, today or earlier, counts as a daily.
// Anything else ("D-ANYTHING", "D-20261399", a future date) is a plain Normal level, so it
// isn't labeled DAILY. (Its board still comes from the seed, like every other level.)
function isDailySeed(seed) {
  const m = /^D-(\d{4})(\d{2})(\d{2})$/.exec(seed);
  if (!m) return false;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const dt = new Date(y, mo, d);
  const real = dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d;
  return real && seed <= dailySeed(); // same-length strings, so this compares the dates
}

// ---------- level generation ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - a.x) * dx + (py - a.y) * dy) / len2, 0, 1);
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function distToPath(h, path) {
  let d = Infinity;
  for (let i = 0; i < path.length - 1; i++) d = Math.min(d, distToSegment(h.x, h.y, path[i], path[i + 1]));
  return d;
}

/*
 * Guaranteed path: first we random-walk a corridor from the goal down to the start point,
 * then place holes anywhere that keeps a ball-sized clearance from that corridor.
 * Holes elsewhere may block other routes, but the corridor always survives.
 */
function generateLevel(seed) {
  const diff = seedDiff(seed);
  const cfg = DIFFS[diff];
  const rnd = mulberry32(hashString(seed));
  const R = cfg.holeR;
  const fallR = R * 0.75;
  const clearance = fallR + BALL_R + 3;

  const rows = [];
  for (let i = 0; i < cfg.rows; i++) rows.push(Math.round(BOTTOM_ROW_Y - (BOTTOM_ROW_Y - TOP_ROW_Y) * i / (cfg.rows - 1)));

  const xMin = RAIL + R + 2, xMax = W - RAIL - R - 2;
  const pathMin = RAIL + BALL_R + 6, pathMax = W - RAIL - BALL_R - 6;

  const goal = { x: Math.round(xMin + rnd() * (xMax - xMin)), y: TOP_ROW_Y, r: R, goal: true };

  const path = [{ x: goal.x, y: goal.y }];
  let x = goal.x;
  for (let i = cfg.rows - 2; i >= 0; i--) {
    x = clamp(x + (rnd() * 2 - 1) * cfg.step, pathMin, pathMax);
    path.push({ x, y: (rows[i] + rows[i + 1]) / 2 });
  }
  x = clamp(x + (rnd() * 2 - 1) * cfg.step * 0.6, pathMin, pathMax);
  path.push({ x, y: BAR_BOTTOM - BALL_R - 1 });
  path.reverse();

  const holes = [goal];
  const fits = (h) =>
    holes.every((o) => Math.hypot(o.x - h.x, o.y - h.y) >= o.r + h.r + 3) &&
    distToPath(h, path) >= clearance;

  rows.forEach((ry, i) => {
    const isTop = i === cfg.rows - 1;
    const want = isTop ? cfg.top - 1 : cfg.perRow[0] + Math.floor(rnd() * (cfg.perRow[1] - cfg.perRow[0] + 1));
    let placed = 0;
    for (let t = 0; t < 140 && placed < want; t++) {
      const h = {
        x: Math.round(xMin + rnd() * (xMax - xMin)),
        y: ry + (isTop ? 0 : Math.round((rnd() * 2 - 1) * 3)),
        r: R,
        goal: false
      };
      if (fits(h)) { holes.push(h); placed++; }
    }
  });

  // rows: each hole row's y, bottom row first (the last one is the goal row). path: the corridor,
  // start first (used for the level's medal times). Read-only extras: they use no random numbers,
  // so boards are unchanged.
  return { seed, diff, holes, goal, rows, path, startX: Math.round(path[0].x), fallR };
}

// ---------- ball physics (shared by the game and Node tools) ----------
// A steel ball rolling on a tilted metal bar, like the real cabinets:
//   drive      g·(5/7)·sinθ along the bar (5/7: some of gravity goes into spinning a solid ball)
//   rolling    a small constant resistance roll·g·cosθ against the motion. Steel on steel is
//              tiny, so the ball keeps its momentum: to stop it you tilt the bar the other way.
//              A nearly level bar (drive below the resistance) holds a resting ball still.
//   air        a whisper of drag so very fast balls stay sane
//   end stops  the ball bounces off the side rails with BOUNCE of its speed
// b = { bx, vx, hL, hR }; updates bx and vx. Keep dt small (the game substeps at 240 Hz).
const BOUNCE = 0.45;
const AIR = 0.06;
function rollBall(b, diff, dt) {
  const cfg = DIFFS[diff];
  const g = GRAVITY * cfg.speed;
  const slope = (b.hR - b.hL) / W; // > 0 means right end is lower: ball rolls right
  const cos = 1 / Math.sqrt(1 + slope * slope);
  let v = b.vx + g * (5 / 7) * slope * cos * dt;
  v -= v * AIR * dt;
  // Rolling resistance slows the ball but never pushes it backwards: it stops at zero.
  const s = Math.sign(v);
  v -= s * g * cfg.roll * cos * dt;
  if (Math.sign(v) !== s) v = 0;
  b.vx = v;
  b.bx += v * dt;
  const lo = RAIL + BALL_R, hi = W - RAIL - BALL_R;
  if (b.bx < lo) { b.bx = lo; b.vx = Math.abs(b.vx) * BOUNCE; }
  if (b.bx > hi) { b.bx = hi; b.vx = -Math.abs(b.vx) * BOUNCE; }
  if ((b.bx === lo || b.bx === hi) && Math.abs(b.vx) < 4) b.vx = 0; // no endless tiny rattles
}

// ---------- scoring ----------
// Arcade-style: a BONUS counter starts at DIFFS[d].bonus and counts down in steps of 10 while
// you play, reaching zero at BONUS_TIME seconds. Each drop knocks DROP_COST of the starting bonus
// off. Sinking the goal scores the hole's value plus whatever bonus is left.
// Pure function of (difficulty, time, drops), so saved bests ({t, drops}) score the same way.
const BONUS_TIME = 90;
const DROP_COST = 0.1;
function bonusLeft(diff, t, drops) {
  const start = DIFFS[diff].bonus;
  const left = start * (1 - t / BONUS_TIME) - drops * start * DROP_COST;
  return Math.max(0, Math.floor(left / 10) * 10);
}
const scoreFor = (diff, t, drops) => DIFFS[diff].hole + bonusLeft(diff, t, drops);

// ---------- run mode ----------
// A run code (R-XXXXXX, 6 chars from SEED_CHARS) is a chain of ordinary seeds played back to back.
// Level i (1-based) gets runSeed(code, i): a plain E-/N-/H- seed whose 6 chars come from the seeded
// RNG on hash("R-XXXXXX/i"), so the same run code always gives the same levels for everyone.
// Escalation is only in which difficulty each level uses (runDiff); generation is untouched.
// Changing runDiff, the "/i" key or the char picking changes every shared run: version the code then (R2-).
// Only the exact R- + 6 SEED_CHARS shape is a run; anything else starting "R-" stays a custom Normal seed.
const isRunCode = (s) => /^R-[A-HJ-NP-Z2-9]{6}$/.test(s);
const runDiff = (i) => (i <= 3 ? 'E' : i <= 6 ? 'N' : 'H'); // levels 1-3 Easy, 4-6 Normal, 7+ Hard
function runSeed(code, i) {
  const rnd = mulberry32(hashString(`${code}/${i}`));
  let s = '';
  for (let k = 0; k < 6; k++) s += SEED_CHARS[Math.floor(rnd() * SEED_CHARS.length)];
  return `${runDiff(i)}-${s}`;
}
const randomRunCode = () => randomSeed('R'); // a fresh code (crypto, like randomSeed); never used for derivation

// ---------- medals ----------
// Every level has its own medal times, [gold, silver, bronze] in seconds, from its layout:
// bronze = PAR_BASE[diff] + PAR_PER_PX x the corridor's sideways travel (more weaving = more time),
// silver ~ 0.7x and gold ~ 0.5x bronze. The bases are set so the average bronze over many seeds
// matches the measured average clears (E ~30 s, N ~40 s, H ~40 s); a level's bronze ranges about
// +-4 s around that. Each drop adds MEDAL_DROP_S before comparing. Display only: no effect on seeds,
// but changing these constants changes the medal times shown for every seed.
const PAR_BASE = { E: 20, N: 24, H: 17 };
const PAR_PER_PX = 0.1;
const MEDALS = ['GOLD', 'SILVER', 'BRONZE'];
const MEDAL_DROP_S = 5;
const parCache = new Map();
function levelPars(level) {
  if (typeof level === 'string') level = generateLevel(level);
  let pars = parCache.get(level.seed);
  if (pars) return pars;
  let lat = 0;
  for (let i = 1; i < level.path.length; i++) lat += Math.abs(level.path[i].x - level.path[i - 1].x);
  const bronze = Math.round(PAR_BASE[level.diff] + lat * PAR_PER_PX);
  pars = [Math.round(bronze * 0.5), Math.round(bronze * 0.7), bronze];
  if (parCache.size > 200) parCache.clear();
  parCache.set(level.seed, pars);
  return pars;
}
// level: a generateLevel() result or a seed. Returns 'GOLD' / 'SILVER' / 'BRONZE', or '' when
// slower than bronze. Strictly under the time.
function medalFor(level, t, drops) {
  const p = t + drops * MEDAL_DROP_S;
  const i = levelPars(level).findIndex((lim) => p < lim);
  return i < 0 ? '' : MEDALS[i];
}

// Node-only export for tools/sim-check.mjs. 'module' is undefined in the extension, so this does nothing there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateLevel, rollBall, scoreFor, bonusLeft, medalFor, levelPars, DIFFS, randomSeed, dailySeed, isDailySeed, extractSeed, findSeed, isRunCode, runDiff, runSeed, randomRunCode, W, RAIL, BALL_R, TOP_ROW_Y, BAR_BOTTOM };
}
