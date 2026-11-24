// פמי הנדסה - שרת החיבור התמידי ל-Google (Cloudflare Worker).
//
// Keeps each user's Google refresh token so the site never has to ask again.
// The browser signs in once per device (authorization code, popup mode) and gets
// back a random device key. From then on the site trades that key for a fresh
// one-hour access token whenever it needs one, with no popup.
//
// Storage (KV namespace TOKENS), every value encrypted with AES-GCM (ENC_KEY):
//   u:<SHA-256 of the Google email>  -> that account's refresh token
//   d:<SHA-256 of the device key>    -> which Google account the device uses
// One refresh token per Google account, shared by all of that user's devices,
// because Google hands one out only on the first consent. A leak of the KV data
// alone reveals neither device keys nor refresh tokens.
//
// Settings (wrangler.toml / `wrangler secret put`):
//   GOOGLE_CLIENT_ID      the same OAuth Client ID as in google-config.js
//   GOOGLE_CLIENT_SECRET  secret, from the same OAuth client
//   ENC_KEY               secret, any long random string (e.g. 32 random bytes in base64)
//   ALLOWED_ORIGINS       comma separated, e.g. https://femiengineering.github.io
//
// Background Drive sync (no user signed in to Google): every 15 minutes (cron trigger) the worker
// reads the company's Drive with its own Google service account and keeps a copy in KV:
//   sync:drive  { at, root, files, folders }  the protocol documents in the projects folder and every
//               folder above them, for FemyDriveProtocols.buildItems() on the site
//   sync:sheet  the tasks sheet ("משימות פמי") exported as .xlsx, for FemySheet on the site
// The site reads them with GET /data/drive and GET /data/sheet, and POST /data/refresh syncs now.
//   GOOGLE_SERVICE_ACCOUNT_KEY  secret, the service account's JSON key file, pasted whole
//   PROJECTS_FOLDER_ID          the "פרויקטים פמי" folder (shared with the service account)
//   TASKS_SHEET_ID              the "משימות פמי" sheet (shared with the service account)

import DP from '../../drive-protocols.js';

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const GMAIL_PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

export default {
  // Cron trigger (wrangler.toml [triggers]): the background Drive sync.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncDrive(env).catch((e) => console.error('femy-google sync: ' + (e && e.stack || e))));
  },

  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Expose-Headers': 'X-Synced-At', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
      : null;
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors || {}) });

    if (!cors) return reply(403, { error: 'origin_not_allowed' });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const path = new URL(req.url).pathname;
    try {
      if (req.method === 'GET' && path === '/data/drive') {
        const d = await env.TOKENS.get('sync:drive');
        if (!d) return reply(404, { error: (await syncError(env)) || 'no_data' });
        return new Response(d, { headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors) });
      }
      if (req.method === 'GET' && path === '/data/sheet') {
        const { value, metadata } = await env.TOKENS.getWithMetadata('sync:sheet', 'arrayBuffer');
        if (!value) return reply(404, { error: (await syncError(env)) || 'no_data' });
        return new Response(value, { headers: Object.assign({ 'Content-Type': XLSX, 'Cache-Control': 'no-store', 'X-Synced-At': String((metadata && metadata.at) || '') }, cors) });
      }
      if (req.method === 'GET' && path === '/data/status') return reply(200, JSON.parse((await env.TOKENS.get('sync:status')) || '{}'));
      if (req.method === 'POST' && path === '/data/refresh') return reply(...(await refresh(env)));
    } catch (e) {
      console.error('femy-google ' + path + ': ' + (e && e.stack || e));
      return reply(500, { error: 'server_error' });
    }
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });

    let body;
    try { body = await req.json(); } catch (e) { return reply(400, { error: 'bad_json' }); }
    try {
      if (path === '/exchange') return reply(...(await exchange(env, body)));
      if (path === '/token') return reply(...(await token(env, body)));
      if (path === '/revoke') return reply(...(await revoke(env, body)));
      if (path === '/forget') return reply(...(await forget(env, body)));
      return reply(404, { error: 'not_found' });
    } catch (e) {
      console.error('femy-google ' + path + ': ' + (e && e.stack || e));
      return reply(500, { error: 'server_error' });
    }
  },
};

