// Renders the listing images from the real game, using headless Chrome.
//   store/screenshot-1-play.jpg   1280x800  mid-climb           (Chrome Web Store)
//   store/screenshot-2-clear.jpg  1280x800  result card         (Chrome Web Store)
//   store/promo-440x280.jpg       small promo tile              (Chrome Web Store)
//   web/og.jpg                    1200x630  link-preview image  (web version: Instagram/iMessage/Discord previews)
// JPEG on purpose: the store wants images without an alpha channel.
// Usage: node tools/store-assets.mjs   (needs Chrome; set CHROME=<path> to override)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, pageUrl, wait } from './lib/chrome.mjs';
import { ROOT } from './lib/project.mjs';
import { boardDataUrl, titleBlock, BG, LINE } from './lib/cards.mjs';

const OUT = join(ROOT, 'store');
mkdirSync(OUT, { recursive: true });
const chrome = await launch();
const shot = async (rel) => { await chrome.shot(join(ROOT, rel)); console.log(`wrote ${rel}`); };

try {
  // 1. Mid-climb on a fixed seed: bar tilted partway up the board.
  await chrome.size(1280, 800);
  await chrome.goto(pageUrl('index.html', '?tab=1'), 1000);
  await chrome.eval(`localStorage.clear(); loadLevel('N-TILTUP'); G.state = 'play'; G.hL = 128; G.hR = 146; G.bx = 70; G.t = 18.4; G.drops = 1; renderOverlay();
    saved = [{ seed: 'N-TILTUP' }, { seed: 'H-7K3QZ2' }, { seed: 'E-PLAYME' }]; bests = { 'H-7K3QZ2': { t: 41.2 }, 'E-PLAYME': { t: 22.8 } }; renderSaved();
    G.paused = true;`); // paused freezes the frame; the overlay was rendered without it
  await wait(300);
  await shot('store/screenshot-1-play.jpg');

  // 2. Result card.
  await chrome.eval(`G.paused = false; G.state = 'won'; G.t = 31.7; G.drops = 1; G.anim = 1; G.animFrom = { x: G.level.goal.x, y: G.level.goal.y }; G.animHole = G.level.goal;
    bests['N-TILTUP'] = { t: 31.7, drops: 1 }; renderSaved(); renderOverlay({ isBest: true, prev: { t: 38.9 } });`);
  await wait(300);
  await shot('store/screenshot-2-clear.jpg');

  // 3. Promo tile and 4. link preview: title + a crop of the live board.
  const board = await boardDataUrl(chrome, 'N-TILTUP', { hL: 128, hR: 146, bx: 70 });
  const tile = (w, h, title, boardW) => `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;background:${BG};color:#e9e4d4;
    font-family:ui-monospace,Consolas,monospace;display:flex;align-items:center;overflow:hidden">
    <div style="flex:1;padding-left:${Math.round(w * 0.07)}px">${titleBlock(title)}</div>
    <div style="width:${boardW}px;height:${h}px;overflow:hidden;border-left:${Math.max(2, Math.round(w / 220))}px solid ${LINE}">
    <img src="${board}" style="width:${boardW}px;height:${Math.round(boardW * 240 / 170)}px;image-rendering:pixelated;display:block;margin-top:${Math.round(h * 0.02)}px"></div></body></html>`;
  await chrome.size(440, 280);
  await chrome.html(tile(440, 280, 40, 190));
  await shot('store/promo-440x280.jpg');
  await chrome.size(1200, 630);
  await chrome.html(tile(1200, 630, 92, 450));
  await shot('web/og.jpg');
} finally {
  await chrome.close();
}
