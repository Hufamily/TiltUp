// Shared facts about the project, so no tool keeps its own copy of the file list or paths.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
export const DIST = join(ROOT, 'dist');

// Everything the extension zip contains. Directories are included one level deep.
// Script load order in index.html: links.js -> level.js -> game.js.
export const SHIP = ['manifest.json', 'index.html', 'styles.css', 'links.js', 'level.js', 'game.js', 'icons'];

export const readText = (rel) => readFileSync(join(ROOT, rel), 'utf8');
export const manifest = () => JSON.parse(readText('manifest.json'));

// Expands SHIP into a flat list of project-relative paths with forward slashes.
export function shipFiles() {
  const out = [];
  for (const entry of SHIP) {
    const p = join(ROOT, entry);
    if (statSync(p, { throwIfNoEntry: false })?.isDirectory()) {
      for (const f of readdirSync(p).sort()) out.push(`${entry}/${f}`);
    } else out.push(entry);
  }
  return out;
}

// Evaluates a data script (links.js) and returns window.<name>.
export function loadWindowData(file, name) {
  const box = { window: {} };
  runInNewContext(readText(file), box);
  return box.window[name];
}

export const links = () => loadWindowData('links.js', 'TILT_LINKS') || {};

// level.js in a sandbox (generation, seeds), for Node tools.
export function loadLevel() {
  const sandbox = { module: { exports: {} }, crypto: globalThis.crypto, Math, Date };
  runInNewContext(readText('level.js'), sandbox);
  return sandbox.module.exports;
}
