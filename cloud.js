// פמי הנדסה - חיבור לענן (Firebase).
// Sign-in (Google or email + password), shared data in Firestore, and the
// user's own Google Drive and Gmail. Loaded by index.html only when
// firebase-config.js holds a config; otherwise the app stays local-only.

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
const [{ initializeApp }, A, F] = await Promise.all([
  import(SDK + 'firebase-app.js'),
  import(SDK + 'firebase-auth.js'),
  import(SDK + 'firebase-firestore.js'),
]);

export const COLS = ['projects', 'tasks', 'invoices', 'protocols'];
const cfg = window.FEMY_FIREBASE;
const app = initializeApp(cfg);
const auth = A.getAuth(app);
auth.languageCode = 'he';
let fs = F.initializeFirestore(app, {
  localCache: cfg.emulator ? F.memoryLocalCache() : F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
});
if (cfg.emulator) {
  A.connectAuthEmulator(auth, 'http://' + location.hostname + ':9099', { disableWarnings: true });
  F.connectFirestoreEmulator(fs, location.hostname, 8080);
}

const lower = (s) => String(s || '').trim().toLowerCase();
const admins = (cfg.admins || []).map(lower);
const shared = cfg.scope !== 'user';
const orgId = cfg.orgId || 'femy';

let me = null; // { uid, email, name, photo, role }
let base = null; // path segments of the data root
let unsubs = [];
let last = new Map(); // "col/id" -> stable JSON of what the server has
let handlers = {};

// JSON with sorted keys, so the same object always compares equal.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const clean = (o) => JSON.parse(JSON.stringify(o)); // drops undefined, which Firestore rejects

// ---------- Auth ----------
export function start(h) {
  handlers = h;
  A.getRedirectResult(auth).catch((e) => h.onError && h.onError(e));
  A.onAuthStateChanged(auth, (user) => { evaluate(user).catch((e) => h.onError && h.onError(e)); });
}

async function evaluate(user) {
  stopData();
  if (!user) { me = null; handlers.onState({ state: 'signedOut' }); return; }
  const email = lower(user.email);
  const isPassword = user.providerData.every((p) => p.providerId === 'password');
  if (isPassword && !user.emailVerified) { handlers.onState({ state: 'verify', email }); return; }
  me = { uid: user.uid, email, name: user.displayName || email.split('@')[0], photo: user.photoURL || '', role: 'member' };
  if (shared) {
    if (admins.includes(email)) me.role = 'admin';
    else {
      let snap;
      try { snap = await F.getDoc(F.doc(fs, 'orgs', orgId, 'members', email)); } catch (e) { snap = null; }
      if (!snap || !snap.exists()) { handlers.onState({ state: 'denied', email }); return; }
      me.role = snap.data().role === 'admin' ? 'admin' : 'member';
    }
    base = ['orgs', orgId];
  } else {
    me.role = 'admin';
    base = ['users', user.uid];
  }
  let profile = {};
  try {
    const p = await F.getDoc(F.doc(fs, 'users', user.uid));
    profile = p.exists() ? p.data() : {};
    if (!p.exists() || profile.email !== email) F.setDoc(F.doc(fs, 'users', user.uid), { email, name: me.name }, { merge: true }).catch(() => {});
  } catch (e) { /* offline on first run: no profile yet */ }
  handlers.onState({ state: 'ready', user: me, profile });
  startData();
}

const isSafariMobile = () => /iP(hone|ad|od)/.test(navigator.userAgent);
async function popupOrRedirect(provider) {
  try { return await A.signInWithPopup(auth, provider); } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code) && !isSafariMobile()) {
      return A.signInWithRedirect(auth, provider);
    }
    throw e;
  }
}
export function signInGoogle() {
  const p = new A.GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  return popupOrRedirect(p);
}
export const signInEmail = (email, pw) => A.signInWithEmailAndPassword(auth, email.trim(), pw);
export async function registerEmail(email, pw, name) {
  const res = await A.createUserWithEmailAndPassword(auth, email.trim(), pw);
  if (name) await A.updateProfile(res.user, { displayName: name });
  await A.sendEmailVerification(res.user);
  return res;
}
export const resetPassword = (email) => A.sendPasswordResetEmail(auth, email.trim());
export const resendVerification = () => auth.currentUser && A.sendEmailVerification(auth.currentUser);
export async function recheck() { if (auth.currentUser) { await auth.currentUser.reload(); await auth.currentUser.getIdToken(true); await evaluate(auth.currentUser); } }

