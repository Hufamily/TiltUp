// Builds everything that gets published:
//   dist/tilt-up-<version>.zip   the extension package to upload to the Chrome Web Store
//   dist/web/                    the playable web version (deployed to GitHub Pages)
// Runs the store check and the solvability check first and stops if either fails.
// Usage: node tools/build.mjs [--skip-checks]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, DIST, shipFiles, manifest, links } from './lib/project.mjs';
import { writeZip } from './lib/zip.mjs';

const run = (script, ...args) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`\n${script} failed; nothing was built.`); process.exit(1); }
};
if (!process.argv.includes('--skip-checks')) {
  run('store-check.mjs');
  run('sim-check.mjs', '500');
}

const { version, name, description } = manifest();
mkdirSync(DIST, { recursive: true });

// ---- extension zip ----
const zipPath = join(DIST, `tilt-up-${version}.zip`);
const files = shipFiles();
writeZip(zipPath, files.map((f) => ({ name: f, data: readFileSync(join(ROOT, f)) })));
console.log(`\nBuilt dist/tilt-up-${version}.zip (${files.length} files)`);

// ---- web version ----
// Same game files minus the manifest, plus everything in web/ (privacy page, link-preview image).
const WEB = join(DIST, 'web');
rmSync(WEB, { recursive: true, force: true });
mkdirSync(join(WEB, 'icons'), { recursive: true });
for (const f of files) if (f !== 'manifest.json' && f !== 'index.html') copyFileSync(join(ROOT, f), join(WEB, f));
for (const f of readdirSync(join(ROOT, 'web'))) copyFileSync(join(ROOT, 'web', f), join(WEB, f));

// index.html gets link-preview tags (what Instagram/iMessage/Discord show when the link is pasted).
const site = links().site || '';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const head = [
  `<meta name="description" content="${esc(description)}">`,
  `<meta property="og:title" content="Tilt Up">`,
  `<meta property="og:description" content="${esc(description)}">`,
  `<meta property="og:type" content="website">`,
  site && `<meta property="og:url" content="${esc(site)}">`,
  site && `<meta property="og:image" content="${esc(site)}og.jpg">`,
  `<meta name="twitter:card" content="summary_large_image">`,
  `<meta name="theme-color" content="#121418">`,
  `<link rel="icon" href="icons/icon32.png">`,
  `<link rel="apple-touch-icon" href="icons/icon128.png">`
].filter(Boolean).map((l) => `  ${l}`).join('\n');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
  .replace('<title>Tilt Up</title>', `<title>Tilt Up - free tiny arcade game</title>\n${head}`);
writeFileSync(join(WEB, 'index.html'), html);
writeFileSync(join(WEB, 'version.txt'), `${name} ${version}\n`);
console.log(`Built dist/web/ (${site ? `for ${site}` : 'links.js has no site URL yet, so link previews have no image'})`);
