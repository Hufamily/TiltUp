// Pre-submission lint for the Chrome Web Store. Mirrors the common review rejections:
//   Blue Argon  (remotely hosted code)       -> no external script/style/font URLs, no eval/new Function
//   Purple Potassium (excessive permissions) -> every permission declared is actually used
//   Yellow Zinc (metadata)                   -> name/description limits, icons present and correct size
//   MV3 CSP                                  -> no inline <script> or on* handlers in HTML
// Usage: node tools/store-check.mjs   (exit code 1 on any FAIL)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ROOT, SHIP } from './lib/project.mjs';

const results = [];
const pass = (m) => results.push(['PASS', m]);
const fail = (m) => results.push(['FAIL', m]);
const warn = (m) => results.push(['WARN', m]);

const files = [];
for (const entry of SHIP) {
  const p = join(ROOT, entry);
  if (!existsSync(p)) { fail(`missing shipped file: ${entry}`); continue; }
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) files.push(join(p, f));
  else files.push(p);
}
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');
const text = (p) => readFileSync(p, 'utf8');

// ---- manifest ----
const m = JSON.parse(text(join(ROOT, 'manifest.json')));
m.manifest_version === 3 ? pass('manifest_version 3') : fail('manifest_version must be 3');
m.name && m.name.length <= 75 ? pass(`name length ${m.name.length}/75`) : fail('name missing or > 75 chars');
m.description && m.description.length <= 132 ? pass(`description length ${m.description.length}/132`) : fail('description missing or > 132 chars');
/^\d+(\.\d+){0,3}$/.test(m.version) ? pass(`version ${m.version}`) : fail('version must be 1-4 dot-separated integers');
if (/ice cold beer/i.test(JSON.stringify(m))) fail('manifest references "Ice Cold Beer" (trademark + alcohol reference for a kids audience)');
if (m.content_security_policy) warn('custom CSP present: make sure it does not loosen script-src');
if (m.host_permissions?.length) fail(`host_permissions requested (${m.host_permissions}) - game needs none`);

// icons
function pngSize(p) { const b = readFileSync(p); return b.toString('ascii', 1, 4) === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; }
for (const [size, path] of Object.entries(m.icons || {})) {
  const p = join(ROOT, path);
  if (!existsSync(p)) { fail(`icon ${path} missing`); continue; }
  const dim = pngSize(p);
  dim && dim[0] == size && dim[1] == size ? pass(`icon ${size}px ok`) : fail(`icon ${path} is not a ${size}x${size} PNG`);
}
if (!m.icons?.['128']) fail('128px icon required for the store');

// permissions are used
const js = files.filter((f) => extname(f) === '.js').map(text).join('\n');
const permUse = { storage: /chrome\.storage/, tabs: /chrome\.tabs\.query|\.url\b/, activeTab: /chrome\.(scripting|tabs)/, alarms: /chrome\.alarms/, scripting: /chrome\.scripting/ };
for (const perm of m.permissions || []) {
  const re = permUse[perm];
  if (!re) warn(`permission "${perm}" has no usage rule here; justify it in the dashboard`);
  else re.test(js) ? pass(`permission "${perm}" is used`) : fail(`permission "${perm}" declared but unused`);
}

// ---- code scan ----
const urlRe = /\b(?:https?:)?\/\/(?!www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}[^\s'"`)]*/gi;
for (const f of files) {
  const ext = extname(f);
  if (!['.js', '.html', '.css', '.json'].includes(ext)) continue;
  const src = text(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]/.test(src)) fail(`${rel(f)}: eval / string-to-code`);
  if (ext === 'html') {
    if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(src)) fail(`${rel(f)}: inline <script> (blocked by MV3 CSP)`);
    if (/\son[a-z]+\s*=/i.test(src)) fail(`${rel(f)}: inline on* handler (blocked by MV3 CSP)`);
    for (const [, ref] of src.matchAll(/(?:src|href)="([^"#?]+)/g)) if (!/^[a-z]+:/i.test(ref) && !existsSync(join(ROOT, ref)) && !existsSync(join(ROOT, 'web', ref))) fail(`${rel(f)}: references missing file ${ref}`);
  }
  if (ext === 'css' && /@import|url\(\s*['"]?https?:/i.test(src)) fail(`${rel(f)}: remote CSS import/url (remote fonts break offline + can trip Blue Argon)`);
  const urls = (src.match(urlRe) || []).filter((u) => !u.startsWith('//')); // skip leftover comment slashes
  // links.js holds the public links (data, not code); it gets its own https-only check below.
  if (ext !== 'json' && rel(f) !== 'links.js' && urls.length) fail(`${rel(f)}: external URL(s) ${urls.join(', ')}`);
  if (/<script[^>]+src="https?:/i.test(src)) fail(`${rel(f)}: remote script`);
}
if (!results.some(([s, msg]) => s === 'FAIL' && /eval|remote|external|inline/.test(msg))) pass('no remote code, eval, or inline scripts');

// public links: https only; warn while they're still empty
{
  let L = {};
  try { const box = { window: {} }; runInNewContext(text(join(ROOT, 'links.js')), box); L = box.window.TILT_LINKS || {}; }
  catch (e) { fail(`links.js does not evaluate: ${e.message}`); }
  for (const k of ['site', 'store']) {
    if (!L[k]) warn(`links.js: ${k} is empty (${k === 'site' ? 'shares have no play link' : 'web version shows no install button'})`);
    else if (!/^https:\/\/[^\s'"]+$/.test(L[k])) fail(`links.js: ${k} must be an https:// URL`);
    else pass(`links.js: ${k} = ${L[k]}`);
  }
  if (L.site && !L.site.endsWith('/')) fail('links.js: site must end with "/"');
}

// keep the trademarked name and beer imagery out of everything players or the store can see
for (const f of [...files, ...readdirSync(join(ROOT, 'web')).map((n) => join(ROOT, 'web', n))]) {
  if (['.js', '.html', '.css', '.json'].includes(extname(f)) && /ice\s*cold\s*beer|\bbeer\b/i.test(text(f))) fail(`${rel(f)}: mentions "Ice Cold Beer"/beer (trademark, and not a theme for this audience)`);
}

// ---- report ----
for (const [s, msg] of results) console.log(`${s.padEnd(4)}  ${msg}`);
const bad = results.filter(([s]) => s === 'FAIL').length;
console.log(bad ? `\n${bad} problem(s) - fix before submitting.` : '\nAll automated checks passed. Manual items: see docs/RELEASING.md "Store submission checklist".');
process.exit(bad ? 1 : 0);
