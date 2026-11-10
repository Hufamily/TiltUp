// Uploads dist/tilt-up-<version>.zip to the Chrome Web Store and submits it for review (API v2).
// The item must already exist: the very first upload is done by hand in the dashboard (see docs/RELEASING.md).
//
//   node tools/publish.mjs              upload + submit for review (publishes automatically once approved)
//   node tools/publish.mjs --staged     upload + submit, but hold after approval until you press Publish
//   node tools/publish.mjs --upload-only
//   node tools/publish.mjs --status     show what the store currently has
//
// Credentials come from environment variables (GitHub Actions secrets in CI, or a git-ignored .env locally):
//   CWS_PUBLISHER_ID, CWS_ITEM_ID                         always
//   CWS_SERVICE_ACCOUNT_JSON                              the service account's JSON key (recommended), or
//   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN   an OAuth client + refresh token
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, DIST, manifest } from './lib/project.mjs';

// Local convenience: read KEY=value lines from .env (git-ignored) without overriding real env vars.
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const API = 'https://chromewebstore.googleapis.com';
const args = new Set(process.argv.slice(2));
const env = (k) => process.env[k] || die(`Missing ${k}. See docs/RELEASING.md, "One-time setup".`);
function die(msg) { console.error(msg); process.exit(1); }

const b64url = (b) => Buffer.from(b).toString('base64url');
async function accessToken() {
  let body;
  if (process.env.CWS_SERVICE_ACCOUNT_JSON) {
    const sa = JSON.parse(process.env.CWS_SERVICE_ACCOUNT_JSON);
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
      iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
    }))}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
    body = { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` };
  } else {
    body = { grant_type: 'refresh_token', client_id: env('CWS_CLIENT_ID'), client_secret: env('CWS_CLIENT_SECRET'), refresh_token: env('CWS_REFRESH_TOKEN') };
  }
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams(body) });
  const j = await r.json();
  if (!r.ok) die(`Google sign-in failed: ${j.error_description || j.error || r.status}` +
    (j.error === 'invalid_grant' ? '\n(A refresh token from an OAuth app in "Testing" mode expires after 7 days. A service account avoids this.)' : ''));
  return j.access_token;
}

const item = `publishers/${env('CWS_PUBLISHER_ID')}/items/${env('CWS_ITEM_ID')}`;
const token = await accessToken();
async function call(method, path, body, headers = {}) {
  const r = await fetch(`${API}${path}`, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(`${method} ${path} failed (${r.status}): ${j.error?.message || JSON.stringify(j)}`);
  return j;
}
const status = () => call('GET', `/v2/${item}:fetchStatus`);
const showStatus = (s) => {
  const rev = (r) => (r ? `${r.state} ${(r.distributionChannels || []).map((c) => `v${c.crxVersion} @${c.deployPercentage}%`).join(', ')}` : 'none');
  console.log(`published: ${rev(s.publishedItemRevisionStatus)}\nsubmitted: ${rev(s.submittedItemRevisionStatus)}` +
    (s.takenDown ? '\nTAKEN DOWN' : '') + (s.warned ? '\nWARNED: check the dashboard' : ''));
};

if (args.has('--status')) { showStatus(await status()); process.exit(0); }

const { version } = manifest();
const zip = join(DIST, `tilt-up-${version}.zip`);
if (!existsSync(zip)) die(`${zip} not found. Run npm run build first.`);

console.log(`Uploading tilt-up-${version}.zip ...`);
let up = await call('POST', `/upload/v2/${item}:upload`, readFileSync(zip), { 'Content-Type': 'application/zip' });
for (let i = 0; i < 30 && /IN_PROGRESS/.test(up.uploadState); i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const s = await status();
  up = { ...up, uploadState: s.lastAsyncUploadState };
}
if (up.uploadState !== 'SUCCEEDED') die(`Upload did not succeed: ${up.uploadState}. Check the dashboard for details.`);
console.log(`Uploaded v${up.crxVersion || version}.`);
if (args.has('--upload-only')) process.exit(0);

const pub = await call('POST', `/v2/${item}:publish`, JSON.stringify({ publishType: args.has('--staged') ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH' }),
  { 'Content-Type': 'application/json' });
for (const w of pub.warningInfo?.warnings || []) console.log(`WARNING ${w.reason}: ${w.description}`);
console.log(`Submitted: ${pub.state}${pub.state === 'PENDING_REVIEW' ? ' (review usually takes a few hours to a few days)' : ''}`);
if (['REJECTED', 'CANCELLED'].includes(pub.state)) process.exit(1);