// First sign-in on a device: trade the authorization code for tokens and keep the refresh token.
async function exchange(env, { code }) {
  if (!code || typeof code !== 'string') return [400, { error: 'missing_code' }];
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: 'postmessage', grant_type: 'authorization_code' }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) return [400, { error: t.error || 'exchange_failed' }];
  let email = '';
  try { email = String((await (await fetch(GMAIL_PROFILE, { headers: { Authorization: 'Bearer ' + t.access_token } })).json()).emailAddress || '').toLowerCase(); } catch (e) { /* handled below */ }
  if (!email) return [502, { error: 'no_email' }];
  const ukey = 'u:' + await hash(email);
  if (t.refresh_token) {
    await env.TOKENS.put(ukey, await seal(env, JSON.stringify({ rt: t.refresh_token, at: Date.now() })));
  } else if (!(await env.TOKENS.get(ukey))) {
    // Google gives a refresh token only on a fresh consent, and we have none for this
    // account. Dropping the old grant makes the next sign-in ask again, with one.
    await fetch(GOOGLE_REVOKE + '?token=' + encodeURIComponent(t.access_token), { method: 'POST' }).catch(() => {});
    return [409, { error: 'no_refresh_token' }];
  }
  const device = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.TOKENS.put('d:' + await hash(device), await seal(env, JSON.stringify({ email, at: Date.now() })));
  return [200, { device, access_token: t.access_token, expires_in: t.expires_in, scope: t.scope, email }];
}

// Any later moment: a fresh access token for this device, no popup.
async function token(env, { device }) {
  const rec = await load(env, device);
  if (!rec) return [401, { error: 'not_connected' }];
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: rec.rt, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) {
    // invalid_grant: the user removed access in Google, changed password, or the grant expired.
    if (t.error === 'invalid_grant') { await env.TOKENS.delete(rec.ukey); await env.TOKENS.delete(rec.dkey); return [401, { error: 'not_connected' }]; }
    return [502, { error: t.error || 'refresh_failed' }];
  }
  return [200, { access_token: t.access_token, expires_in: t.expires_in, scope: t.scope, email: rec.email }];
}

// Disconnect: revoke at Google and forget the account, on all of its devices.
async function revoke(env, { device }) {
  const rec = await load(env, device);
  if (rec) {
    await fetch(GOOGLE_REVOKE + '?token=' + encodeURIComponent(rec.rt), { method: 'POST' }).catch(() => {});
    await env.TOKENS.delete(rec.ukey);
    await env.TOKENS.delete(rec.dkey);
  }
  return [200, { ok: true }];
}

// Sign-out from the site on one device: forget only this device. The account stays
// connected elsewhere, and signing in here again takes one click with no consent screen.
async function forget(env, { device }) {
  if (validDevice(device)) await env.TOKENS.delete('d:' + await hash(device));
  return [200, { ok: true }];
}

const validDevice = (d) => typeof d === 'string' && d.length >= 40 && d.length <= 64;
async function load(env, device) {
  if (!validDevice(device)) return null;
  const dkey = 'd:' + await hash(device);
  const d = await env.TOKENS.get(dkey);
  if (!d) return null;
  try {
    const { email } = JSON.parse(await open(env, d));
    const ukey = 'u:' + await hash(email);
    const u = await env.TOKENS.get(ukey);
    if (!u) { await env.TOKENS.delete(dkey); return null; }
    return { email, rt: JSON.parse(await open(env, u)).rt, dkey, ukey };
  } catch (e) { return null; }
}

// ---------- Background Drive sync (service account) ----------
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// "Sync now" on the site: runs the sync unless one finished less than a minute ago.
async function refresh(env) {
  const st = JSON.parse((await env.TOKENS.get('sync:status')) || '{}');
  if (st.at && Date.now() - st.at < 60000) return [200, st];
  const r = await syncDrive(env);
  return [r.ok ? 200 : 503, r];
}
async function syncError(env) {
  try { return JSON.parse((await env.TOKENS.get('sync:status')) || '{}').error || ''; } catch (e) { return ''; }
}

