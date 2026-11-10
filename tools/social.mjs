// Instagram content generator. Renders post-ready images from the real game plus a caption file.
//
//   node tools/social.mjs                    next 7 days of Daily cards (story + feed post each)
//   node tools/social.mjs --days 14          a different number of days
//   node tools/social.mjs --from 2026-12-01  start from another date
//   node tools/social.mjs --seed H-7K3QZ2 --time 24.3 [--drops 1]
//                                            a "beat my time" challenge card for one level
//
// Output: marketing/out/<date or seed>/  story.jpg (1080x1920), post.jpg (1080x1350), caption.txt
// The folder is git-ignored: images are regenerated from the seed whenever needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { launch } from './lib/chrome.mjs';
import { ROOT, links, loadLevel } from './lib/project.mjs';
import { boardDataUrl, titleBlock, BG, PANEL, LINE, INK, DIM, ACCENT, COOL, FONT } from './lib/cards.mjs';

const { values: opt } = parseArgs({ options: {
  days: { type: 'string', default: '7' }, from: { type: 'string' },
  seed: { type: 'string' }, time: { type: 'string' }, drops: { type: 'string', default: '0' }
} });
const OUT = join(ROOT, 'marketing', 'out');
const L = loadLevel();
const site = links().site;
// UTM tags let you tell Instagram traffic apart in the Chrome Web Store dashboard.
const playLink = (seed, medium) => site ? `${site}?seed=${seed}&utm_source=instagram&utm_medium=${medium}` : '(set site in links.js)';
const HASHTAGS = '#tiltup #browsergame #chromeextension #pixelart #arcade #indiegame #dailychallenge #retrogaming';
const DIFF_NAME = { E: 'EASY', N: 'NORMAL', H: 'HARD' };

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pretty = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
// Stories keep clear of the area Instagram covers with its own UI (~250px top, ~300px bottom).
// One layout for both sizes: header, the board (pixel-scaled), and a footer with the call to action.
function card({ w, h, board, kicker, headline, sub, code }) {
  const story = h > 1500;
  const boardH = Math.round(h * (story ? 0.5 : 0.6));
  const boardW = Math.round(boardH * 170 / 240);
  const u = w / 1080; // scale unit
  return `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;background:${BG};color:${INK};font-family:${FONT};
    display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:${story ? '230px 0 300px' : `${Math.round(70 * u)}px 0`};box-sizing:border-box;overflow:hidden">
    <div style="display:flex;width:${boardW + 8}px;justify-content:space-between;align-items:flex-end">
      ${titleBlock(Math.round(64 * u), '')}
      <div style="text-align:right;color:${DIM};font-size:${Math.round(30 * u)}px;letter-spacing:.12em;line-height:1.5">${kicker}</div>
    </div>
    <div style="border:${Math.round(6 * u)}px solid ${LINE};line-height:0;background:${PANEL}">
      <img src="${board}" style="width:${boardW}px;height:${boardH}px;image-rendering:pixelated;display:block"></div>
    <div style="text-align:center;display:grid;gap:${Math.round(18 * u)}px">
      <div style="font-size:${Math.round(56 * u)}px;font-weight:700;letter-spacing:.08em;color:${ACCENT}">${headline}</div>
      <div style="font-size:${Math.round(32 * u)}px;color:${DIM};letter-spacing:.06em">${sub}</div>
      <div style="font-size:${Math.round(34 * u)}px;letter-spacing:.1em">code <span style="color:${COOL};border:${Math.round(4 * u)}px solid ${LINE};padding:${Math.round(6 * u)}px ${Math.round(16 * u)}px">${code}</span></div>
    </div></body></html>`;
}

async function render(chrome, dir, seed, text) {
  mkdirSync(dir, { recursive: true });
  const board = await boardDataUrl(chrome, seed);
  for (const [file, w, h] of [['story.jpg', 1080, 1920], ['post.jpg', 1080, 1350]]) {
    await chrome.size(w, h);
    await chrome.html(card({ w, h, board, ...text }));
    await chrome.shot(join(dir, file));
  }
}

const chrome = await launch();
try {
  if (opt.seed) {
    const seed = L.extractSeed(opt.seed);
    const lv = L.generateLevel(seed);
    const t = opt.time ? `${Number(opt.time).toFixed(1)}s` : null;
    const drops = Number(opt.drops);
    const dir = join(OUT, seed);
    await render(chrome, dir, seed, {
      kicker: `${DIFF_NAME[lv.diff]}<br>CHALLENGE`,
      headline: t ? `BEAT ${t}` : 'CAN YOU CLEAR IT?',
      sub: t ? `${drops} drop${drops === 1 ? '' : 's'} · tilt the bar, sink the lit hole` : 'tilt the bar, sink the lit hole',
      code: seed
    });
    writeFileSync(join(dir, 'caption.txt'),
      `${t ? `Cleared ${seed} in ${t}. Your turn.` : `New ${DIFF_NAME[lv.diff].toLowerCase()} level: ${seed}. Can you clear it?`}\n` +
      `Play it free in your browser (link in bio) or paste the code into Tilt Up.\n\n${HASHTAGS}\n\n` +
      `Link sticker / bio link:\n${playLink(seed, 'challenge')}\n`);
    console.log(`wrote marketing/out/${seed}/ (story.jpg, post.jpg, caption.txt)`);
  } else {
    const start = opt.from ? new Date(`${opt.from}T12:00:00`) : new Date();
    if (isNaN(start)) throw new Error(`--from must be YYYY-MM-DD, got ${opt.from}`);
    const days = Math.max(1, Math.min(60, Number(opt.days) || 7));
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const seed = `D-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const dir = join(OUT, isoDate(d));
      await render(chrome, dir, seed, {
        kicker: `DAILY<br>${pretty(d)}`,
        headline: "TODAY'S DAILY",
        sub: 'same level for everyone · post your time',
        code: seed
      });
      writeFileSync(join(dir, 'caption.txt'),
        `Daily level for ${pretty(d).toLowerCase()}. Same board for everyone today. Drop your time in the comments.\n` +
        `Play free in your browser: link in bio. No sign-up.\n\n${HASHTAGS}\n\n` +
        `Story link sticker:\n${playLink(seed, 'story')}\n`);
      console.log(`wrote marketing/out/${isoDate(d)}/ (${seed})`);
    }
  }
} finally {
  await chrome.close();
}
