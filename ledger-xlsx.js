// פמי הנדסה - קריאת טבלאות חשבונות יועצים מקובצי אקסל.
// Reads the office's "חשבונות ..." Excel sheets (one row per consultant: field, name, total planning cost and
// the bills paid so far, plus optional contact list and developer deposits) into a ledger object that
// index.html shows on the accounts page. The same code runs in node to build accounts/consultant-accounts.json.
(function (root) {
  'use strict';

  // ---------- Minimal .xlsx reader (JSZip + regex, so it also runs in node) ----------
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : ENT[e] != null ? ENT[e] : m));
  const colIndex = (ref) => {
    const letters = ref.replace(/\d+/g, '');
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  };
  const texts = (xml) => {
    const out = [];
    xml.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (m, t) => { out.push(decode(t)); return m; });
    return out.join('');
  };

  // Fill colour of each cell style, as a key such as "rgb:FF92D050" or "theme:5:0.4" ('' when none).
  function styleFills(xml) {
    const fills = [];
    const fs = (xml.match(/<fills\b[\s\S]*?<\/fills>/) || [''])[0];
    fs.replace(/<fill>([\s\S]*?)<\/fill>/g, (m, f) => {
      const solid = /patternType="solid"/.test(f);
      const fg = f.match(/<fgColor\b([^>]*)\/?>/);
      let key = '';
      if (solid && fg) {
        const rgb = fg[1].match(/\brgb="(\w+)"/);
        const th = fg[1].match(/\btheme="(\d+)"/);
        const tint = fg[1].match(/\btint="(-?[\d.]+)"/);
        if (rgb) key = 'rgb:' + rgb[1].toUpperCase();
        else if (th) key = 'theme:' + th[1] + ':' + (tint ? Math.round(Number(tint[1]) * 10) / 10 : 0);
      }
      fills.push(key);
      return m;
    });
    const xfs = [];
    const cx = (xml.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/) || [''])[0];
    cx.replace(/<xf\b([^>]*)/g, (m, a) => { const f = a.match(/\bfillId="(\d+)"/); xfs.push(f ? fills[Number(f[1])] || '' : ''); return m; });
    return xfs;
  }

  // Returns the first worksheet as an array of rows, each an array of cell values (string, number or null).
  // rows.fills holds the matching fill-colour keys (the sheets mark paid / submitted bills by colour).
  async function readXlsx(data, JSZip) {
    const zip = await JSZip.loadAsync(data);
    const read = (p) => (zip.file(p) ? zip.file(p).async('string') : Promise.resolve(''));
    const shared = [];
    const ss = await read('xl/sharedStrings.xml');
    ss.replace(/<si>([\s\S]*?)<\/si>/g, (m, si) => { shared.push(texts(si.replace(/<rPh[\s\S]*?<\/rPh>/g, ''))); return m; });
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const wb = await read('xl/workbook.xml');
    const rels = await read('xl/_rels/workbook.xml.rels');
    const first = wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/);
    if (first) {
      const rel = rels.match(new RegExp('<Relationship\\b[^>]*\\bId="' + first[1] + '"[^>]*>'));
      const target = rel && rel[0].match(/Target="([^"]+)"/);
      if (target) sheetPath = target[1].replace(/^\//, '').replace(/^(?!xl\/)/, 'xl/');
    }
    const xfFill = styleFills(await read('xl/styles.xml'));
    const xml = await read(sheetPath);
    if (!xml) throw new Error('בקובץ לא נמצא גיליון');
    const rows = [];
    const fills = [];
    xml.replace(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, (m, attrs, body) => {
      const rn = attrs.match(/\br="(\d+)"/);
      const r = rn ? Number(rn[1]) - 1 : rows.length;
      const row = [];
      const frow = [];
      (body || '').replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m2, ca, cb) => {
        const ref = ca.match(/\br="([A-Z]+)\d+"/);
        if (!ref) return m2;
        const t = (ca.match(/\bt="(\w+)"/) || [])[1] || 'n';
        const v = cb && cb.match(/<v>([\s\S]*?)<\/v>/);
        let val = null;
        if (t === 's') val = v ? shared[Number(v[1])] : null;
        else if (t === 'inlineStr') val = texts(cb || '');
        else if (t === 'str') val = v ? decode(v[1]) : null;
        else if (t === 'e') val = null;
        else if (t === 'b') val = v ? v[1] === '1' : null;
        else val = v ? Number(v[1]) : null;
        const st = ca.match(/\bs="(\d+)"/);
        if (st && xfFill[Number(st[1])]) frow[colIndex(ref[1])] = xfFill[Number(st[1])];
        if (val != null) row[colIndex(ref[1])] = val;
        return m2;
      });
      rows[r] = row;
      fills[r] = frow;
      return m;
    });
    for (let i = 0; i < rows.length; i++) { rows[i] = rows[i] || []; fills[i] = fills[i] || []; }
    rows.fills = fills;
    return rows;
  }

  // ---------- Ledger parser ----------
  const txt = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const num = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^\s*-?[\d,]+(\.\d+)?\s*$/.test(v)) return Number(v.replace(/[,\s]/g, ''));
    return null;
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  const norm = (s) => txt(s).replace(/["'״׳]/g, '').toLowerCase();
  const SKIP = /סה"כ|סה״כ|יתרה|התקבל מה|הפקדות/;

  // rows: array of arrays (first sheet). Returns { title, rows: [...], deposits: [...] } or throws.
  function parseLedger(rows) {
    const h = rows.findIndex((r) => r.some((c) => /עלות/.test(txt(c))) && r.some((c) => /חשבון\s*1(?!\d)/.test(txt(c))));
    if (h < 0) throw new Error('לא נמצאה בקובץ שורת כותרות עם "עלות תכנון" ו"חשבון 1"');
    const head = rows[h].map(txt);
    const find = (test) => head.findIndex((c, i) => c && test(c, i));
    const totalG = find((c) => /עלות/.test(c) && /כולל מע/.test(c));
    const totalN = find((c) => /עלות/.test(c) && !/כולל מע/.test(c));
    const totalCol = totalG >= 0 ? totalG : totalN;
    const pays = [];
    for (let n = 1; n <= 20; n++) {
      const re = new RegExp('חשבון\\s*' + n + '(?!\\d)');
      const g = find((c) => re.test(c) && (/שולם/.test(c) || /כולל מע/.test(c)));
      const net = find((c) => re.test(c) && !/שולם/.test(c) && !/כולל מע/.test(c));
      if (g < 0 && net < 0) break;
      pays.push({ g, net });
    }
    let fieldCol = find((c) => /תחום/.test(c));
    let nameCol = find((c) => /^שם/.test(c));
    const serviceCol = find((c) => /סוג השירות/.test(c));
    if (fieldCol < 0) fieldCol = totalCol - 2;
    if (nameCol < 0) nameCol = totalCol - 1;
    const groupCol = serviceCol < 0 ? fieldCol - 1 : -1;

    // Title: text above the header row, e.g. "פירוט חשבונות שמידמן / לקוח - ... / תאריך ...".
    const title = rows.slice(0, h).flat().map((c) => (typeof c === 'string' ? c.split('\n').map(txt).filter(Boolean).join(' · ') : ''))
      .find((s) => /חשבונות/.test(s)) || '';

    // Contacts table (תחום | שם | איש קשר | טלפון | טלפון נוסף | מייל | הצעת מחיר), above the payments table.
    const contacts = [];
    const ch = rows.findIndex((r, i) => i < h && r.some((c) => /איש קשר/.test(txt(c))));
    if (ch >= 0) {
      const ct = rows[ch].map(txt);
      const at = (re) => ct.findIndex((c) => re.test(c));
      const cc = { field: at(/תחום/), name: at(/^שם/), person: at(/איש קשר/), phone: at(/^טלפון$/), phone2: at(/טלפון נוסף/), email: at(/מייל/), quote: at(/הצעת מחיר|מחיר/) };
      for (let r = ch + 1; r < h; r++) {
        const row = rows[r] || [];
        const name = txt(row[cc.name]);
        if (!name) { if (contacts.length && !txt(row[cc.field])) break; continue; }
        const raw = (k) => (cc[k] >= 0 && typeof row[cc[k]] === 'string' ? row[cc[k]].split('\n').map(txt).filter(Boolean).join(', ') : '');
        contacts.push({ field: txt(row[cc.field]), name, person: raw('person'), phone: raw('phone'), phone2: raw('phone2'), email: raw('email'), quote: num(row[cc.quote]) });
      }
    }
    const contactFor = (field, name) => contacts.find((c) => norm(c.name) === norm(name) && norm(c.field) === norm(field))
      || contacts.find((c) => norm(c.name) === norm(name));

    // Bill colours: the sheets have a legend ("שולם" / "הוגש חשבון") next to a coloured cell. Without a
    // legend the office template is assumed: green = paid, theme accent 2 (40%) = bill submitted, not paid yet.
    const fills = rows.fills || [];
    const legend = (re) => {
      for (let r = 0; r < rows.length; r++) {
        const c = (rows[r] || []).findIndex((v) => re.test(txt(v)));
        if (c < 0) continue;
        for (const d of [1, -1, 2, -2]) { const k = (fills[r] || [])[c + d]; if (k) return k; }
      }
      return '';
    };
    const billedKey = legend(/^הוגש/) || 'theme:5:0.4';

    const out = [];
    let group = '';
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const all = row.map(txt).join(' ');
      if (SKIP.test(all)) continue;
      const gl = groupCol >= 0 ? txt(row[groupCol]) : '';
      if (gl) group = gl;
      const field = txt(row[fieldCol]);
      const name = txt(row[nameCol]);
      const service = serviceCol >= 0 ? txt(row[serviceCol]) : '';
      if (!field && !name && !service) continue;
      const total = num(row[totalG]) != null ? num(row[totalG]) : totalN >= 0 ? num(row[totalN]) : null;
      const frow = fills[r] || [];
      const payments = pays.map((p) => {
        const col = p.g >= 0 && num(row[p.g]) != null ? p.g : p.net >= 0 && num(row[p.net]) != null ? p.net : -1;
        const v = col >= 0 ? num(row[col]) : null;
        if (!v) return null;
        const o = { amount: round2(v) };
        if (frow[col] && frow[col] === billedKey) o.billed = true;
        return o;
      });
      while (payments.length && payments[payments.length - 1] == null) payments.pop();
      if (total == null && !payments.length) {
        if (service && !field && !name) group = service; // a section label such as "שולם ע"י היזם"
        continue;
      }
      const item = { group, field, name, total: total == null ? null : round2(total), payments };
      if (service && !/^ייעוץ\s*\/?\s*תכנון$/.test(service)) item.service = service;
      const c = name ? contactFor(field, name) : null;
      if (c) ['person', 'phone', 'phone2', 'email'].forEach((k) => { if (c[k]) item[k] = c[k]; });
      out.push(item);
    }
    if (!out.length) throw new Error('לא נמצאו בקובץ שורות של יועצים עם עלות או תשלומים');

    // Developer deposits ("הפקדות יזם לפמי": חשבון | תאריך | סכום).
    const deposits = [];
    rows.forEach((row, r) => row.forEach((c, ci) => {
      if (!/הפקדות/.test(txt(c))) return;
      const hd = (rows[r + 1] || []).map(txt);
      const amt = hd.findIndex((x, i) => i >= ci && /סכום/.test(x));
      const lab = hd.findIndex((x, i) => i >= ci && /חשבון/.test(x));
      const dt = hd.findIndex((x, i) => i >= ci && /תאריך/.test(x));
      if (amt < 0) return;
      for (let k = r + 2; k < rows.length; k++) {
        const a = num((rows[k] || [])[amt]);
        if (a == null) break;
        const d = (rows[k] || [])[dt];
        deposits.push({ label: lab >= 0 && rows[k][lab] != null ? String(rows[k][lab]) : '', date: dt >= 0 && d != null ? String(d) : '', amount: a });
      }
    }));
    return { title, rows: out, deposits };
  }

  async function ledgerFromXlsx(data, JSZip) { return parseLedger(await readXlsx(data, JSZip)); }

  const api = { readXlsx, parseLedger, ledgerFromXlsx };
  root.FemyLedger = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