// Signing out also clears this device's offline copy of the company data.
export async function signOut() {
  stopData();
  try { await A.signOut(auth); } catch (e) { /* ignore */ }
  try { await F.terminate(fs); await F.clearIndexedDbPersistence(fs); } catch (e) { /* ignore */ }
  try { sessionStorage.removeItem('femy-gtok'); } catch (e) { /* ignore */ }
}

// ---------- Data ----------
function startData() {
  const state = { settings: {} };
  const ready = new Set();
  let timer = null;
  const emit = () => {
    if (ready.size < COLS.length + 1) return;
    clearTimeout(timer);
    timer = setTimeout(() => handlers.onData({
      projects: state.projects.slice(), tasks: state.tasks.slice(), invoices: state.invoices.slice(),
      protocols: state.protocols.slice(), settings: Object.assign({}, state.settings),
    }), 30);
  };
  const fail = (e) => handlers.onError && handlers.onError(e);
  COLS.forEach((col) => {
    unsubs.push(F.onSnapshot(F.collection(fs, ...base, col), (snap) => {
      state[col] = snap.docs.map((d) => {
        const o = Object.assign({}, d.data(), { id: d.id });
        last.set(col + '/' + d.id, stable(o));
        return o;
      });
      for (const k of Array.from(last.keys())) if (k.startsWith(col + '/') && !state[col].some((o) => col + '/' + o.id === k)) last.delete(k);
      ready.add(col); emit();
    }, fail));
  });
  unsubs.push(F.onSnapshot(F.doc(fs, ...base, 'meta', 'settings'), (snap) => {
    state.settings = snap.exists() ? snap.data() : {};
    last.set('meta/settings', stable(state.settings));
    ready.add('meta'); emit();
  }, fail));
}
function stopData() { unsubs.forEach((u) => u()); unsubs = []; last = new Map(); }

// Writes only what changed since the server's last copy.
export function push(db) {
  if (!base) return Promise.resolve();
  const ops = [];
  COLS.forEach((col) => {
    const seen = new Set();
    (db[col] || []).forEach((item) => {
      if (!item || !item.id) return;
      const key = col + '/' + item.id;
      seen.add(key);
      const data = clean(item);
      const j = stable(data);
      if (last.get(key) !== j) { ops.push(['set', col, item.id, data]); last.set(key, j); }
    });
    for (const k of Array.from(last.keys())) if (k.startsWith(col + '/') && !seen.has(k)) { ops.push(['del', col, k.slice(col.length + 1)]); last.delete(k); }
  });
  const st = clean(db.settings || {});
  if (last.get('meta/settings') !== stable(st)) { ops.push(['set', 'meta', 'settings', st]); last.set('meta/settings', stable(st)); }
  const commits = [];
  for (let i = 0; i < ops.length; i += 400) {
    const b = F.writeBatch(fs);
    ops.slice(i, i + 400).forEach(([op, col, id, data]) => {
      const ref = F.doc(fs, ...base, col, id);
      if (op === 'set') b.set(ref, data); else b.delete(ref);
    });
    commits.push(b.commit());
  }
  return Promise.all(commits).catch((e) => { if (handlers.onError) handlers.onError(e); throw e; });
}

// ---------- Members (admin) ----------
export function watchMembers(cb) {
  return F.onSnapshot(F.collection(fs, 'orgs', orgId, 'members'), (snap) => cb(snap.docs.map((d) => Object.assign({ email: d.id }, d.data()))), () => cb(null));
}
export const addMember = (email, role) => F.setDoc(F.doc(fs, 'orgs', orgId, 'members', lower(email)), { role: role === 'admin' ? 'admin' : 'member', addedBy: me.email, addedAt: new Date().toISOString() });
export const removeMember = (email) => F.deleteDoc(F.doc(fs, 'orgs', orgId, 'members', lower(email)));
export const bootAdmins = admins;
export const isShared = shared;

// ---------- Private profile (Claude key etc.) ----------
// users/{uid} can be read and written only by that user (see firestore.rules).
export const setProfile = (partial) => F.setDoc(F.doc(fs, 'users', me.uid), partial, { merge: true });

