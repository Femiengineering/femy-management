// Reads a project's Gantt / schedule file (a PDF exported from MS Project or from Excel, an Excel file, or a
// Google Sheet exported as Excel) into rows the site draws as its Gantt chart:
//   [{ name, s: 'YYYY-MM-DD', e: 'YYYY-MM-DD', pct, group }]
// group: a heading row (a summary such as "עבודות גמר - 180 ימים"), drawn over the rows under it.
(function () {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const DATE_RE = /(^|[^\d/.])(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})(?![\d/.])/g;
  const DAYS_RE = /(\d+(?:\.\d+)?)\s*(?:ימי\s*עבודה|ימים|יום|days?(?![A-Za-z]))|days?\s*(\d+(?:\.\d+)?)/i;
  const PCT_RE = /(^|\D)(\d{1,3})\s*%/;
  // A token that is not part of a task's name: a date, a percent, a duration, an ID number, a "?" mark.
  const JUNK_RE = /^(?:[?✓✔]+|\d+|\d{1,3}\s*%|\d+(?:\.\d+)?\s*(?:ימים|יום|days?)|days?\s*\d+|ימים|יום|days?|-)$/i;

  function dates(s) {
    const out = []; let m; DATE_RE.lastIndex = 0;
    while ((m = DATE_RE.exec(s))) {
      const d = +m[2]; const mo = +m[3]; let y = +m[4]; if (y < 100) y += 2000;
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y > 2000 && y < 2100) out.push(iso(y, mo, d));
    }
    return out;
  }
  // The end of a task that has only a start and a duration in work days (Sunday to Thursday).
  function addWorkDays(s, n) {
    const d = new Date(s + 'T12:00:00Z'); let left = Math.max(0, Math.round(n) - 1);
    while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 5 && w !== 6) left--; }
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const clean = (s) => s.replace(/\s+/g, ' ').replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, '').trim();

  // ---------- PDF ----------
  // The page's words in lines (top to bottom, the words of a line from right to left), with their x positions.
  async function pdfLines(buf, pdfjs) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    const lines = [];
    for (let n = 1; n <= Math.min(doc.numPages, 8); n++) {
      const pg = await doc.getPage(n); const vp = pg.getViewport({ scale: 1 });
      const tc = await pg.getTextContent();
      const rows = [];
      tc.items.forEach((it) => {
        if (!it.str || !it.str.trim()) return;
        const t = pdfjs.Util.transform(vp.transform, it.transform);
        const y = t[5]; const x = t[4];
        let r = rows.find((q) => Math.abs(q.y - y) <= 2.5);
        if (!r) { r = { y, items: [], page: n, w: vp.width }; rows.push(r); }
        r.items.push({ x, s: it.str });
      });
      rows.sort((a, b) => a.y - b.y).forEach((r) => { r.items.sort((a, b) => b.x - a.x); lines.push(r); });
    }
    return lines;
  }
  async function fromPdf(buf, pdfjs) {
    const lines = await pdfLines(buf, pdfjs);
    // The table's date columns: where most full dates (with a year) stand. A date elsewhere (the print date in
    // the page header, a legend) is not a task's.
    const xs = {};
    lines.forEach((l) => l.items.forEach((it) => { if (dates(it.s).length) { const k = Math.round(it.x / 6); xs[k] = (xs[k] || 0) + 1; } }));
    const cols = Object.keys(xs).map(Number).sort((a, b) => xs[b] - xs[a]);
    if (!cols.length) return [];
    const top = xs[cols[0]];
    const dateCols = cols.filter((k) => xs[k] >= Math.max(2, top * 0.35)).map((k) => k * 6);
    const inCol = (x) => dateCols.some((c) => Math.abs(c - x) <= 14);
    const dMin = Math.min.apply(null, dateCols); const dMax = Math.max.apply(null, dateCols);
    // The names are on the side of the dates towards the nearer edge of the page; the chart is on the other side.
    const w = lines[0].w; const nameRight = (w - dMax) < dMin;
    const nameSide = (x) => (nameRight ? x > dMax + 8 : x < dMin - 8);
    const out = []; let last = null; let lastY = 0; let gap = 0;
    lines.forEach((l) => {
      const dItems = l.items.filter((it) => inCol(it.x) && dates(it.s).length);
      const words = l.items.filter((it) => nameSide(it.x)).map((it) => it.s);
      const near = (x) => dateCols.some((c) => Math.abs(c - x) <= 60);
      const text = l.items.filter((it) => nameSide(it.x) || near(it.x)).map((it) => it.s).join(' ');
      const name = clean(words.filter((s) => !JUNK_RE.test(s.trim()) && !dates(s).length).join(' '));
      if (dItems.length) {
        const ds = [].concat.apply([], dItems.map((it) => dates(it.s))).sort();
        if (!name || /^(date|תאריך|project|פרויקט)\b/i.test(name)) return;
        let s = ds[0]; let e = ds[ds.length - 1];
        if (ds.length === 1) { const dm = DAYS_RE.exec(text); if (dm) e = addWorkDays(s, Number(dm[1] || dm[2])); }
        const pm = PCT_RE.exec(text);
        last = { name, s, e, pct: pm ? Math.min(100, Number(pm[2])) : null };
        if (gap === 0 && out.length) gap = l.y - lastY;
        out.push(last); lastY = l.y;
      } else if (name && /(ימים|יום|days?(?![A-Za-z]))/i.test(text) && /\d/.test(text)) {
        // A heading with only a duration: "התארגנות אתר - 10 ימים".
        last = null; out.push({ name: clean(name.replace(/-\s*$/, '')), group: true }); lastY = l.y;
      } else if (name && last && l.y - lastY < 14 && !/:/.test(name) && (last.more = (last.more || 0) + 1) <= 3) {
        // The next line of a long name.
        last.name = clean(last.name + ' ' + name);
      }
    });
    out.forEach((r) => { delete r.more; });
    return finish(out);
  }

  // ---------- Excel / Google Sheets ----------
  const xlDate = (v) => {
    if (typeof v === 'number' && v > 30000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
    if (typeof v === 'string') { const d = dates(v); if (d.length) return d[0]; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim()); if (m) return iso(+m[1], +m[2], +m[3]); }
    return '';
  };
  function fromRows(rows) {
    // The header row tells which column is which, when there is one.
    let head = -1; const col = {};
    for (let i = 0; i < Math.min(rows.length, 30) && head < 0; i++) {
      const r = rows[i] || [];
      r.forEach((v, j) => {
        const t = typeof v === 'string' ? v.trim() : '';
        if (/^(שם|משימה|פעילות|תיאור|שם (ה)?(משימה|פעילות)|task( name)?|name)$/i.test(t)) col.name = j;
        else if (/^(התחלה|תאריך התחלה|start)$/i.test(t)) col.s = j;
        else if (/^(סיום|תאריך סיום|finish|end)$/i.test(t)) col.e = j;
        else if (/(%|התקדמות|ביצוע|progress|complete)/i.test(t)) col.pct = j;
        else if (/^(משך|duration|ימים)$/i.test(t)) col.dur = j;
      });
      if (col.s != null && (col.name != null || col.e != null)) head = i;
    }
    const out = [];
    for (let i = head + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      let s = col.s != null ? xlDate(r[col.s]) : ''; let e = col.e != null ? xlDate(r[col.e]) : '';
      let name = col.name != null && typeof r[col.name] === 'string' ? r[col.name] : '';
      if (head < 0) {
        // No header: the dates of the row, and its longest text.
        const ds = r.map(xlDate).filter(Boolean).sort(); s = ds[0] || ''; e = ds[ds.length - 1] || '';
        name = r.filter((v) => typeof v === 'string' && !xlDate(v) && /[א-תA-Za-z]/.test(v)).sort((a, b) => b.length - a.length)[0] || '';
      }
      name = clean(String(name || ''));
      if (!name) continue;
      if (!s) { if (/(ימים|יום|days?)/.test(r.join(' '))) out.push({ name, group: true }); continue; }
      if (!e && col.dur != null) { const n = parseFloat(r[col.dur]); if (n > 0) e = addWorkDays(s, n); }
      let pct = null;
      if (col.pct != null) { const v = r[col.pct]; pct = typeof v === 'number' ? Math.round(v <= 1 ? v * 100 : v) : (PCT_RE.exec(String(v || '')) || [])[2]; pct = pct == null ? null : Math.min(100, Number(pct)); }
      out.push({ name, s, e: e || s, pct });
    }
    return finish(out);
  }

  // Headings without tasks under them go; a heading gets the dates of its tasks.
  function finish(rows) {
    const out = [];
    // A file where every task stands at 0% does not report progress at all.
    if (rows.every((r) => r.group || !r.pct)) rows.forEach((r) => { r.pct = null; });
    rows.forEach((r) => { if (r.e && r.s && r.e < r.s) { const x = r.s; r.s = r.e; r.e = x; } });
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.group) { out.push(r); continue; }
      const kids = []; for (let j = i + 1; j < rows.length && !rows[j].group; j++) kids.push(rows[j]);
      if (!kids.length) continue;
      const known = kids.filter((k) => k.pct != null);
      out.push({ name: r.name, group: true, s: kids.map((k) => k.s).sort()[0], e: kids.map((k) => k.e).sort().pop(), pct: known.length ? Math.round(known.reduce((a, k) => a + k.pct, 0) / known.length) : null });
    }
    return out.slice(0, 300);
  }

  const api = { fromPdf, fromRows };
  if (typeof window !== 'undefined') window.FemyGantt = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
