// Adding documents (files, pasted text, CSV rows) and editing document details.
import { S, mutate, api, logEvent } from './store.js';
import {
  esc, uid, nowIso, openModal, toast, readFileBase64, readFileText, parseCSV, plural, truncate,
  confirmDialog, promptDialog, $, $$,
} from './util.js';
import * as gdrive from './google.js';

const DRIVE_ZIP_TIP = 'In Google Drive, select the documents or a whole folder, then right-click › Download. Drive saves a .zip with each Google Doc as a Word file. Choose that .zip in the Files tab and every document in it is added.';

function setOptions() {
  const sets = [...new Set(S.project.documents.map((d) => d.set).filter(Boolean))].sort();
  return sets.map((s) => `<option value="${esc(s)}"></option>`).join('');
}

export function openImportDialog() {
  const p = S.project;
  let tab = 'files';
  const items = [];
  let csv = null;
  const newKeys = [];
  const keys = () => [...p.attributes, ...newKeys.filter((k) => !p.attributes.includes(k))];

  const body = document.createElement('div');
  body.className = 'import';
  body.innerHTML = `
    <div class="seg-tabs" role="tablist">
      <button type="button" role="tab" data-tab="files" class="on">Files</button>
      <button type="button" role="tab" data-tab="google">Google Drive</button>
      <button type="button" role="tab" data-tab="paste">Paste text</button>
      <button type="button" role="tab" data-tab="csv">Spreadsheet rows (CSV)</button>
    </div>
    <div data-pane="files">
      <p class="hint">Word (.docx, .doc, .rtf), text (.txt, .md), PDF, caption files (.vtt, .srt), or a .zip of any of these, such as a Google Drive download. Captions from Zoom or Teams are merged into speaker turns with timestamps.</p>
      <input type="file" multiple accept=".txt,.md,.markdown,.docx,.doc,.rtf,.odt,.pdf,.vtt,.srt,.html,.htm,.zip" data-files aria-label="Choose files">
      <div data-notes></div>
    </div>
    <div data-pane="google" hidden><div data-google><p class="muted small">Checking Google Drive setup…</p></div></div>
    <div data-pane="paste" hidden>
      <label class="field"><span>Title</span><input data-paste-title placeholder="e.g. Interview 3 (P3)"></label>
      <label class="field"><span>Text</span><textarea data-paste-text rows="9" placeholder="Paste the transcript or text here"></textarea></label>
      <button type="button" class="btn" data-add-paste>Add to the list below</button>
    </div>
    <div data-pane="csv" hidden>
      <p class="hint">Each row becomes a document, for example one survey response per row. Other columns can become document attributes. Save Excel or Google Sheets files as CSV first.</p>
      <input type="file" accept=".csv,.tsv,.txt" data-csv aria-label="Choose a CSV file">
      <div data-csv-map></div>
    </div>
    <div class="import-common">
      <label class="field inline"><span>Set</span><input data-set list="qcSets" placeholder="Optional group name, e.g. Cycle 1 interviews"></label>
      <datalist id="qcSets">${setOptions()}</datalist>
      <div class="attr-keys"><span class="muted small">Document attributes:</span> <span data-keys></span>
        <button type="button" class="btn small" data-add-key>+ Attribute</button></div>
    </div>
    <div data-list class="import-list"></div>`;

  const renderKeys = () => {
    $('[data-keys]', body).innerHTML = keys().length
      ? keys().map((k) => `<span class="chip plain">${esc(k)}</span>`).join(' ')
      : '<span class="muted small">none yet (participant, role, date…)</span>';
  };

  const renderList = () => {
    const list = $('[data-list]', body);
    if (tab === 'csv') { list.innerHTML = ''; return; }
    list.innerHTML = items.length ? items.map((it, i) => `
      <div class="import-item ${it.error ? 'err' : ''}">
        <div class="ii-head">
          <input class="ii-title" data-i="${i}" data-k="__title" value="${esc(it.title)}" aria-label="Document title">
          <button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove">×</button>
        </div>
        ${it.error ? `<p class="error small">${esc(it.error)}</p>` : `
        <div class="ii-attrs">${keys().map((k) => `<label><span>${esc(k)}</span><input data-i="${i}" data-k="${esc(k)}" value="${esc(it.attrs[k] || '')}"></label>`).join('')}</div>
        <p class="ii-preview">${esc(truncate(it.text.replace(/\s+/g, ' '), 220))}</p>
        <p class="muted small">${it.drive ? 'Google Drive · ' : ''}${it.filename ? `${esc(it.filename)} · ` : ''}${it.text.length.toLocaleString()} characters · ${plural(it.text.split('\n').filter((l) => l.trim()).length, 'paragraph')}</p>`}
      </div>`).join('') : '<p class="muted small">No documents chosen yet.</p>';
  };

  const renderCsv = () => {
    const box = $('[data-csv-map]', body);
    if (!csv) { box.innerHTML = ''; return; }
    const opts = (sel, blank) => (blank ? `<option value="">${blank}</option>` : '')
      + csv.headers.map((h, i) => `<option value="${i}" ${String(sel) === String(i) ? 'selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('');
    const n = csv.rows.filter((r) => (r[csv.textCol] || '').trim()).length;
    box.innerHTML = `
      <div class="grid2">
        <label class="field"><span>Text to code</span><select data-csv-text>${opts(csv.textCol)}</select></label>
        <label class="field"><span>Document title</span><select data-csv-title>${opts(csv.titleCol, 'Row number')}</select></label>
      </div>
      <div class="field"><span>Make these columns attributes</span>
        <div class="checks">${csv.headers.map((h, i) => (i === csv.textCol ? '' : `<label><input type="checkbox" data-csv-attr value="${i}" ${csv.attrCols.has(i) ? 'checked' : ''}> ${esc(h || `Column ${i + 1}`)}</label>`)).join('')}</div>
      </div>
      <p class="hint">${plural(n, 'row')} with text will become documents.</p>`;
  };

  const renderNotes = (notes) => {
    $('[data-notes]', body).innerHTML = notes.map((n) => `<p class="hint small">${n}</p>`).join('');
  };

  let googleError = '';
  const renderGoogle = async () => {
    const box = $('[data-google]', body);
    let c;
    try { c = await gdrive.googleConfig(); } catch { c = {}; }
    if (!gdrive.googleReady(c)) {
      box.innerHTML = `<p>Google sign-in isn't set up on this computer yet. It's a one-time setup in <b>Settings › Google Drive</b>.</p>
        <p class="hint">${esc(DRIVE_ZIP_TIP)}</p>`;
      return;
    }
    box.innerHTML = `<p><button type="button" class="btn primary" data-act="drive-pick">Choose from Google Drive…</button></p>
      <p class="hint small">The first time, Google asks you to sign in and allow access. Qual Coder can open only the documents you pick, and each one is downloaded to this computer. Google Docs come in as Word files, with their link kept so you can open the original later.</p>
      ${googleError ? `<p class="error small">${esc(googleError)}</p>` : ''}
      <details><summary class="small">No sign-in? Use a Drive download instead</summary><p class="hint small">${esc(DRIVE_ZIP_TIP)}</p></details>`;
    gdrive.preloadGoogle().catch((err) => { googleError = err.message; renderGoogle(); });
  };

  const addDriveFiles = async (files) => {
    for (const f of files) {
      const it = { title: f.name.replace(/\.(docx|txt|md|pdf|rtf|vtt|srt)$/i, ''), text: '', attrs: {}, filename: f.name, url: f.url, drive: true, error: 'Downloading from Google Drive…' };
      items.push(it);
      renderList();
      try {
        const { filename, blob } = await gdrive.download(f);
        const r = await api('POST', '/extract', { filename, data: await readFileBase64(blob) });
        it.text = r.text;
        it.error = null;
      } catch (err) { it.error = err.message; }
      renderList();
    }
  };

  body.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab],[data-remove],[data-add-paste],[data-add-key],[data-act]');
    if (!t) return;
    if (t.dataset.act === 'drive-pick') {
      googleError = '';
      // signIn() must run straight from the click so the browser allows Google's sign-in window.
      gdrive.signIn()
        .then(() => gdrive.pick())
        .then((files) => (files.length ? addDriveFiles(files) : null))
        .catch((err) => { googleError = err.message; renderGoogle(); });
      return;
    }
    if (t.dataset.tab) {
      tab = t.dataset.tab;
      $$('[data-tab]', body).forEach((b) => b.classList.toggle('on', b === t));
      $$('[data-pane]', body).forEach((pn) => { pn.hidden = pn.dataset.pane !== tab; });
      if (tab === 'google') renderGoogle();
      renderList();
    } else if (t.dataset.remove != null) {
      items.splice(Number(t.dataset.remove), 1);
      renderList();
    } else if (t.hasAttribute('data-add-paste')) {
      const text = $('[data-paste-text]', body).value.replace(/\r\n?/g, '\n').trim();
      if (!text) return toast('Paste some text first');
      items.push({ title: $('[data-paste-title]', body).value.trim() || `Pasted text ${items.length + 1}`, text, attrs: {}, filename: '' });
      $('[data-paste-text]', body).value = '';
      $('[data-paste-title]', body).value = '';
      renderList();
    } else if (t.hasAttribute('data-add-key')) {
      const k = (await promptDialog('New attribute', 'Attribute name', '', { placeholder: 'e.g. participant, role, college' }))?.trim();
      if (k && !keys().includes(k)) { newKeys.push(k); renderKeys(); renderList(); }
    }
  });

  body.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.i != null) {
      const it = items[Number(t.dataset.i)];
      if (t.dataset.k === '__title') it.title = t.value; else it.attrs[t.dataset.k] = t.value;
    }
  });

  body.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.matches('[data-files]')) {
      const files = [...t.files];
      t.value = '';
      const notes = [];
      for (const f of files) {
        const it = { title: f.name.replace(/\.[^.]+$/, ''), text: '', attrs: {}, filename: f.name, error: f.name.toLowerCase().endsWith('.zip') ? 'Opening the .zip…' : 'Reading…' };
        items.push(it);
        renderList();
        try {
          const r = await api('POST', '/extract', { filename: f.name, data: await readFileBase64(f) });
          if (r.documents) {
            items.splice(items.indexOf(it), 1);
            for (const d of r.documents) items.push({ title: d.title, text: d.text, attrs: {}, filename: `${f.name} › ${d.path}`, error: null });
            notes.push(`${esc(f.name)}: added ${plural(r.documents.length, 'document')}${r.skipped.length ? `; skipped ${r.skipped.length} (${r.skipped.slice(0, 6).map((x) => `${esc(x.name.split('/').pop())}: ${esc(x.reason)}`).join('; ')}${r.skipped.length > 6 ? '; …' : ''})` : ''}.`);
            renderNotes(notes);
          } else {
            it.text = r.text;
            it.error = null;
          }
        } catch (err) { it.error = err.message; }
        renderList();
      }
    } else if (t.matches('[data-csv]')) {
      const f = t.files[0];
      if (!f) return;
      const rows = parseCSV(await readFileText(f));
      if (rows.length < 2) { toast('That file has no data rows', 'error'); return; }
      const headers = rows[0].map((h) => h.trim());
      const data = rows.slice(1);
      let textCol = 0;
      let best = -1;
      headers.forEach((_, i) => {
        const avg = data.reduce((s, r) => s + (r[i] || '').length, 0) / data.length;
        if (avg > best) { best = avg; textCol = i; }
      });
      csv = { headers, rows: data, textCol, titleCol: '', attrCols: new Set(), filename: f.name };
      renderCsv();
    } else if (t.matches('[data-csv-text]')) {
      csv.textCol = Number(t.value);
      csv.attrCols.delete(csv.textCol);
      renderCsv();
    } else if (t.matches('[data-csv-title]')) {
      csv.titleCol = t.value;
    } else if (t.matches('[data-csv-attr]')) {
      const i = Number(t.value);
      if (t.checked) csv.attrCols.add(i); else csv.attrCols.delete(i);
    }
  });

  renderKeys();
  renderList();
  // Load Google's sign-in code early so the sign-in window can open from a click.
  gdrive.googleConfig().then((c) => { if (gdrive.googleReady(c)) gdrive.preloadGoogle().catch(() => {}); }).catch(() => {});

  openModal({
    title: 'Add documents',
    body,
    wide: true,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Add documents',
        primary: true,
        onClick: () => {
          const set = $('[data-set]', body).value.trim();
          if (tab === 'csv') {
            if (!csv) { toast('Choose a CSV file first'); return false; }
            const rows = csv.rows.map((r, i) => ({ r, i })).filter(({ r }) => (r[csv.textCol] || '').trim());
            if (!rows.length) { toast('No rows have text in that column'); return false; }
            const attrCols = [...csv.attrCols];
            mutate('add documents', (pp) => {
              for (const k of newKeys) if (!pp.attributes.includes(k)) pp.attributes.push(k);
              for (const i of attrCols) {
                const k = csv.headers[i] || `Column ${i + 1}`;
                if (!pp.attributes.includes(k)) pp.attributes.push(k);
              }
              for (const { r, i } of rows) {
                const attrs = {};
                for (const c of attrCols) attrs[csv.headers[c] || `Column ${c + 1}`] = (r[c] || '').trim();
                const title = csv.titleCol !== '' ? (r[Number(csv.titleCol)] || '').trim() : '';
                pp.documents.push({
                  id: uid('d'), title: title || `${set || 'Row'} ${i + 1}`,
                  text: r[csv.textCol].replace(/\r\n?/g, '\n').trim(), set, attrs, source: `${csv.filename}, row ${i + 2}`, added: nowIso(),
                });
              }
              logEvent(pp, 'Documents added', `${rows.length} rows from ${csv.filename}`);
            });
            toast(`Added ${plural(rows.length, 'document')}`);
            return true;
          }
          const good = items.filter((it) => !it.error && it.text);
          if (!good.length) { toast('Choose files or paste text first'); return false; }
          let firstId = null;
          mutate('add documents', (pp) => {
            for (const k of newKeys) if (!pp.attributes.includes(k)) pp.attributes.push(k);
            for (const it of good) {
              const attrs = {};
              for (const [k, v] of Object.entries(it.attrs)) if (String(v).trim()) attrs[k] = String(v).trim();
              const d = { id: uid('d'), title: it.title.trim() || 'Untitled', text: it.text, set, attrs, source: it.drive ? `Google Drive: ${it.filename}` : it.filename || 'pasted text', added: nowIso() };
              if (it.url) d.source_url = it.url;
              pp.documents.push(d);
              firstId ||= d.id;
            }
            logEvent(pp, 'Documents added', good.map((it) => it.title).join('; '));
          });
          if (firstId) { S.ui.code = Object.assign(S.ui.code || {}, { docId: firstId, resetScroll: true }); }
          toast(`Added ${plural(good.length, 'document')}`);
          return true;
        },
      },
    ],
  });
}

export function editDocDialog(docId) {
  const p = S.project;
  const doc = p.documents.find((d) => d.id === docId);
  if (!doc) return;
  const nCodings = p.codings.filter((c) => c.doc === docId).length;
  const newKeys = [];
  const body = document.createElement('div');
  const render = () => {
    const ks = [...p.attributes, ...newKeys];
    body.innerHTML = `
      <label class="field"><span>Title</span><input data-f="title" value="${esc(doc.title)}"></label>
      <label class="field"><span>Set</span><input data-f="set" list="qcSets2" value="${esc(doc.set || '')}" placeholder="Optional group name"></label>
      <datalist id="qcSets2">${setOptions()}</datalist>
      <div class="field"><span>Attributes</span>
        <div class="ii-attrs">${ks.map((k) => `<label><span>${esc(k)}</span><input data-attr="${esc(k)}" value="${esc(doc.attrs[k] ?? '')}"></label>`).join('')}</div>
        <button type="button" class="btn small" data-add-key>+ Attribute</button>
      </div>
      ${doc.source_url ? `<p class="small"><a href="${esc(doc.source_url)}" target="_blank" rel="noopener">Open the original in Google Drive ↗</a> <span class="muted">(this copy doesn't change if the original does)</span></p>` : ''}
      <p class="muted small">Source: ${esc(doc.source || 'unknown')} · added ${esc(new Date(doc.added || Date.now()).toLocaleDateString())} · ${doc.text.length.toLocaleString()} characters · ${plural(nCodings, 'coded excerpt')}.
      The text itself can't be edited here, because codes are anchored to exact character positions.</p>`;
  };
  render();
  body.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-add-key]')) return;
    const k = (await promptDialog('New attribute', 'Attribute name', ''))?.trim();
    if (k && !p.attributes.includes(k) && !newKeys.includes(k)) {
      const vals = {};
      $$('[data-attr]', body).forEach((i) => { vals[i.dataset.attr] = i.value; });
      const title = $('[data-f="title"]', body).value;
      const set = $('[data-f="set"]', body).value;
      newKeys.push(k);
      render();
      $('[data-f="title"]', body).value = title;
      $('[data-f="set"]', body).value = set;
      $$('[data-attr]', body).forEach((i) => { if (vals[i.dataset.attr] != null) i.value = vals[i.dataset.attr]; });
    }
  });
  openModal({
    title: 'Document details',
    body,
    actions: [
      {
        label: 'Delete document',
        danger: true,
        left: true,
        onClick: async () => {
          const ok = await confirmDialog(`Delete “${doc.title}” and its ${plural(nCodings, 'coded excerpt')}? Memos stay, but lose their links to it. You can undo this.`, { title: 'Delete document', ok: 'Delete', danger: true });
          if (!ok) return false;
          mutate('delete document', (pp) => {
            const gone = new Set(pp.codings.filter((c) => c.doc === docId).map((c) => c.id));
            pp.documents = pp.documents.filter((d) => d.id !== docId);
            pp.codings = pp.codings.filter((c) => c.doc !== docId);
            pp.suggestions = pp.suggestions.filter((s) => s.doc !== docId);
            for (const m of pp.memos) m.links = m.links.filter((l) => !(l.kind === 'doc' && l.id === docId) && !(l.kind === 'coding' && gone.has(l.id)));
            logEvent(pp, 'Document deleted', `${doc.title} (${gone.size} coded excerpts)`);
          });
          return true;
        },
      },
      { label: 'Cancel' },
      {
        label: 'Save',
        primary: true,
        onClick: () => {
          mutate('edit document details', (pp) => {
            const d = pp.documents.find((x) => x.id === docId);
            d.title = $('[data-f="title"]', body).value.trim() || d.title;
            d.set = $('[data-f="set"]', body).value.trim();
            for (const k of newKeys) if (!pp.attributes.includes(k)) pp.attributes.push(k);
            for (const i of $$('[data-attr]', body)) {
              const v = i.value.trim();
              if (v) d.attrs[i.dataset.attr] = v; else delete d.attrs[i.dataset.attr];
            }
          });
        },
      },
    ],
  });
}