// ---------- Google access token (Drive, Gmail) ----------
// Must be called straight from a click, before any other await, so the popup is allowed.
export const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive.file';
export const SCOPE_GMAIL = 'https://www.googleapis.com/auth/gmail.send';
let toks = {};
try { toks = JSON.parse(sessionStorage.getItem('femy-gtok') || '{}'); } catch (e) { toks = {}; }
export function hasToken(scope) { const t = toks[scope]; return !!(t && t.exp > Date.now() + 60000); }
export async function googleToken(scope) {
  if (hasToken(scope)) return toks[scope].token;
  const user = auth.currentUser;
  const p = new A.GoogleAuthProvider();
  p.addScope(scope);
  p.setCustomParameters({ login_hint: user.email });
  const linked = user.providerData.some((x) => x.providerId === 'google.com');
  const res = linked ? await A.reauthenticateWithPopup(user, p) : await A.linkWithPopup(user, p);
  const cred = A.GoogleAuthProvider.credentialFromResult(res);
  if (!cred || !cred.accessToken) throw new Error('no token');
  toks[scope] = { token: cred.accessToken, exp: Date.now() + 55 * 60000 };
  try { sessionStorage.setItem('femy-gtok', JSON.stringify(toks)); } catch (e) { /* ignore */ }
  return cred.accessToken;
}
function dropToken(scope) { delete toks[scope]; try { sessionStorage.setItem('femy-gtok', JSON.stringify(toks)); } catch (e) { /* ignore */ } }

async function gfetch(scope, token, url, opts) {
  const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token }, (opts && opts.headers) || {}) }));
  if (r.status === 401) dropToken(scope);
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error.message; } catch (e) { /* ignore */ }
    throw Object.assign(new Error(msg || 'HTTP ' + r.status), { status: r.status });
  }
  return r;
}

// ---------- Google Drive ----------
// drive.file: the app sees only files it created, in one folder of the user's Drive.
const FOLDER = 'פמי הנדסה - מערכת ניהול';
const DAPI = 'https://www.googleapis.com/drive/v3/files';
let folderId = null;
async function driveFolder(token) {
  if (folderId) return folderId;
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await (await gfetch(SCOPE_DRIVE, token, `${DAPI}?q=${q}&fields=files(id)&spaces=drive`)).json();
  if (found.files && found.files.length) return (folderId = found.files[0].id);
  const made = await (await gfetch(SCOPE_DRIVE, token, `${DAPI}?fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  })).json();
  return (folderId = made.id);
}
// Creates the file, or replaces it when fileId is given and still reachable.
export async function driveSave(token, name, blob, fileId) {
  const form = (meta) => {
    const f = new FormData();
    f.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    f.append('file', blob);
    return f;
  };
  const up = 'https://www.googleapis.com/upload/drive/v3/files';
  if (fileId) {
    try {
      return await (await gfetch(SCOPE_DRIVE, token, `${up}/${fileId}?uploadType=multipart&fields=id,name,webViewLink`, { method: 'PATCH', body: form({ name }) })).json();
    } catch (e) { if (e.status !== 404 && e.status !== 403) throw e; }
  }
  const parent = await driveFolder(token);
  return (await gfetch(SCOPE_DRIVE, token, `${up}?uploadType=multipart&fields=id,name,webViewLink`, { method: 'POST', body: form({ name, parents: [parent] }) })).json();
}
export async function driveList(token) {
  const parent = await driveFolder(token);
  const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
  const r = await (await gfetch(SCOPE_DRIVE, token, `${DAPI}?q=${q}&orderBy=modifiedTime desc&pageSize=50&fields=files(id,name,mimeType,webViewLink,modifiedTime)`)).json();
  return r.files || [];
}
export async function driveRead(token, id) { return (await gfetch(SCOPE_DRIVE, token, `${DAPI}/${id}?alt=media`)).text(); }

// ---------- Gmail ----------
const b64utf8 = (s) => btoa(unescape(encodeURIComponent(s)));
const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n');
const encWord = (s) => '=?UTF-8?B?' + b64utf8(s) + '?=';
async function blobB64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export async function gmailSend(token, { to, cc, subject, text, attachment }) {
  const bd = 'femy' + Math.random().toString(36).slice(2);
  let m = `To: ${to}\r\n` + (cc ? `Cc: ${cc}\r\n` : '') + `Subject: ${encWord(subject)}\r\nMIME-Version: 1.0\r\n`
    + `Content-Type: multipart/mixed; boundary="${bd}"\r\n\r\n`
    + `--${bd}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64utf8(text))}`;
  if (attachment) {
    const fn = encWord(attachment.name);
    m += `--${bd}\r\nContent-Type: ${attachment.blob.type || 'application/octet-stream'}; name="${fn}"\r\n`
      + `Content-Disposition: attachment; filename="${fn}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(await blobB64(attachment.blob))}`;
  }
  m += `--${bd}--\r\n`;
  const raw = btoa(m).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gfetch(SCOPE_GMAIL, token, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }),
  });
}
