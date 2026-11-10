// Shared pieces for rendered marketing images (store tiles, link previews, Instagram cards).
// Colors match the :root tokens in styles.css.
import { pageUrl, wait } from './chrome.mjs';

export const BG = '#121418', PANEL = '#1a1d22', LINE = '#2c3139', INK = '#e9e4d4', DIM = '#6f7682', ACCENT = '#ffb43b', COOL = '#6fd3c4';
export const FONT = "ui-monospace,'Cascadia Mono',Consolas,'SF Mono',Menlo,monospace"; // single quotes: it goes inside style="..."

// Renders one frame of a seed's board from the real game and returns it as a PNG data URL.
// `pose` can place the bar and ball ({ hL, hR, bx }); by default it's the start position.
export async function boardDataUrl(chrome, seed, pose = {}) {
  await chrome.goto(pageUrl('index.html', `?tab=1&seed=${encodeURIComponent(seed)}`), 700);
  return chrome.eval(`(() => {
    Object.assign(G, ${JSON.stringify(pose)});
    G.paused = true; G.clock = 0; draw();
    return document.getElementById('game').toDataURL();
  })()`);
}

// "TILT / UP" stacked wordmark, scaled by font size in px.
export const titleBlock = (px, tagline = 'tilt the bar.<br>dodge the holes.<br>sink the lit one.') =>
  `<div style="font-size:${px}px;font-weight:700;letter-spacing:.18em;line-height:1.1">TILT<br><span style="color:${ACCENT}">UP</span></div>` +
  (tagline ? `<div style="margin-top:${Math.round(px * 0.35)}px;color:${DIM};letter-spacing:.08em;line-height:1.6;font-size:${Math.round(px * 0.3)}px">${tagline}</div>` : '');

export { wait };
