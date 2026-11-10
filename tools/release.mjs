// Cuts a release in one command:
//   1. checks the git tree is clean and CHANGELOG.md has notes under "## Unreleased"
//   2. bumps the version in manifest.json and package.json
//   3. moves the Unreleased notes under a "## <version> - <date>" heading
//   4. builds (store check + solvability check + zip + web build)
//   5. commits "Release v<version>" and tags v<version>
// Pushing the tag (git push --follow-tags, or pass --push) makes GitHub Actions publish it to the store.
//
// Usage: node tools/release.mjs <patch|minor|major|X.Y.Z> [--push]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/project.mjs';

const die = (m) => { console.error(m); process.exit(1); };
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const [bump] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const push = process.argv.includes('--push');
if (!bump) die('Usage: npm run release -- <patch|minor|major|X.Y.Z> [--push]');

try { git('rev-parse', '--git-dir'); } catch { die('Not a git repository.'); }
if (git('status', '--porcelain')) die('Commit or stash your changes first (git status shows uncommitted work).');

const mPath = join(ROOT, 'manifest.json'), pPath = join(ROOT, 'package.json'), cPath = join(ROOT, 'CHANGELOG.md');
const current = JSON.parse(readFileSync(mPath, 'utf8')).version;
const [a, b, c] = current.split('.').map(Number);
const next = { patch: `${a}.${b}.${(c || 0) + 1}`, minor: `${a}.${b + 1}.0`, major: `${a + 1}.0.0` }[bump] || bump;
if (!/^\d+\.\d+\.\d+$/.test(next)) die(`Not a version or bump type: ${bump}`);
const gt = (x, y) => { const p = x.split('.').map(Number), q = y.split('.').map(Number); for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] > q[i]; return false; };
if (!gt(next, current)) die(`New version ${next} must be higher than ${current} (the store rejects re-used versions).`);
try { git('rev-parse', `v${next}`); die(`Tag v${next} already exists.`); } catch { /* good: tag is free */ }

// Changelog: the notes become the release notes, so require some.
const log = readFileSync(cPath, 'utf8');
const m = log.match(/## Unreleased\s*\n([\s\S]*?)(?=\n## |\s*$)/);
if (!m || !m[1].trim()) die('CHANGELOG.md has no notes under "## Unreleased". Add a line or two about what changed.');
const d = new Date(), p = (n) => String(n).padStart(2, '0');
const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
writeFileSync(cPath, log.replace(/## Unreleased\s*\n/, `## Unreleased\n\n## ${next} - ${today}\n\n`));

// Only touch the version strings so the files keep their formatting.
const setVersion = (path) => writeFileSync(path, readFileSync(path, 'utf8').replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`));
setVersion(mPath);
setVersion(pPath);
console.log(`Version ${current} -> ${next}`);

const build = spawnSync(process.execPath, [join(ROOT, 'tools', 'build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) {
  git('checkout', '--', 'manifest.json', 'package.json', 'CHANGELOG.md');
  die('Build failed, so the version bump was undone.');
}

git('add', 'manifest.json', 'package.json', 'CHANGELOG.md');
git('commit', '-m', `Release v${next}`);
git('tag', '-a', `v${next}`, '-m', `Tilt Up v${next}`);
console.log(`\nCommitted and tagged v${next}.`);
if (push) {
  execFileSync('git', ['push', '--follow-tags'], { cwd: ROOT, stdio: 'inherit' });
  console.log('Pushed. GitHub Actions will upload it to the Chrome Web Store.');
} else {
  console.log('Next: git push --follow-tags   (GitHub Actions then uploads it to the Chrome Web Store)\n' +
    `   or: npm run publish:store       (upload dist/tilt-up-${next}.zip from this machine)`);
}
