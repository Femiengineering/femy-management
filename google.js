// פמי הנדסה - חיבור לחשבון Google האישי של כל משתמש: יומן, Gmail ו-Google Drive.
// Uses Google Identity Services (OAuth 2.0 token flow in the browser, no server).
// Each signed-in user of the site connects their own Google account. The access
// token is kept in this browser under that user's key only, so one user never
// sees another user's calendar, mail or files. Tokens last about an hour; after
// that one click renews it (no consent screen the second time).
(function () {
  'use strict';
  const cfg = window.FEMY_GOOGLE || {};
  const enabled = !!cfg.clientId;

  const SCOPES = [
    'https://www.googleapis.com/auth/calendar.events', // read and add events in the user's calendars
    'https://www.googleapis.com/auth/gmail.readonly', // read the inbox
    'https://www.googleapis.com/auth/gmail.send', // send mail as the user
    'https://www.googleapis.com/auth/drive.readonly', // browse the user's Drive files
    'https://www.googleapis.com/auth/drive.file', // create and update files the site made
  ];
  const STORE = 'femy-google:';

  let userKey = null; // the site user this browser is signed in as
  let hint = ''; // their email, suggested to Google as the account to pick
  let rec = null; // { token, exp, scope, email }
  let client = null;
  let pending = null;
  const listeners = [];

  // Load the Google Identity Services library up front, so a click can open the popup right away.
  let gisReady = null;
  function loadGis() {
    if (gisReady) return gisReady;
    gisReady = new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisReady = null; reject(new Error('טעינת ספריית Google נכשלה')); };
      document.head.appendChild(s);
    });
    return gisReady;
  }

  function read() {
    try { rec = JSON.parse(localStorage.getItem(STORE + userKey) || 'null'); } catch (e) { rec = null; }
  }
  function write() {
    try { if (rec) localStorage.setItem(STORE + userKey, JSON.stringify(rec)); else localStorage.removeItem(STORE + userKey); } catch (e) { /* ignore */ }
    listeners.forEach((f) => { try { f(status()); } catch (e) { /* ignore */ } });
  }

  function init(key, email) {
    userKey = String(key || '').toLowerCase();
    hint = email || '';
    client = null;
    read();
    if (enabled) loadGis().catch(() => {});
  }
  const valid = () => !!(rec && rec.token && rec.exp > Date.now() + 60000);
  function status() {
    return { enabled, connected: !!(rec && rec.email), valid: valid(), email: (rec && rec.email) || '', exp: rec ? rec.exp : 0 };
  }
  const onChange = (f) => listeners.push(f);

  function makeClient() {
    client = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPES.join(' '),
      include_granted_scopes: true,
      callback: () => {},
    });
  }

  // Returns a valid access token. When a new one is needed it opens Google's popup,
  // so call it straight from a click, before any other await.
  function token() {
    if (!enabled) return Promise.reject(Object.assign(new Error('החיבור ל-Google עדיין לא הוגדר באתר'), { code: 'not-configured' }));
    if (!userKey) return Promise.reject(new Error('לא מחובר למערכת'));
    if (valid()) return Promise.resolve(rec.token);
    if (pending) return pending;
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      loadGis().catch(() => {});
      return Promise.reject(new Error('ספריית Google עדיין נטענת. נסו שוב בעוד רגע'));
    }
    if (!client) makeClient();
    pending = new Promise((resolve, reject) => {
      client.callback = async (r) => {
        pending = null;
        if (!r || r.error || !r.access_token) { reject(Object.assign(new Error(r && (r.error_description || r.error) || 'החיבור נכשל'), { code: r && r.error })); return; }
        const missing = SCOPES.filter((s) => !google.accounts.oauth2.hasGrantedAllScopes(r, s));
        const prevEmail = rec && rec.email;
        rec = { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000, scope: r.scope, email: prevEmail || '', missing };
        if (!rec.email) {
          try { rec.email = (await (await api(null, 'https://gmail.googleapis.com/gmail/v1/users/me/profile')).json()).emailAddress || ''; } catch (e) { /* not fatal */ }
        }
        write();
        resolve(rec.token);
      };
      client.error_callback = (e) => {
        pending = null;
        const t = e && e.type;
        reject(Object.assign(new Error(t === 'popup_closed' ? 'החלון נסגר לפני שהחיבור הסתיים' : t === 'popup_failed_to_open' ? 'הדפדפן חסם את החלון. אפשרו חלונות קופצים ונסו שוב' : 'החיבור נכשל'), { code: t }));
      };
      const opts = { prompt: '' };
      if (rec && rec.email) opts.login_hint = rec.email; else if (hint) opts.login_hint = hint;
      client.requestAccessToken(opts);
    });
    return pending;
  }
  const connect = token;

  function disconnect() {
    const t = rec && rec.token;
    rec = null; write();
    if (t && window.google && google.accounts && google.accounts.oauth2) { try { google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ } }
  }
  // On sign-out from the site: forget this user's token in this browser (access stays granted in Google).
  function forget() { rec = null; write(); }

  async function api(tok, url, opts) {
    const t = tok || (rec && rec.token);
    const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + t }, (opts && opts.headers) || {}) }));
    if (r.status === 401 && rec) { rec.exp = 0; write(); }
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).error.message; } catch (e) { /* ignore */ }
      throw Object.assign(new Error(msg || 'HTTP ' + r.status), { status: r.status });
    }
    return r;
  }
  const json = async (url, opts) => (await api(await token(), url, opts)).json();

  // ---------- Calendar ----------
  const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  async function events(days) {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + (days || 14));
    const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '100' });
    return ((await json(CAL + '?' + q)).items || []).filter((e) => e.status !== 'cancelled');
  }
  const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jerusalem';
  // ev: { title, date (YYYY-MM-DD), start (HH:MM, empty for all day), end, location, description, attendees: [emails] }
  function eventBody(ev) {
    const body = { summary: ev.title, location: ev.location || undefined, description: ev.description || undefined };
    if (ev.start) {
      const end = ev.end || addMinutes(ev.start, 60);
      body.start = { dateTime: ev.date + 'T' + ev.start + ':00', timeZone: tz() };
      body.end = { dateTime: ev.date + 'T' + end + ':00', timeZone: tz() };
    } else {
      const d = new Date(ev.date + 'T00:00:00'); d.setDate(d.getDate() + 1);
      const z = (n) => String(n).padStart(2, '0');
      body.start = { date: ev.date };
      body.end = { date: d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) };
    }
    if (ev.attendees && ev.attendees.length) body.attendees = ev.attendees.map((email) => ({ email }));
    return body;
  }
  function addMinutes(hhmm, m) {
    const [h, mi] = hhmm.split(':').map(Number);
    const t = Math.min(h * 60 + mi + m, 23 * 60 + 59);
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }
  async function createEvent(ev, eventId) {
    const tok = await token();
    const body = JSON.stringify(eventBody(ev));
    const h = { 'Content-Type': 'application/json' };
    const invite = ev.attendees && ev.attendees.length ? '?sendUpdates=all' : '';
    if (eventId) {
      try { return await (await api(tok, CAL + '/' + encodeURIComponent(eventId) + invite, { method: 'PATCH', headers: h, body })).json(); }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }
    return (await api(tok, CAL + invite, { method: 'POST', headers: h, body })).json();
  }

  // ---------- Gmail ----------
  const GM = 'https://gmail.googleapis.com/gmail/v1/users/me';
  async function inbox(query, n) {
    const tok = await token();
    const q = new URLSearchParams({ maxResults: String(n || 20), q: query || 'in:inbox' });
    const list = (await (await api(tok, GM + '/messages?' + q)).json()).messages || [];
    const head = (m, name) => ((m.payload && m.payload.headers) || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    const full = await Promise.all(list.map((m) => api(tok, GM + '/messages/' + m.id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date')
      .then((r) => r.json()).catch(() => null)));
    return full.filter(Boolean).map((m) => ({
      id: m.id, threadId: m.threadId, snippet: decode(m.snippet || ''),
      from: (head(m, 'From') || {}).value || '', subject: (head(m, 'Subject') || {}).value || '(ללא נושא)',
      date: Number(m.internalDate) || 0, unread: (m.labelIds || []).includes('UNREAD'),
    }));
  }
  function decode(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }
  const mailLink = (m) => 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent((rec && rec.email) || '') + '#all/' + m.threadId;

  const b64utf8 = (s) => btoa(unescape(encodeURIComponent(s)));
  const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n');
  const encWord = (s) => '=?UTF-8?B?' + b64utf8(s) + '?=';
  async function blobB64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function send({ to, cc, subject, text, attachment }) {
    const tok = await token();
    const bd = 'femy' + Math.random().toString(36).slice(2);
    let m = `To: ${to}\r\n` + (cc ? `Cc: ${cc}\r\n` : '') + `Subject: ${encWord(subject || '')}\r\nMIME-Version: 1.0\r\n`
      + `Content-Type: multipart/mixed; boundary="${bd}"\r\n\r\n`
      + `--${bd}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64utf8(text || ''))}`;
    if (attachment) {
      const fn = encWord(attachment.name);
      m += `--${bd}\r\nContent-Type: ${attachment.blob.type || 'application/octet-stream'}; name="${fn}"\r\n`
        + `Content-Disposition: attachment; filename="${fn}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(await blobB64(attachment.blob))}`;
    }
    m += `--${bd}--\r\n`;
    const raw = btoa(m).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await api(tok, GM + '/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) });
  }

  // ---------- Drive ----------
  const DAPI = 'https://www.googleapis.com/drive/v3/files';
  const UP = 'https://www.googleapis.com/upload/drive/v3/files';
  const FOLDER = 'פמי הנדסה - מערכת ניהול';
  const FIELDS = 'files(id,name,mimeType,webViewLink,modifiedTime,iconLink)';
  const qs = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function files(search) {
    const q = 'trashed=false' + (search ? ` and name contains '${qs(search)}'` : '');
    const p = new URLSearchParams({ q, orderBy: search ? 'modifiedTime desc' : 'viewedByMeTime desc', pageSize: '30', fields: FIELDS, includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' });
    return (await json(DAPI + '?' + p)).files || [];
  }
  let folderId = null;
  async function folder(tok) {
    if (folderId) return folderId;
    const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`);
    const found = await (await api(tok, `${DAPI}?q=${q}&fields=files(id)&spaces=drive`)).json();
    if (found.files && found.files.length) return (folderId = found.files[0].id);
    const made = await (await api(tok, `${DAPI}?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
    })).json();
    return (folderId = made.id);
  }
  async function appFiles() {
    const tok = await token();
    const parent = await folder(tok);
    const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
    return (await (await api(tok, `${DAPI}?q=${q}&orderBy=modifiedTime desc&pageSize=50&fields=${FIELDS}`)).json()).files || [];
  }
  // Creates the file in the site's folder, or replaces it when fileId is given and still reachable.
  async function save(name, blob, fileId) {
    const tok = await token();
    const form = (meta) => {
      const f = new FormData();
      f.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      f.append('file', blob);
      return f;
    };
    if (fileId) {
      try { return await (await api(tok, `${UP}/${fileId}?uploadType=multipart&fields=id,name,webViewLink`, { method: 'PATCH', body: form({ name }) })).json(); }
      catch (e) { if (e.status !== 404 && e.status !== 403) throw e; }
    }
    const parent = await folder(tok);
    return (await api(tok, `${UP}?uploadType=multipart&fields=id,name,webViewLink`, { method: 'POST', body: form({ name, parents: [parent] }) })).json();
  }
  async function readFile(id) { return (await api(await token(), `${DAPI}/${id}?alt=media`)).text(); }

  window.FemyGoogle = {
    enabled, init, status, valid, onChange, token, connect, disconnect, forget,
    calendar: { events, create: createEvent },
    gmail: { inbox, send, link: mailLink },
    drive: { files, appFiles, save, read: readFile },
  };
})();
