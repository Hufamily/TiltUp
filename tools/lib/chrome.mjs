// Tiny headless-Chrome driver over the DevTools protocol (Node's built-in fetch + WebSocket).
// Used by smoke tests, store screenshots and social cards. Set CHROME=<path> to override discovery.
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './project.mjs';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const pageUrl = (file = 'index.html', query = '') => pathToFileURL(join(ROOT, file)).href + query;

export function findChrome() {
  return process.env.CHROME || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].find((p) => p && existsSync(p));
}

export async function launch() {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome not found. Install it or set CHROME=<path to chrome>.');
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = join(tmpdir(), `tilt-up-chrome-${process.pid}-${port}`);
  const proc = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });

  let tabs;
  for (let i = 0; i < 75 && !tabs; i++) {
    try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await wait(200); }
  }
  if (!tabs) { proc.kill(); throw new Error('Chrome did not start its debugging port'); }
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) for (const fn of listeners) fn(msg);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  const api = {
    send,
    on: (fn) => listeners.push(fn),
    // Evaluates an expression in the page and returns its value (awaits promises).
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
    size: (width, height, mobile = false) =>
      send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }),
    async goto(url, settle = 800) { await send('Page.navigate', { url }); await wait(settle); },
    async shot(file, format = 'jpeg') {
      const { data } = await send('Page.captureScreenshot', { format, ...(format === 'jpeg' && { quality: 95 }) });
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    // Replaces the page with a static HTML document (used to compose cards around a board image).
    async html(markup) { await api.eval(`document.open(); document.write(${JSON.stringify(markup)}); document.close();`); await wait(250); },
    async key(type, code, extra = {}) {
      const key = code.replace(/^Key/, '').toLowerCase();
      await send('Input.dispatchKeyEvent', { type, code, key, ...extra });
    },
    async close() {
      try { ws.close(); } catch { /* already closed */ }
      proc.kill();
      await wait(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold a lock; it's in temp */ }
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return api;
}
