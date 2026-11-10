// End-to-end smoke test in headless Chrome. Catches "the game doesn't start" before a user does.
//   1. Extension page (file://): loads with no errors, a ?seed= deep link opens that level,
//      holding J raises the bar and starts the clock, share text includes the play link.
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
  ok(await chrome.eval(`document.querySelectorAll('.card .btns button').length === 3`), 'result card shows SHARE / REPLAY / NEXT');
  ok(await chrome.eval(`(isDailySeed(dailySeed()) && !isDailySeed('D-20991231') && !isDailySeed('D-20261399'))`), 'only real, past-or-today dates count as dailies');
  ok(await chrome.eval(`findSeed('check your e-mail') === '' && findSeed('try n-7k3qz2 lol') === 'N-7K3QZ2'`), 'pasted words like e-mail are not seeds');
  await chrome.eval(`window.close = () => {}; G.state = 'play'; quickExit()`); // stub: close() is a no-op on file:// pages
  ok(await chrome.eval(`G.paused && /PAUSED/.test(overlay.textContent)`), 'Esc on a page that cannot close shows PAUSED instead of freezing');

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
