// פמי הנדסה - קריאת גיליון המשימות ("משימות פמי" ב-Drive) לתוך האתר.
// מקבל את קובץ ה-Excel שמייצאים מהגיליון, ומחזיר משימות (מכל לשונית לקוח) ואנשי קשר (מלשונית "סיכום").
// מבנה הגיליון: בכל לשונית לקוח, שורה 3 היא הכותרות, שורה עם טקסט רק בעמודה A היא שם פרויקט,
// ומתחתיה שורות המשימות. בלשונית "סיכום" יש טבלת "אנשי קשר" עם שורות קטגוריה ושורות אנשי קשר.
(function (root) {
  'use strict';

  const SUMMARY = 'סיכום';
  const PRIORITY = { 'דחוף מאוד': 'urgent', 'דחוף': 'high', 'רגיל': 'medium', 'נמוך': 'low' };
  const STATUS = { 'פתוח': 'todo', 'בטיפול': 'doing', 'ממתין לאחרים': 'waiting', 'ממתין': 'waiting', 'בוצע': 'done', 'הושלם': 'done' };

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  // A cell that is empty, or holds only a formula error (#REF!, #N/A ...), counts as empty when finding project headings.
  const blank = (x) => { const c = clean(x); return !c || /^#(REF!|N\/A|VALUE!|NAME\?|DIV\/0!|NUM!|NULL!|ERROR!)$/.test(c); };
  // Headings that gather a client's general tasks, not a project ("כללי – עיריית נתיבות", "משימות משרד").
  const GENERAL_GROUP = /^(כללי|משימות משרד|משימות כלליות)/;
  const pad = (n) => String(n).padStart(2, '0');
  // Short stable hash, for ids of rows that have no number.
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // "17.11.2026", "25/11/2026", "17.11.2026 11:38" or an Excel day number -> "2026-11-17".
  function toDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    const m = String(v).match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
    if (!m) return '';
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${pad(m[2])}-${pad(m[1])}`;
  }

  // ---------- Minimal .xlsx reader (needs JSZip) ----------
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
  const texts = (xml) => { let out = ''; xml.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, t) => { out += decode(t); }); return out; };
  const colIndex = (ref) => { let n = 0; const letters = ref.match(/^[A-Z]+/)[0]; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

  async function readXlsx(data, JSZipLib) {
    const zip = await (JSZipLib || root.JSZip).loadAsync(data);
    const file = (p) => zip.file(p) ? zip.file(p).async('string') : Promise.resolve('');
    const shared = [];
    (await file('xl/sharedStrings.xml')).replace(/<si>([\s\S]*?)<\/si>/g, (_, si) => { shared.push(texts(si)); });
    const wb = await file('xl/workbook.xml');
    const rels = await file('xl/_rels/workbook.xml.rels');
    const target = {};
    rels.replace(/<Relationship\s([^>]*)\/?>/g, (_, a) => {
      const id = (a.match(/Id="([^"]+)"/) || [])[1]; const t = (a.match(/Target="([^"]+)"/) || [])[1];
      if (id && t) target[id] = t.replace(/^\/?xl\//, '').replace(/^\//, '');
    });
    const sheets = [];
    const re = /<sheet\s([^>]*)\/?>/g; let m;
    while ((m = re.exec(wb))) {
      const name = decode((m[1].match(/name="([^"]*)"/) || [])[1] || '');
      const rid = (m[1].match(/r:id="([^"]+)"/) || [])[1];
      const xml = await file('xl/' + target[rid]);
      const rows = [];
      xml.replace(/<row\s[^>]*?r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g, (_, r, body) => {
        const cells = [];
        (body || '').replace(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (__, attrs, inner) => {
          const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1]; if (!ref) return;
          const type = (attrs.match(/t="([^"]+)"/) || [])[1];
          const v = ((inner || '').match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          let val = '';
          if (type === 's') val = shared[Number(v)] || '';
          else if (type === 'inlineStr') val = texts(inner || '');
          else if (type === 'str' || type === 'e') val = decode(v || '');
          else if (type === 'b') val = v === '1';
          else if (v != null && v !== '') val = Number(v);
          cells[colIndex(ref)] = val;
        });
        rows[Number(r) - 1] = cells;
      });
      sheets.push({ name, rows });
    }
    return sheets;
  }

  // ---------- Sheet -> site data ----------
  function parse(sheets) {
    const tasks = [], groups = [], contacts = [];
    sheets.forEach((sh) => {
      const rows = sh.rows;
      if (clean(sh.name) === SUMMARY) { parseContacts(rows, contacts); return; }
      const hi = rows.findIndex((r) => r && clean(r[1]) === 'משימה');
      if (hi < 0) return;
      const head = rows[hi].map(clean);
      const col = (name) => head.findIndex((h) => h === name);
      const C = { num: 0, title: 1, detail: col('פירוט'), who: col('מטפל'), due: col('תאריך יעד'), pri: col('דחיפות'), status: col('סטטוס'),
        source: col('מקור / הערות'), updated: col('עדכון אחרון'), contact: col('מי מטפל'), phone: col('טלפון') };
      const client = clean(sh.name);
      let group = '';
      for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i]; if (!r) continue;
        const get = (k) => (C[k] >= 0 ? r[C[k]] : '');
        const a = clean(r[0]), title = clean(get('title'));
        if (a && !title && !/^[\d.]+$/.test(a) && r.slice(1).every(blank)) {
          group = GENERAL_GROUP.test(a) ? '' : a;
          if (group) groups.push({ client, name: group });
          continue;
        }
        if (!title) continue;
        const contact = clean(get('contact')), phone = clean(get('phone'));
        const notes = [clean(get('detail')), contact ? `איש קשר: ${contact}${phone ? ' ' + phone : ''}` : '', clean(get('source')) ? 'מקור: ' + clean(get('source')) : ''].filter(Boolean).join('\n');
        tasks.push({
          id: 'sh-' + hash(client + '|' + group + '|' + (a || title)),
          num: a, client, group, title, notes,
          assignee: clean(get('who')), contactName: contact, contactPhone: phone,
          due: toDate(get('due')),
          priority: PRIORITY[clean(get('pri'))] || 'medium',
          status: STATUS[clean(get('status'))] || 'todo',
          sheetUpdated: clean(typeof get('updated') === 'number' ? toDate(get('updated')) : get('updated')),
        });
      }
    });
    return { tasks, groups, contacts };
  }

  function parseContacts(rows, out) {
    const start = rows.findIndex((r) => r && /^אנשי קשר/.test(clean(r[0])));
    if (start < 0) return;
    const hi = rows.findIndex((r, i) => i > start && r && clean(r[1]) === 'שם');
    if (hi < 0) return;
    const head = rows[hi].map(clean);
    const col = (name) => head.findIndex((h) => h === name);
    const C = { cat: 0, name: col('שם'), phone: col('טלפון'), email: col('מייל'), role: col('ארגון / תפקיד'), projects: col('פרויקטים') };
    let section = '';
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i]; if (!r) continue;
      const get = (k) => (C[k] >= 0 ? clean(r[C[k]]) : '');
      const first = clean(r[0]), name = get('name');
      if (first && !name && r.slice(1).every((x) => !clean(x))) { section = first; continue; }
      if (!name) continue;
      out.push({ id: 'ct-' + hash(name + '|' + get('email') + '|' + get('phone')), section, category: first, name, phone: get('phone'), email: get('email'), role: get('role'), projects: get('projects') });
    }
  }

  // Matches a project heading in the sheet ("מכבי השלום – בריאות הנפש, שטח גדול (אגדתא)") to a project
  // on the site, by the distinctive words they share (names, numbers), not generic ones like "בית ספר".
  // Returns the best project, or null when nothing fits well enough.
  const GENERIC = ['של', 'עם', 'את', 'בית', 'ספר', 'בתי', 'בי"ס', 'ביס', 'מגרש', 'רחוב', 'מרכז', 'עיריית', 'כללי', 'שלב', 'תוספת', 'תכנון', 'מבנה', 'מבני', 'פרויקט', 'משימות'];
  const words = (s) => clean(s).replace(/[–\-(),'׳״/+:.]/g, ' ').split(' ').map((w) => w.replace(/^ו(?=..)/, ''))
    .filter((w) => w.length > 1 && !GENERIC.includes(w));
  const same = (a, b) => a === b || (a.length > 2 && b.length > 2 && (a.startsWith(b) || b.startsWith(a)));
  function matchProject(group, client, projects) {
    const cw = words(client);
    const g = words(group).filter((w) => !cw.some((c) => same(w, c)));
    let best = null, bestScore = 0;
    projects.forEach((p) => {
      // A project's other names (p.aliases, e.g. its heading in the sheet) count like its name.
      [p.name].concat(p.aliases || []).forEach((name) => {
        const nw = words(name), pw = words(name + ' ' + (p.location || ''));
        const hit = g.filter((w) => pw.some((x) => same(w, x))).length;
        let score = hit ? hit / Math.max(Math.min(g.length, nw.length), 1) : 0;
        if (hit && cw.some((w) => words(p.client || '').some((x) => same(w, x)))) score += 0.2;
        if (score > bestScore) { bestScore = score; best = p; }
      });
    });
    if (bestScore >= 0.6) return best;
    // A tab that is itself one project ("שמידמן 3").
    const own = cw.length ? projects.filter((p) => cw.every((w) => words(p.name).some((x) => same(w, x)))) : [];
    return own.length === 1 ? own[0] : null;
  }

  const api = { readXlsx, parse, matchProject, toDate, hash };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FemySheet = api;
})(typeof window !== 'undefined' ? window : globalThis);
