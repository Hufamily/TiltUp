// Verifies the "a path always exists" promise for many seeds.
// Independent of the corridor used during generation: flood-fills the free space
// (ball-center positions not over a trap hole) from the start point and checks the goal is reachable.
// Usage: node tools/sim-check.mjs [seedsPerDifficulty]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../level.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, crypto: globalThis.crypto, Math, Date };
vm.runInNewContext(code, sandbox);
const L = sandbox.module.exports;

const N = Number(process.argv[2] || 2000);
const MARGIN = 1.5; // extra px of slack the player must have around each trap

function solvable(level) {
  const xLo = L.RAIL + L.BALL_R, xHi = L.W - L.RAIL - L.BALL_R;
  const yLo = L.TOP_ROW_Y - 8, yHi = L.BAR_BOTTOM - L.BALL_R - 1;
  const w = xHi - xLo + 1, h = yHi - yLo + 1;
  const traps = level.holes.filter((o) => !o.goal);
  const free = (x, y) => traps.every((o) => Math.hypot(x - o.x, y - o.y) >= level.fallR + MARGIN);
  const seen = new Uint8Array(w * h);
  const sx = Math.round(level.startX), sy = yHi;
  if (!free(sx, sy)) return false;
  const q = [[sx, sy]];
  seen[(sy - yLo) * w + (sx - xLo)] = 1;
  while (q.length) {
    const [x, y] = q.pop();
    if (Math.hypot(x - level.goal.x, y - level.goal.y) < level.fallR) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < xLo || nx > xHi || ny < yLo || ny > yHi) continue;
      const i = (ny - yLo) * w + (nx - xLo);
      if (seen[i] || !free(nx, ny)) continue;
      seen[i] = 1;
      q.push([nx, ny]);
    }
  }
  return false;
}

let fail = 0;
const stats = {};
const seeds = [L.dailySeed(), 'HELLO', 'E-AAAAAA', 'H-ZZZZZZ'];
for (const d of ['E', 'N', 'H']) for (let i = 0; i < N; i++) seeds.push(L.randomSeed(d));

for (const s of seeds) {
  const lv = L.generateLevel(s);
  const st = (stats[lv.diff] ||= { n: 0, holes: 0 });
  st.n++; st.holes += lv.holes.length;
  // deterministic: same seed, same board
  if (JSON.stringify(L.generateLevel(s).holes) !== JSON.stringify(lv.holes)) { console.log('NONDETERMINISTIC', s); fail++; }
  if (!solvable(lv)) { console.log('UNSOLVABLE', s); fail++; }
}
for (const [d, st] of Object.entries(stats)) console.log(`${d}: ${st.n} levels, avg ${(st.holes / st.n).toFixed(1)} holes`);
console.log(fail ? `FAIL (${fail})` : `OK: all ${seeds.length} seeds solvable and deterministic`);
process.exit(fail ? 1 : 0);
