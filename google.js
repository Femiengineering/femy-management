// פמי הנדסה - חיבור לחשבון Google האישי של כל משתמש: יומן, Gmail ו-Google Drive.
// Uses Google Identity Services (OAuth 2.0 token flow in the browser, no server).
// Each signed-in user of the site connects their own Google account. What this
// browser keeps is stored under that user's key only, so one user never sees
// another user's calendar, mail or files.
// With tokenServer set in google-config.js (the worker/ folder), the connection
// is permanent: one approval per device, then silent renewal. Without it, tokens
// last about an hour and one click renews them.
(function () {
  'use strict';
  const cfg = window.FEMY_GOOGLE || {};
  const enabled = !!cfg.clientId;

  const SCOPES = [
    'https://www.googleapis.com/auth/calendar.events', // read and add events in the user's calendars
    'https://www.googleapis.com/auth/gmail.readonly', // read the inbox
    'https://www.googleapis.com/auth/gmail.send', // send mail as the user
    'https://www.googleapis.com/auth/gmail.compose', // a reply ready in the project's thread, to send from Gmail
    'https://www.googleapis.com/auth/gmail.modify', // a mail read on the site is marked as read in Gmail too
    'https://www.googleapis.com/auth/drive.readonly', // browse the user's Drive files
    'https://www.googleapis.com/auth/drive.file', // create and update files the site made
    'https://www.googleapis.com/auth/drive', // write the reports into the Google Docs the office opened in the project folders
  ];
  const STORE = 'femy-google:';

  let userKey = null; // the site user this browser is signed in as
  let hint = ''; // their email, suggested to Google as the account to pick
  let rec = null; // { token, exp, scope, email }
  let client = null; // token client (hourly mode)
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
    client = null; pending = null;
    read();
    if (enabled) loadGis().catch(() => {});
  }
  // Always-on mode: with a token server (worker/), the browser keeps only a device key
  // and gets fresh access tokens from the server, with no popup, for as long as the
  // user stays connected. Without one, tokens last an hour and renewing needs a click.
  const server = String(cfg.tokenServer || '').replace(/\/+$/, '');
  const persistent = enabled && !!server;

  const fresh = () => !!(rec && rec.token && rec.exp > Date.now() + 60000);
  // "valid" = the site can call Google now without asking the user for anything.
  const valid = () => fresh() || !!(persistent && rec && rec.device);
  function status() {
    return { enabled, persistent, connected: !!(rec && rec.email), valid: valid(), gmailCompose: rec && rec.scope ? /auth\/gmail\.compose( |$)/.test(rec.scope) : null, gmailModify: rec && rec.scope ? /auth\/gmail\.modify( |$)/.test(rec.scope) : null, driveWrite: rec && rec.scope ? / https:\/\/www\.googleapis\.com\/auth\/drive( |$)/.test(' ' + rec.scope) : null, email: (rec && rec.email) || '', exp: rec ? rec.exp : 0 };
  }
  const onChange = (f) => listeners.push(f);

  const gisMissing = () => !(window.google && google.accounts && google.accounts.oauth2);
  const notReady = () => { loadGis().catch(() => {}); return Promise.reject(new Error('ספריית Google עדיין נטענת. נסו שוב בעוד רגע')); };
  const popupError = (e) => {
    const t = e && e.type;
    return Object.assign(new Error(t === 'popup_closed' ? 'החלון נסגר לפני שהחיבור הסתיים' : t === 'popup_failed_to_open' ? 'הדפדפן חסם את החלון. אפשרו חלונות קופצים ונסו שוב' : 'החיבור נכשל'), { code: t });
  };
  const hintFor = () => (rec && rec.email) || hint || undefined;

  async function post(path, body) {
    let r;
    try { r = await fetch(server + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { throw new Error(navigator.onLine === false ? 'אין חיבור לאינטרנט' : 'שרת החיבור ל-Google לא זמין'); }
    let j = {};
    try { j = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { status: r.status, code: j.error });
    return j;
  }
  function keep(j, extra) {
    rec = Object.assign({}, rec, extra, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, scope: j.scope, email: j.email || (rec && rec.email) || '' });
    write();
    return rec.token;
  }

  // Returns a valid access token. In always-on mode it renews silently from the server.
  // When the user still has to approve (first time, or after a disconnect) it opens
  // Google's popup, so call it straight from a click, before any other await.
  function token() {
    if (!enabled) return Promise.reject(Object.assign(new Error('החיבור ל-Google עדיין לא הוגדר באתר'), { code: 'not-configured' }));
    if (!userKey) return Promise.reject(new Error('לא מחובר למערכת'));
    if (fresh()) return Promise.resolve(rec.token);
    if (pending) return pending;
    if (persistent && rec && rec.device) {
      const device = rec.device;
      pending = post('/token', { device }).then((j) => { pending = null; return keep(j); }, (e) => {
        pending = null;
        if (e.status === 401) { rec = null; write(); e.message = 'החיבור ל-Google בוטל. לחצו "חיבור לחשבון Google" כדי להתחבר מחדש'; e.code = 'reconnect'; }
        throw e;
      });
      return pending;
    }
    return connect();
  }

  // True when a token can be had without a popup (for background work such as syncing).
  const silent = () => !!(enabled && userKey && (fresh() || (persistent && rec && rec.device)));

  // Opens Google's popup and asks the user to approve. Call straight from a click.
  function connect() {
    if (!enabled) return token();
    if (gisMissing()) return notReady();
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      const fail = (e) => { pending = null; reject(e); };
      if (persistent) {
        // Authorization code flow: the server trades the code for a long-lived refresh token.
        const cc = google.accounts.oauth2.initCodeClient({
          client_id: cfg.clientId, scope: SCOPES.join(' '), ux_mode: 'popup', include_granted_scopes: true, login_hint: hintFor(),
          callback: (r) => {
            if (!r || r.error || !r.code) { fail(Object.assign(new Error(r && (r.error_description || r.error) || 'החיבור נכשל'), { code: r && r.error })); return; }
            post('/exchange', { code: r.code }).then((j) => { pending = null; resolve(keep(j, { device: j.device })); }, (e) => {
              if (e.code === 'no_refresh_token') { e.message = 'עוד שלב אחד: לחצו שוב על "חיבור לחשבון Google" ואשרו את כל ההרשאות'; e.code = 'retry'; }
              fail(e);
            });
          },
          error_callback: (e) => fail(popupError(e)),
        });
        cc.requestCode();
        return;
      }
      if (!client) client = google.accounts.oauth2.initTokenClient({ client_id: cfg.clientId, scope: SCOPES.join(' '), include_granted_scopes: true, callback: () => {} });
      client.callback = async (r) => {
        if (!r || r.error || !r.access_token) { fail(Object.assign(new Error(r && (r.error_description || r.error) || 'החיבור נכשל'), { code: r && r.error })); return; }
        pending = null;
        keep(r);
        if (!rec.email) {
          try { rec.email = (await (await api(null, 'https://gmail.googleapis.com/gmail/v1/users/me/profile')).json()).emailAddress || ''; write(); } catch (e) { /* not fatal */ }
        }
        resolve(rec.token);
      };
      client.error_callback = (e) => fail(popupError(e));
      client.requestAccessToken({ prompt: '', login_hint: hintFor() });
    });
    return pending;
  }

  // "ניתוק": removes access in Google itself (on all devices, in always-on mode).
  function disconnect() {
    const t = rec && rec.token, device = rec && rec.device;
    rec = null; write();
    if (persistent && device) { post('/revoke', { device }).catch(() => {}); return; }
    if (t && !gisMissing()) { try { google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ } }
  }
  // On sign-out from the site: forget this user's connection in this browser only.
  // In always-on mode the next sign-in here takes one click, with no consent screen.
  function forget() {
    const device = rec && rec.device;
    rec = null; write();
    if (persistent && device) post('/forget', { device }).catch(() => {});
  }

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
  // One page of mails for the mail section: { messages, next } (next: the token for the following page).
  async function list(query, n, pageToken) {
    const tok = await token();
    const q = new URLSearchParams({ maxResults: String(n || 25), q: query || '' });
    if (pageToken) q.set('pageToken', pageToken);
    const r = await (await api(tok, GM + '/messages?' + q)).json();
    const ids = r.messages || [];
    const full = await Promise.all(ids.map((m) => api(tok, GM + '/messages/' + m.id + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date')
      .then((x) => x.json()).catch(() => null)));
    return {
      next: r.nextPageToken || '',
      messages: full.filter(Boolean).map((m) => ({
        id: m.id, threadId: m.threadId, snippet: decode(m.snippet || ''),
        from: hdr(m, 'From'), to: hdr(m, 'To'), subject: hdr(m, 'Subject') || '(ללא נושא)',
        date: Number(m.internalDate) || 0, unread: (m.labelIds || []).includes('UNREAD'),
        sent: (m.labelIds || []).includes('SENT'),
      })),
    };
  }
  // How many unread mails are in the inbox.
  async function unreadCount() { return Number((await json(GM + '/labels/INBOX')).messagesUnread) || 0; }
  // A mail's parts: its text (html and plain), its files and the pictures inside it (cid:).
  function walk(p, out) {
    if (!p) return out;
    const type = (p.mimeType || '').toLowerCase();
    const cid = (((p.headers || []).find((h) => h.name.toLowerCase() === 'content-id') || {}).value || '').replace(/[<>]/g, '');
    const disp = (((p.headers || []).find((h) => h.name.toLowerCase() === 'content-disposition') || {}).value || '').toLowerCase();
    if (p.filename || (p.body && p.body.attachmentId && !type.startsWith('text/'))) {
      const f = { name: p.filename || 'קובץ', mime: p.mimeType, size: (p.body && p.body.size) || 0, id: p.body && p.body.attachmentId, data: p.body && p.body.data, cid };
      if (cid && type.startsWith('image/') && !disp.startsWith('attachment')) out.inline.push(f); else out.files.push(f);
    } else if (type === 'text/html' && p.body && p.body.data && !out.html) out.html = partDecode(p);
    else if (type === 'text/plain' && p.body && p.body.data && !out.text) out.text = partDecode(p);
    (p.parts || []).forEach((c) => walk(c, out));
    return out;
  }
  // A text part in its own charset (Hebrew mail often comes as windows-1255 or iso-8859-8).
  function partDecode(p) {
    const ct = (((p.headers || []).find((h) => h.name.toLowerCase() === 'content-type') || {}).value || '');
    const cs = ((/charset="?([^";\s]+)/i.exec(ct) || [])[1] || 'utf-8').toLowerCase();
    const bin = atob(p.body.data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try { return new TextDecoder(cs === 'iso-8859-8-i' ? 'iso-8859-8' : cs).decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  }
  // A whole conversation, for reading on the site: every mail in it, oldest first.
  async function conversation(threadId) {
    const t = await json(GM + '/threads/' + encodeURIComponent(threadId) + '?format=full');
    return (t.messages || []).map((m) => {
      const b = walk(m.payload, { html: '', text: '', files: [], inline: [] });
      return {
        id: m.id, threadId: m.threadId, labels: m.labelIds || [], unread: (m.labelIds || []).includes('UNREAD'),
        from: hdr(m, 'From'), to: hdr(m, 'To'), cc: hdr(m, 'Cc'), replyTo: hdr(m, 'Reply-To'), subject: hdr(m, 'Subject') || '(ללא נושא)',
        messageId: hdr(m, 'Message-ID') || hdr(m, 'Message-Id'), references: hdr(m, 'References'),
        date: Number(m.internalDate) || 0, snippet: decode(m.snippet || ''), html: b.html, text: b.text, files: b.files, inline: b.inline,
      };
    });
  }
  // A file attached to a mail, as a Blob.
  async function attachment(messageId, att) {
    let data = att.data;
    if (!data) data = (await json(GM + '/messages/' + encodeURIComponent(messageId) + '/attachments/' + encodeURIComponent(att.id))).data || '';
    const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: att.mime || 'application/octet-stream' });
  }
  // Marks the conversation as read in Gmail (needs the gmail.modify permission; without it, does nothing).
  async function markRead(threadId) {
    if (!(rec && rec.scope && /auth\/gmail\.modify( |$)/.test(rec.scope))) return false;
    await json(GM + '/threads/' + encodeURIComponent(threadId) + '/modify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) });
    return true;
  }
  // The newest mail thread that matches a Gmail search, or null.
  async function findThread(query) {
    const q = new URLSearchParams({ maxResults: '1', q: query });
    const m = ((await json(GM + '/messages?' + q)).messages || [])[0];
    return m ? m.threadId : null;
  }
  // The newest thread with a mail the user sent that matches a Gmail search, or null.
  const findSent = (query) => findThread('in:sent ' + query);
  const hdr = (m, name) => ((m && m.payload && m.payload.headers) || []).reduce((v, x) => (!v && x.name.toLowerCase() === name.toLowerCase() ? x.value : v), '');
  const unb64 = (d) => { const bin = atob(d.replace(/-/g, '+').replace(/_/g, '/')); try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; } };
  function partText(p, type) {
    if (!p) return '';
    if (p.mimeType === type && p.body && p.body.data) return unb64(p.body.data);
    for (const c of p.parts || []) { const t = partText(c, type); if (t) return t; }
    return '';
  }
  const htmlText = (html) => new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr)>/gi, '\n'), 'text/html').body.textContent || '';
  // A mail thread: its subject, what a reply needs (Message-ID, References), and the last mail the user sent in it.
  const hasFile = (p) => !!p && (!!(p.filename && p.body && p.body.attachmentId) || (p.parts || []).some(hasFile));
  // The reply goes to the previous report: the last mail the user sent in the thread with a file attached
  // (else the last mail the user sent, else the last mail). to / cc / from: its recipients, for "reply to all".
  async function thread(id) {
    const t = await json(GM + '/threads/' + encodeURIComponent(id) + '?format=full');
    const msgs = t.messages || [];
    const last = msgs[msgs.length - 1];
    const sent = msgs.filter((m) => (m.labelIds || []).includes('SENT'));
    const target = sent.filter((m) => hasFile(m.payload)).pop() || sent.pop() || last;
    const mine = (target.labelIds || []).includes('SENT') ? target : null;
    let text = mine ? partText(mine.payload, 'text/plain') : '';
    if (!text && mine) text = htmlText(partText(mine.payload, 'text/html'));
    const mid = hdr(target, 'Message-ID') || hdr(target, 'Message-Id');
    return {
      id, subject: hdr(target, 'Subject') || hdr(msgs[0], 'Subject'), messageId: mid, references: [hdr(target, 'References'), mid].filter(Boolean).join(' '),
      from: hdr(target, 'From'), to: hdr(target, 'To'), cc: hdr(target, 'Cc'), mine: !!mine, text, count: msgs.length, date: Number(target.internalDate) || 0,
    };
  }
  const searchLink = (query) => 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent((rec && rec.email) || '') + '#search/' + encodeURIComponent(query);
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
  // threadId / inReplyTo / references: sent as a reply in that thread.
  async function rawMail({ to, cc, subject, text, attachment, inReplyTo, references }) {
    const bd = 'femy' + Math.random().toString(36).slice(2);
    let m = `To: ${to}\r\n` + (cc ? `Cc: ${cc}\r\n` : '') + `Subject: ${encWord(subject || '')}\r\nMIME-Version: 1.0\r\n`
      + (inReplyTo ? `In-Reply-To: ${inReplyTo}\r\nReferences: ${references || inReplyTo}\r\n` : '')
      + `Content-Type: multipart/mixed; boundary="${bd}"\r\n\r\n`
      + `--${bd}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64utf8(text || ''))}`;
    if (attachment) {
      const fn = encWord(attachment.name);
      m += `--${bd}\r\nContent-Type: ${attachment.blob.type || 'application/octet-stream'}; name="${fn}"\r\n`
        + `Content-Disposition: attachment; filename="${fn}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(await blobB64(attachment.blob))}`;
    }
    m += `--${bd}--\r\n`;
    return btoa(m).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function send(o) {
    const tok = await token(); const raw = await rawMail(o);
    return (await api(tok, GM + '/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o.threadId ? { raw, threadId: o.threadId } : { raw }) })).json();
  }
  // The same mail as a draft (in the thread when threadId is given), to check and send from Gmail.
  async function draft(o) {
    const tok = await token(); const raw = await rawMail(o);
    return (await api(tok, GM + '/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: o.threadId ? { raw, threadId: o.threadId } : { raw } }) })).json();
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
  // The company's shared projects folder: the Drive tab on the site shows only what is inside it.
  const PROJECTS_NAME = (window.FEMY_GOOGLE && window.FEMY_GOOGLE.projectsFolderName) || 'פרויקטים פמי';
  let projectsId = (window.FEMY_GOOGLE && window.FEMY_GOOGLE.projectsFolderId) || '';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  async function projectsRoot() {
    if (projectsId) return projectsId;
    // Not configured: find the folder by name (it may be shared with the user rather than in their My Drive).
    const q = `name contains '${qs(PROJECTS_NAME.trim())}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const p = new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '20', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' });
    const found = ((await json(DAPI + '?' + p)).files || []).find((f) => f.name.trim() === PROJECTS_NAME.trim());
    if (!found) { const e = new Error(`התיקייה "${PROJECTS_NAME}" לא נמצאה ב-Drive שלך`); e.status = 404; throw e; }
    return (projectsId = found.id);
  }
  // Lists one folder inside the projects folder: subfolders first, then files (or only folders).
  async function browse(parentId, opts) {
    const o = opts || {};
    const parent = parentId || await projectsRoot();
    let q = `'${qs(parent)}' in parents and trashed=false`;
    if (o.foldersOnly) q += ` and mimeType='${FOLDER_MIME}'`;
    if (o.search) q += ` and name contains '${qs(o.search)}'`;
    const p = new URLSearchParams({ q, orderBy: 'folder,name', pageSize: '200', fields: FIELDS, includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' });
    const list = (await json(DAPI + '?' + p)).files || [];
    list.forEach((f) => { f.folder = f.mimeType === FOLDER_MIME; });
    return { id: parent, files: list };
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
  // opts.gdoc: a Word file is kept as a Google Doc (Drive converts it on every upload). opts.keepName: the
  // existing file keeps its own name (a document the office opened, that the site only writes into).
  async function save(name, blob, fileId, parentId, opts) {
    const tok = await token();
    const conv = opts && opts.gdoc ? { mimeType: 'application/vnd.google-apps.document' } : {};
    const form = (meta) => {
      const f = new FormData();
      f.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      f.append('file', blob);
      return f;
    };
    if (fileId) {
      try { return await (await api(tok, `${UP}/${fileId}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, { method: 'PATCH', body: form(opts && opts.keepName ? {} : { name }) })).json(); }
      catch (e) { if ((opts && opts.noFallback) || (e.status !== 404 && e.status !== 403)) throw e; }
    }
    if (parentId) {
      // Into a folder the user chose (for example a project folder). Falls back to the site's own folder
      // when Google does not let the site write there.
      try { const f = await (await api(tok, `${UP}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, { method: 'POST', body: form(Object.assign({ name, parents: [parentId] }, conv)) })).json(); f.inFolder = true; return f; }
      catch (e) { if (e.status !== 404 && e.status !== 403) throw e; }
    }
    const parent = await folder(tok);
    return (await api(tok, `${UP}?uploadType=multipart&fields=id,name,webViewLink`, { method: 'POST', body: form(Object.assign({ name, parents: [parent] }, conv)) })).json();
  }
  // A search over every file the user can see (My Drive, shared with them and shared drives), page after page.
  async function search(q, fields, maxPages) {
    const out = []; let pageToken = '';
    for (let i = 0; i < (maxPages || 10); i++) {
      const p = new URLSearchParams({ q, pageSize: '1000', fields: `nextPageToken,files(${fields || 'id,name,mimeType,parents,modifiedTime,createdTime'})`, includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', corpora: 'allDrives' });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await json(DAPI + '?' + p);
      out.push(...(r.files || []));
      if (!(pageToken = r.nextPageToken)) break;
    }
    return out;
  }
  async function meta(id, fields) { return json(`${DAPI}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields || 'id,name,parents')}&supportsAllDrives=true`); }
  async function folderName(id) { return (await json(`${DAPI}/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`)).name || ''; }
  // Downloads a Google file converted to another format (for example a Sheet as .xlsx).
  async function exportFile(id, mime) { return (await api(await token(), `${DAPI}/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mime)}`)).arrayBuffer(); }
  async function readBuffer(id) { return (await api(await token(), `${DAPI}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`)).arrayBuffer(); }
  // To the trash (can be restored from Drive's trash).
  async function trash(id) { await api(await token(), `${DAPI}/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); }
  async function remove(id) { await api(await token(), `${DAPI}/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: 'DELETE' }); }
  async function readFile(id) { return (await api(await token(), `${DAPI}/${id}?alt=media`)).text(); }

  window.FemyGoogle = {
    enabled, init, status, valid, silent, onChange, token, connect, disconnect, forget,
    calendar: { events, create: createEvent },
    gmail: { inbox, list, unreadCount, conversation, attachment, markRead, send, draft, link: mailLink, findThread, findSent, thread, searchLink },
    drive: { exportFile, files, search, meta, browse, projectsRoot, folderName, projectsName: PROJECTS_NAME, appFiles, save, remove, trash, read: readFile, readBuffer },
  };
})();