// Reads the protocol documents (with their folders) and the tasks sheet, and keeps them in KV.
// Each part is saved on its own, so a failure in one keeps the last good copy of the other.
async function syncDrive(env) {
  const status = { at: Date.now(), ok: true, error: '' };
  const fail = (what, e) => { status.ok = false; status.error = status.error || (what + ': ' + (e && e.message || e)); console.error('femy-google sync ' + what + ': ' + (e && e.stack || e)); };
  let tok = '';
  try { tok = await saToken(env); } catch (e) { fail('auth', e); }
  if (tok) {
    if (env.PROJECTS_FOLDER_ID) {
      try {
        const root = env.PROJECTS_FOLDER_ID;
        // The service account sees only what was shared with it (the projects folder and what is inside),
        // so one search for all folders gives every folder between a document and the projects folder.
        const [files, flist] = await Promise.all([
          driveSearch(tok, DP.driveQuery(), 'id,name,mimeType,parents,modifiedTime,createdTime'),
          driveSearch(tok, `mimeType='${FOLDER_MIME}' and trashed=false`, 'id,name,parents'),
        ]);
        const folders = {};
        flist.forEach((f) => { folders[f.id] = [(f.parents || [])[0] || '', f.name || '']; });
        const docs = files.filter((f) => DP.DOC_MIMES[f.mimeType]).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, modifiedTime: f.modifiedTime, createdTime: f.createdTime }));
        if (!flist.some((f) => f.id === root) && !docs.length) throw new Error('the projects folder is not shared with the service account');
        await env.TOKENS.put('sync:drive', JSON.stringify({ at: status.at, root, files: docs, folders }));
        status.files = docs.length; status.folders = flist.length;
      } catch (e) { fail('drive', e); }
    }
    if (env.TASKS_SHEET_ID) {
      try {
        const r = await gfetch(tok, `${DRIVE}/${encodeURIComponent(env.TASKS_SHEET_ID)}/export?mimeType=${encodeURIComponent(XLSX)}`);
        const buf = await r.arrayBuffer();
        await env.TOKENS.put('sync:sheet', buf, { metadata: { at: status.at } });
        status.sheetBytes = buf.byteLength;
      } catch (e) { fail('sheet', e); }
    }
  }
  await env.TOKENS.put('sync:status', JSON.stringify(status));
  return status;
}

async function gfetch(tok, url) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error.message; } catch (e) { /* ignore */ }
    throw new Error('HTTP ' + r.status + (msg ? ' ' + msg : ''));
  }
  return r;
}
// Every page of a Drive search over all the files the service account can see.
async function driveSearch(tok, q, fields) {
  const out = []; let pageToken = '';
  for (let i = 0; i < 10; i++) {
    const p = new URLSearchParams({ q, pageSize: '1000', fields: `nextPageToken,files(${fields})`, includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', corpora: 'allDrives' });
    if (pageToken) p.set('pageToken', pageToken);
    const j = await (await gfetch(tok, DRIVE + '?' + p)).json();
    out.push(...(j.files || []));
    if (!(pageToken = j.nextPageToken)) break;
  }
  return out;
}

// A one-hour access token for the service account: a JWT signed with its private key (RS256).
async function saToken(env) {
  let key;
  try { key = JSON.parse(String(env.GOOGLE_SERVICE_ACCOUNT_KEY || '')); } catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is missing or not valid JSON'); }
  if (!key.client_email || !key.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY has no client_email / private_key');
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = part({ alg: 'RS256', typ: 'JWT' }) + '.' + part({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: GOOGLE_TOKEN, iat: now, exp: now + 3600 });
  const der = Uint8Array.from(atob(key.private_key.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const pk = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pk, new TextEncoder().encode(unsigned)));
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(sig) }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) throw new Error('service account token: ' + (t.error_description || t.error || r.status));
  return t.access_token;
}

// ---------- crypto helpers ----------
function b64url(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64(s) { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)); }
async function hash(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
let keyCache = null;
// The AES key is the SHA-256 of ENC_KEY, so any long random string works, and a stray
// space, newline or wrong length in the pasted secret can't break encryption.
async function aesKey(env) {
  if (!keyCache) {
    const secret = String(env.ENC_KEY || '').trim();
    if (secret.length < 16) throw new Error('ENC_KEY is missing or too short');
    keyCache = crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
      .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
    keyCache.catch(() => { keyCache = null; });
  }
  return keyCache;
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(text)));
  return b64url(iv) + '.' + b64url(ct);
}
async function open(env, sealed) {
  const [iv, ct] = sealed.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await aesKey(env), fromB64(ct)));
}
