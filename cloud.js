// פמי הנדסה - חיבור לענן (Firebase).
// Sign-in (Google or email + password) and shared data in Firestore. Loaded by index.html only when
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
// Photos of protocol topics: one document each (a JPEG data URL, under Firestore's 1 MB), read only when shown.
export const putPhoto = (id, data) => (base ? F.setDoc(F.doc(fs, ...base, 'photos', id), { data, at: new Date().toISOString() }) : Promise.resolve());
export async function getPhoto(id) {
  if (!base) return '';
  const snap = await F.getDoc(F.doc(fs, ...base, 'photos', id));
  return snap.exists() ? snap.data().data || '' : '';
}
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

// Google Calendar, Gmail and Drive are handled by google.js (per user, also in local mode).
