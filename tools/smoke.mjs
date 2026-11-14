// End-to-end smoke test in headless Chrome. Catches "the game doesn't start" before a user does.
//   1. Extension page (file://): loads with no errors, a ?seed= deep link opens that level,
//      holding J raises the bar and starts the clock, share text includes the play link,
//      result cards (best delta, medals, row reached) and J/K/pad retry after a loss,
//      run mode (U, next derived level, RUN OVER, tu_runbest, run share/paste/deep link).
//   2. Web build (dist/web over http, phone-sized): web mode on, no sideways scroll, pads on screen.
// Usage: node tools/smoke.mjs   (run `npm run build` first for part 2; it's skipped if dist/web is missing)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, pageUrl, wait } from './lib/chrome.mjs';
import { DIST } from './lib/project.mjs';
import { serve } from './lib/static.mjs';

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };

const chrome = await launch();
const errors = [];
chrome.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
});

try {
  // ---- 1. extension page ----
  await chrome.size(600, 600);
  await chrome.goto(pageUrl('index.html', '?seed=E-SMOKE1'), 1000);
  ok(await chrome.eval(`G.level.seed`) === 'E-SMOKE1', 'deep link ?seed= opens that level');
  ok(await chrome.eval(`G.state`) === 'ready', 'game waits for first input');
  ok(await chrome.eval(`document.body.classList.contains('web')`) === false, 'file:// page is not in web mode');

  await chrome.key('keyDown', 'KeyJ');
  await wait(600);
  const s = await chrome.eval(`({ state: G.state, hL: G.hL, hR: G.hR, t: G.t })`);
  await chrome.key('keyUp', 'KeyJ');
  ok(s.state === 'play' && s.hL < s.hR && s.t > 0, `holding J raises the left end and starts the clock (${JSON.stringify(s)})`);

  ok(await chrome.eval(`(LINKS.site = 'https://example.test/', seedLink('N-ABC'))`) === 'https://example.test/?seed=N-ABC', 'share link points at ?seed=');
  ok(await chrome.eval(`extractSeed('TILT UP · H-7K3QZ2 · 24.3s. beat it? https://example.test/?seed=H-7K3QZ2')`) === 'H-7K3QZ2', 'pasted challenge with link loads the right seed');
  ok(await chrome.eval(`extractSeed('TILT UP · HELLO · 12.0s, no drops. beat it?')`) === 'HELLO', 'pasted challenge with a custom seed keeps that seed');
  ok(await chrome.eval(`extractSeed('https://example.test/?seed=E-ABC234&utm_source=x')`) === 'E-ABC234', 'pasted share link loads its seed');
  const paste = (text, target) => chrome.eval(`(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
    ${target}.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return G.level.seed;
  })()`);
  ok(await paste('TILT UP · daily D-20261101 · can you clear it?', 'document.body') === 'D-20261101', 'pasting a challenge on the page loads it');
  ok(await paste('n-paste2', "document.getElementById('seedInput')") === 'N-PASTE2', 'pasting a seed into the seed box loads it');
  ok(await paste('just some words', 'document.body') === 'N-PASTE2', 'pasting text with no seed changes nothing');

  await chrome.eval(`G.anim = 0; G.animFrom = { x: G.bx, y: ballY() }; G.animHole = G.level.goal; G.state = 'won'; renderOverlay({ isBest: true })`);
  ok(await chrome.eval(`[...document.querySelectorAll('.card .btns button')].map((b) => b.textContent).join() === 'SHARE,SAVE,REPLAY R,NEXT N'`), 'result card shows SHARE / SAVE / REPLAY / NEXT');
  ok(await chrome.eval(`(async () => {
    const b = [...document.querySelectorAll('.card .btns button')].find((x) => x.textContent === 'SAVE');
    b.click();
    await new Promise((r) => setTimeout(r, 50));
    return b.disabled && b.textContent === 'SAVED' && saved[0].seed === G.level.seed;
  })()`), 'SAVE on the result card saves the seed');

  // CLEAR card: delta vs the saved best, medal, and a share string that still pastes back to the seed.
  const clear = (t, drops) => chrome.eval(`(async () => {
    restart(); G.t = ${t}; G.drops = ${drops};
    G.anim = 0; G.animFrom = { x: G.bx, y: ballY() }; G.animHole = G.level.goal;
    await win();
    return overlay.textContent;
  })()`);
  // Medal times are per level (levelPars), so the checks are relative to this level's [gold, silver, bronze].
  const [pg, ps, pb] = await chrome.eval(`levelPars(G.level)`);
  const fx = (v) => (Math.round(v * 10) / 10).toFixed(1);
  await chrome.eval(`bests[G.level.seed] = { t: ${pg}, drops: 0 }`);
  let card = await clear(pg + 0.8, 0);
  ok(/\+0\.8s off your best/.test(card) && /SILVER/.test(card) && new RegExp(`gold under ${pg}s`).test(card), `slower clear shows how far off the best (${card})`);
  card = await clear(pg - 1.2, 0);
  ok(/NEW BEST −1\.2s/.test(card) && /GOLD/.test(card), `faster clear shows the improvement (${card})`);
  card = await clear(pg - 1.2, 8);
  ok(/tied your best/.test(card) && /NO MEDAL/.test(card), `drops cost medal time (${card})`);
  const shareStr = await chrome.eval(`shareText()`);
  ok(new RegExp(`${fx(pg - 1.2).replace('.', '\\.')}s, 0 drops, gold medal\\. beat it\\?`).test(shareStr) && await chrome.eval(`findSeed(shareText()) === G.level.seed`), `share string with a medal still pastes back to the seed (${shareStr})`);
  ok(await chrome.eval(`medalFor('N-PASTE2', ${pg} - 0.1, 0) === 'GOLD' && medalFor('N-PASTE2', ${ps} - 5.1, 1) === 'SILVER' && medalFor('N-PASTE2', ${pb}, 0) === ''`), `medal thresholds (${pg}/${ps}/${pb})`);
  const spread = await chrome.eval(`new Set(['E','N','H'].flatMap((d) => Array.from({ length: 40 }, (_, i) => d + '-' + 'ABCDEFGHJK'[i % 10] + 'MEDAL'.slice(0, 5)).map((s) => levelPars(s)[2]))).size`);
  ok(spread > 5, `each level has its own medal times (${spread} different bronze times)`);
  ok(await chrome.eval(`(restart(), new RegExp('GOLD ' + levelPars(G.level)[0] + 's').test(overlay.textContent))`), 'the ready screen shows the level\'s medal times');

  // TOPPED OUT card: row reached, then J/K retry only after the delay and only on a fresh press.
  const rows = await chrome.eval(`restart(); G.state = 'play'; G.maxRow = 3; lose(); G.level.rows.length`);
  card = await chrome.eval(`overlay.textContent`);
  ok(new RegExp(`reached row 3 of ${rows}`).test(card) && /J \/ K to retry/.test(card), `loss card shows the row reached and the retry hint (${card})`);
  await chrome.key('keyDown', 'KeyJ');
  await chrome.key('keyUp', 'KeyJ');
  ok(await chrome.eval(`G.state`) === 'lost', 'J right after a loss does not retry (held key guard)');
  await wait(450);
  await chrome.key('keyDown', 'KeyJ', { autoRepeat: true });
  ok(await chrome.eval(`G.state`) === 'lost', 'an auto-repeating J does not retry');
  await chrome.key('keyUp', 'KeyJ');
  await chrome.key('keyDown', 'KeyJ');
  const r = await chrome.eval(`({ state: G.state, t: G.t, maxRow: G.maxRow, seed: G.level.seed })`);
  await chrome.key('keyUp', 'KeyJ');
  ok((r.state === 'ready' || r.state === 'play') && r.t < 0.5 && r.maxRow === 0 && r.seed === 'N-PASTE2', `a fresh J after the delay retries the same seed (${JSON.stringify(r)})`);
  ok(await chrome.eval(`(async () => {
    restart(); G.state = 'play'; lose();
    const pad = document.getElementById('padK');
    pad.setPointerCapture = () => {}; // synthetic pointer: nothing to capture
    pad.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7 }));
    const early = G.state;
    await new Promise((res) => setTimeout(res, 450));
    pad.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7 }));
    pad.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
    return early === 'lost' && G.state !== 'lost';
  })()`), 'tapping a pad retries after a loss (after the delay)');
  ok(await chrome.eval(`(isDailySeed(dailySeed()) && !isDailySeed('D-20991231') && !isDailySeed('D-20261399'))`), 'only real, past-or-today dates count as dailies');
  ok(await chrome.eval(`findSeed('check your e-mail') === '' && findSeed('try n-7k3qz2 lol') === 'N-7K3QZ2'`), 'pasted words like e-mail are not seeds');

  // Run mode: U starts a run, a clear loads the next derived level, a top-out shows RUN OVER.
  await chrome.eval(`runBest = {}; document.activeElement && document.activeElement.blur()`);
  await chrome.key('keyDown', 'KeyU');
  await chrome.key('keyUp', 'KeyU');
  await wait(50);
  const run = await chrome.eval(`(async () => ({ code: RUN && RUN.code, i: RUN && RUN.i, seed: G.level.seed, hud: $('hudSeed').textContent,
    want: RUN && runSeed(RUN.code, 1), last: await store.get('tu_last') }))()`);
  ok(/^R-[A-HJ-NP-Z2-9]{6}$/.test(run.code) && run.i === 1 && run.seed === run.want && /^E-/.test(run.seed) && run.hud === 'RUN 1 · E' && run.last === run.code,
    `U starts a run at level 1 with the derived Easy seed (${JSON.stringify(run)})`);
  await chrome.eval(`G.state = 'play'; G.t = 12.3; G.drops = 1; G.anim = 0; G.animFrom = { x: G.bx, y: ballY() }; G.animHole = G.level.goal; win()`);
  ok(/LEVEL 1 CLEAR/.test(await chrome.eval(`overlay.textContent`)), 'clearing a run level shows a short LEVEL CLEAR tag, no card');
  await wait(900);
  const r2 = await chrome.eval(`({ i: RUN.i, seed: G.level.seed, want: runSeed(RUN.code, 2), hud: $('hudSeed').textContent, t: RUN.t, state: G.state, tag: overlay.textContent })`);
  ok(r2.i === 2 && r2.seed === r2.want && r2.hud === 'RUN 2 · E' && r2.t === 12.3 && r2.state === 'ready' && /LEVEL 2/.test(r2.tag),
    `the next run level loads by itself with the right seed and HUD (${JSON.stringify(r2)})`);
  ok(await chrome.eval(`runSeed(RUN.code, 4)[0] === 'N' && runSeed(RUN.code, 7)[0] === 'H' && runSeed(RUN.code, 5) === runSeed(RUN.code, 5)`), 'run escalates E → N → H and derivation is deterministic');
  await chrome.eval(`G.state = 'play'; G.maxRow = 2; lose()`);
  card = await chrome.eval(`overlay.textContent`);
  ok(/RUN OVER/.test(card) && /cleared 1 in a row/.test(card) && /12\.3s · 1 drop/.test(card) && /NEW BEST RUN/.test(card) && /topped out on level 2/.test(card),
    `top-out ends the run with the RUN OVER card (${card})`);
  ok(await chrome.eval(`[...document.querySelectorAll('.card .btns button')].map((b) => b.textContent).join()`) === 'SHARE,RETRY RUN R,NEW RUN U', 'RUN OVER card shows SHARE / RETRY RUN / NEW RUN');
  const rb = await chrome.eval(`(async () => { await new Promise((r) => setTimeout(r, 50)); return { stored: await store.get('tu_runbest'), code: RUN.code }; })()`);
  ok(rb.stored && rb.stored.R && rb.stored.R.n === 1 && rb.stored.R.t === 12.3 && rb.stored.R.code === rb.code, `best run saved in tu_runbest (${JSON.stringify(rb.stored)})`);
  const runShare = await chrome.eval(`shareText()`);
  ok(new RegExp(`^TILT UP · ${run.code} · cleared 1 in a row\\. beat it\\? https://example\\.test/\\?seed=${run.code}$`).test(runShare), `run share string (${runShare})`);
  await wait(450);
  await chrome.key('keyDown', 'KeyJ');
  const rr = await chrome.eval(`({ i: RUN && RUN.i, t: RUN && RUN.t, ok: G.level.seed === runSeed(RUN.code, 1), state: G.state })`);
  await chrome.key('keyUp', 'KeyJ');
  ok(rr.i === 1 && rr.t === 0 && rr.ok && rr.state !== 'lost', `J after RUN OVER restarts the run from level 1 (${JSON.stringify(rr)})`);
  await chrome.key('keyDown', 'KeyN');
  await chrome.key('keyUp', 'KeyN');
  ok(await chrome.eval(`RUN === null && !isRunCode(G.level.seed)`), 'N leaves the run');
  const pasted = await chrome.eval(`(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(runShare)});
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { code: RUN && RUN.code, i: RUN && RUN.i, seed: G.level.seed, want: runSeed(${JSON.stringify(run.code)}, 1) };
  })()`);
  ok(pasted.code === run.code && pasted.i === 1 && pasted.seed === pasted.want, `pasting the run share string starts that run (${JSON.stringify(pasted)})`);
  ok(await chrome.eval(`(loadLevel('N-PASTE2'), RUN === null && G.level.seed === 'N-PASTE2' && $('hudSeed').textContent === 'NORM N-PASTE2')`), 'a normal seed still loads (and leaves the run)');
  ok(await chrome.eval(`extractSeed('R-HELLO') === 'R-HELLO' && !isRunCode('R-HELLO') && findSeed('r-7k3qz2') === 'R-7K3QZ2'`), 'only R- plus a 6-char code is a run; other R- text stays a custom seed');

  // Run progress lives on this device only: reopening resumes it, a shared code starts at level 1.
  const code = run.code;
  await chrome.eval(`loadLevel(${JSON.stringify(code)}); G.state = 'play'; G.t = 9; G.anim = 0; G.animFrom = { x: G.bx, y: ballY() }; G.animHole = G.level.goal; win()`);
  await chrome.key('keyDown', 'KeyJ'); // held through the LEVEL CLEAR beat
  await wait(900);
  await chrome.key('keyDown', 'KeyJ', { autoRepeat: true });
  await wait(100);
  const held = await chrome.eval(`({ i: RUN.i, state: G.state })`);
  await chrome.key('keyUp', 'KeyJ');
  ok(held.i === 2 && held.state === 'ready', `a key held through the beat does not start the next level (${JSON.stringify(held)})`);
  await chrome.key('keyDown', 'KeyJ');
  await wait(100);
  await chrome.key('keyUp', 'KeyJ');
  ok(await chrome.eval(`G.state`) === 'play', 'a fresh J press starts the next run level');
  await chrome.eval(`setPaused(true); G.t = 5; saveRun()`); // closed mid-attempt on level 2
  await wait(50);
  await chrome.goto(pageUrl('index.html'), 1000);
  const res = await chrome.eval(`({ code: RUN && RUN.code, i: RUN && RUN.i, runT: RUN && RUN.t, t: G.t, drops: G.drops, state: G.state })`);
  ok(res.code === code && res.i === 2 && res.runT === 9 && res.t === 5 && res.drops === 1 && res.state === 'ready',
    `reopening resumes the run on its level, keeping time; closing mid-attempt counts as a drop (${JSON.stringify(res)})`);
  await chrome.eval(`loadLevel('N-PASTE2')`);
  ok(/LV 2/.test(await chrome.eval(`(saved = [{ seed: ${JSON.stringify(code)}, at: 1 }], renderSaved(), $('savedList').textContent)`)), 'the SAVED list shows how far this device got in a run');
  ok(await chrome.eval(`($('savedList').querySelector('button.s').click(), RUN && RUN.i === 2)`), 'playing a run from SAVED resumes it');
  await chrome.goto(pageUrl('index.html', `?seed=${code}`), 1000);
  ok(await chrome.eval(`RUN && RUN.code === ${JSON.stringify(code)} && RUN.i === 1 && RUN.t === 0 && G.t === 0`), 'a shared run link starts from level 1');
  const gone = await chrome.eval(`(async () => { G.state = 'play'; lose(); await new Promise((r) => setTimeout(r, 50)); return !runs[RUN.code] && !(await store.get('tu_runs', {}))[RUN.code]; })()`);
  ok(gone, 'a top-out clears the run\'s saved progress');

  await chrome.eval(`window.close = () => {}; G.state = 'play'; quickExit()`); // stub: close() is a no-op on file:// pages
  ok(await chrome.eval(`G.paused && /PAUSED/.test(overlay.textContent)`), 'Esc on a page that cannot close shows PAUSED instead of freezing');

  await chrome.goto(pageUrl('index.html', '?seed=R-SMKRUN'), 1000);
  ok(await chrome.eval(`RUN && RUN.code === 'R-SMKRUN' && RUN.i === 1 && G.level.seed === runSeed('R-SMKRUN', 1) && $('hudSeed').textContent === 'RUN 1 · E'`), 'deep link ?seed=R-... starts that run');
  await chrome.goto(pageUrl('index.html', '?seed=H-SMOKE2'), 1000);
  ok(await chrome.eval(`RUN === null && G.level.seed === 'H-SMOKE2'`), 'deep link with a normal seed still opens that level');

  // ---- 2. web build at phone size ----
  const WEB = join(DIST, 'web');
  if (!existsSync(join(WEB, 'index.html'))) console.log('SKIP  web build (run npm run build first)');
  else {
    const server = await serve(WEB);
    const port = server.address().port;
    await chrome.size(390, 844, true);
    await chrome.goto(`http://127.0.0.1:${port}/?seed=D-20261110`, 1200);
    ok(await chrome.eval(`document.body.classList.contains('web')`), 'web build runs in web mode');
    ok(await chrome.eval(`G.level.seed`) === 'D-20261110', 'web deep link opens the daily');
    const lay = await chrome.eval(`({ sw: document.documentElement.scrollWidth, w: innerWidth,
      pads: document.querySelector('.pads').getBoundingClientRect().bottom, h: innerHeight,
      canvas: document.getElementById('game').getBoundingClientRect().width })`);
    ok(lay.sw <= lay.w, `no sideways scroll on a phone (${lay.sw} <= ${lay.w})`);
    ok(lay.pads <= lay.h, `touch pads visible without scrolling (bottom ${Math.round(lay.pads)} <= ${lay.h})`);
    ok(lay.canvas >= 250, `board is big enough to play (${Math.round(lay.canvas)}px wide)`);
    await chrome.goto(`http://127.0.0.1:${port}/privacy.html`, 500);
    ok(/collects no personal information/.test(await chrome.eval(`document.body.innerText`)), 'privacy page served');
    server.close();
  }

  ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await chrome.close();
}
console.log(failed ? `\n${failed} smoke check(s) failed.` : '\nSmoke test passed.');
process.exit(failed ? 1 : 0);
