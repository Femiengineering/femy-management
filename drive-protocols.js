// פמי הנדסה - פרוטוקולים מה-Drive: איתור, סיווג ושיוך לפרויקט.
// Finds the meeting summaries and execution / supervision reports in the "פרויקטים פמי" folder and
// links each one to its project by the folder it sits in. Two kinds:
//   meeting - סיכומי פגישות: planning / coordination / consultants meetings, tours, committee protocols
//   report  - דוחות ביצוע: supervision reports, upper supervision, handover and rejects reports
// The same file runs in the browser (live sync with the user's Google account) and in Node
// (building protocols/drive-protocols.json, the list the site shows before any sync).
(function (root) {
  'use strict';

  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const DOC_MIMES = {
    'application/pdf': 'pdf',
    'application/vnd.google-apps.document': 'gdoc',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  };
  // Words a document name must have to be looked at all (Drive "name contains" matches word prefixes).
  const NAME_WORDS = ['סיכום', 'סיכומי', 'פרוטוקול', 'פרוקטוקול', 'פרוטוקוך', 'פיקוח', 'דוח', 'דוחות', 'ישיבה', 'פגישה', 'פגישות', 'סיור', 'מסירה'];

  // Consultant reports, price comparisons and the like are not protocols.
  const EXCLUDE = /קרקע|תרמי|אקוסטי|עשן|להיתר|הצעות מחיר|הצעת מחיר|אומדן|אומדנים|עלויות|כמויות|מיכון|תכניות מפורטות|מגנטי|מפרט/;
  const SKIP_FOLDER = /תמונות/;
  const REPORTS = [
    [/פיקוח עליון/, 'פיקוח עליון'],
    [/דו"?ח(ות)? פיקוח|פיקוח/, 'דוח פיקוח'],
    [/מסירה/, 'דוח מסירה'],
    [/ריג.?קט/, 'דוח ריג\'קטים'],
    [/ביק[ו]?ר[וי]ים/, 'דוח ביקור'],
    [/סיכומי ביצוע|דו"?ח ביצוע/, 'דוח ביצוע'],
  ];
  const MEETINGS = [
    [/סיור קבלנ|סיור הריסה|סיור קבלני/, 'סיור קבלנים'],
    [/סיור/, 'סיכום סיור'],
    [/וועדה|ועדה|תדפיס_?פרוטוקול/, 'פרוטוקול ועדה'],
    [/שימוע/, 'שימוע'],
    [/יועצים/, 'פגישת יועצים'],
    [/תיאום/, 'פגישת תיאום'],
    [/התנע/, 'פגישת התנעה'],
    [/תכנון/, 'פגישת תכנון'],
    [/סיכום|פרוטוקול|פרוקטוקול|פרוטוקוך|ישיבה|פגיש/, 'סיכום פגישה'],
  ];

  const clean = (s) => String(s || '').replace(/[‎‏‪-‮⁦-⁩]/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  // "סיכום פגישה 18.01.26.pdf" -> "סיכום פגישה 18.01.26"
  const baseName = (name) => clean(String(name || '').replace(/\.(pdf|docx?|DOCX?|PDF)$/, '')).replace(/\s*\(\d+\)$/, '').replace(/\s*\[\d+\]$/, '').replace(/[-\s]+$/, '').trim();

  function classify(name, mimeType) {
    if (!DOC_MIMES[mimeType]) return null;
    const t = clean(name);
    if (EXCLUDE.test(t)) return null;
    for (const [re, label] of REPORTS) if (re.test(t)) return { kind: 'report', label };
    for (const [re, label] of MEETINGS) if (re.test(t)) return { kind: 'meeting', label };
    return null;
  }

  const pad = (n) => String(n).padStart(2, '0');
  // The date in the name ("23.11.26", "6.5.25", "25.05.2025"), else the file's date.
  function docDate(name, fallback) {
    const m = clean(name).match(/(?:^|[^\d])(\d{1,2})([./-])(\d{1,2})\2(\d{2}|\d{4})(?!\d)/);
    if (m) {
      const d = Number(m[1]); const mo = Number(m[3]); const y = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2015 && y <= 2099) return `${y}-${pad(mo)}-${pad(d)}`;
    }
    return String(fallback || '').slice(0, 10);
  }

  // files:   [{ id, name, mimeType, parents: [folderId], modifiedTime, createdTime }]
  // folders: { folderId: [parentId, name] } for every folder between the files and rootId
  // projects: [{ id, name, driveFolder }] (several projects may share one folder)
  // Returns one item per document; a PDF and a Word copy of the same document become one item.
  function buildItems(files, folders, rootId, projects) {
    const byFolder = {};
    (projects || []).forEach((p) => { if (p.driveFolder) (byFolder[p.driveFolder] = byFolder[p.driveFolder] || []).push(p); });
    const items = new Map();
    (files || []).forEach((f) => {
      const c = classify(f.name, f.mimeType);
      if (!c) return;
      let at = (f.parents || [])[0]; const path = []; let guard = 0;
      while (at && at !== rootId && !byFolder[at] && folders[at] && guard++ < 30) { path.unshift(clean(folders[at][1])); at = folders[at][0]; }
      if (at !== rootId && !byFolder[at]) return; // outside the projects folder
      if (path.some((x) => SKIP_FOLDER.test(x))) return;
      const ps = byFolder[at] || [];
      let project = ps[0] || null;
      if (ps.length > 1) {
        // Two projects in one folder: pick by a word of the project name that appears in the path or file name.
        const hay = clean(f.name) + ' ' + path.join(' ');
        const hit = ps.find((p) => clean(p.name).split(/[\s\-–()]+/).filter((w) => w.length > 2 && !ps.every((q) => q.name.includes(w))).some((w) => hay.includes(w)));
        if (hit) project = hit;
      }
      const group = project ? '' : path.slice(0, 2).join(' · ');
      const title = baseName(f.name);
      const key = (f.parents || [])[0] + '|' + title.replace(/\s/g, '');
      const ext = DOC_MIMES[f.mimeType];
      let it = items.get(key);
      if (!it) {
        it = { id: f.id, kind: c.kind, label: c.label, title, date: docDate(f.name, f.createdTime || f.modifiedTime), projectId: project ? project.id : '', projectFolder: project ? at : '', group, folder: path.join(' / '), files: [], modified: '' };
        items.set(key, it);
      }
      it.files.push({ id: f.id, ext, name: clean(f.name) });
      if ((f.modifiedTime || '') > it.modified) it.modified = (f.modifiedTime || '').slice(0, 10);
    });
    const order = { pdf: 0, gdoc: 1, docx: 2, doc: 3 };
    return Array.from(items.values()).map((it) => {
      it.files.sort((a, b) => order[a.ext] - order[b.ext]);
      it.id = it.files[0].id;
      return it;
    }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title, 'he'));
  }

  const fileUrl = (f) => (f.ext === 'gdoc' ? 'https://docs.google.com/document/d/' : 'https://drive.google.com/file/d/') + encodeURIComponent(f.id) + (f.ext === 'gdoc' ? '/edit' : '/view');
  const driveQuery = (since) => `trashed=false and mimeType!='${FOLDER_MIME}' and (${NAME_WORDS.map((w) => `name contains '${w}'`).join(' or ')})${since ? ` and modifiedTime > '${since}'` : ''}`;

  const api = { classify, buildItems, baseName, docDate, fileUrl, driveQuery, DOC_MIMES, FOLDER_MIME, NAME_WORDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FemyDriveProtocols = api;
})(typeof window !== 'undefined' ? window : globalThis);
