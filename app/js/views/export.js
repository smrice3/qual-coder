// Export: CSV for Sheets/Excel, Markdown and formatted text for Docs, and
// full project backups.
import {
  S, idx, api, codeTree, codePath, paragraphs, excerptText,
} from '../store.js';
import { esc, toCSV, download, copyRich, slug, toast, plural, localStamp } from '../util.js';
import {
  retrieve, excerptRows, codeMatrix, cooccurrence, excerptReport, htmlPage, groupsForCode, UNIT_LABELS,
} from '../analysis.js';
import { memosMarkdown } from './memos.js';
import { themeOutline } from './themes.js';

const csvType = 'text/csv;charset=utf-8';
const name = () => slug(S.project.name);

function allCodings() {
  return retrieve({ codeIds: S.project.codes.map((c) => c.id), includeChildren: false });
}

function codebookRows() {
  const I = idx();
  const out = [['Code', 'Path', 'Parent', 'Definition', 'When to use', 'When not to use', 'Typical example', 'Color', 'Excerpts', 'Documents', 'Categories', 'Themes', 'Created', 'Origin']];
  for (const { code } of codeTree()) {
    const cs = I.byCode.get(code.id) || [];
    const g = groupsForCode(code.id);
    out.push([
      code.name, codePath(code.id, ' > '), code.parent ? I.codes.get(code.parent)?.name || '' : '',
      code.definition, code.include, code.exclude, code.example, code.color, cs.length,
      new Set(cs.map((c) => c.doc)).size, g.categories.map((x) => x.name).join('; '),
      g.themes.map((x) => x.name).join('; '), localStamp(code.created), code.origin === 'ai' ? 'AI suggestion' : 'Researcher',
    ]);
  }
  return out;
}

function codebookDoc() {
  const I = idx();
  const html = [`<h1>Codebook: ${esc(S.project.name)}</h1><p><em>${plural(S.project.codes.length, 'code')} · exported ${esc(new Date().toLocaleDateString())}</em></p>`];
  const md = [`# Codebook: ${S.project.name}`, '', `${plural(S.project.codes.length, 'code')} · exported ${new Date().toLocaleDateString()}`, ''];
  for (const { code, depth } of codeTree()) {
    const n = (I.byCode.get(code.id) || []).length;
    const h = Math.min(2 + depth, 6);
    html.push(`<h${h}>${esc(code.name)} <small>(${n})</small></h${h}>`);
    md.push(`${'#'.repeat(h)} ${code.name} (${n})`, '');
    const rows = [['Definition', code.definition], ['When to use', code.include], ['When not to use', code.exclude], ['Typical example', code.example]].filter(([, v]) => (v || '').trim());
    if (rows.length) {
      html.push(`<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}</table>`);
      for (const [k, v] of rows) md.push(`**${k}:** ${v}`, '');
    } else {
      html.push('<p><em>No definition yet.</em></p>');
      md.push('*No definition yet.*', '');
    }
  }
  return { html: html.join('\n'), md: md.join('\n') };
}

function codedTranscript(docId) {
  const I = idx();
  const doc = I.docs.get(docId);
  const cs = I.byDoc.get(docId) || [];
  const rows = paragraphs(doc).filter((p) => p.n != null).map((para) => {
    const here = cs.filter((c) => c.start < para.end && c.end > para.start);
    const labels = here.map((c) => {
      const code = I.codes.get(c.code);
      return `<span class="code" style="background:${code.color}">${esc(code.name)}${c.origin === 'ai' ? ' (AI)' : ''}</span>`;
    }).join('');
    const pts = new Set([para.start, para.end]);
    for (const c of here) { pts.add(Math.max(c.start, para.start)); pts.add(Math.min(c.end, para.end)); }
    const cuts = [...pts].sort((a, b) => a - b);
    let text = '';
    for (let k = 0; k < cuts.length - 1; k++) {
      const seg = esc(doc.text.slice(cuts[k], cuts[k + 1]));
      const on = here.some((c) => c.start < cuts[k + 1] && c.end > cuts[k]);
      text += on ? `<u>${seg}</u>` : seg;
    }
    return `<tr><td class="pn">${para.n}</td><td>${text}</td><td>${labels}</td></tr>`;
  });
  const attrs = Object.entries(doc.attrs).filter(([, v]) => v).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ');
  return htmlPage(doc.title, `<h1>${esc(doc.title)}</h1><p><em>${attrs ? `${attrs} · ` : ''}${plural(cs.length, 'coded excerpt')} · ${esc(S.project.name)}</em></p>
    <table><thead><tr><th>¶</th><th>Text (coded passages underlined)</th><th>Codes</th></tr></thead><tbody>${rows.join('')}</tbody></table>`);
}

async function auditCSV() {
  let ai = [];
  try { ai = (await api('GET', `/projects/${S.project.id}/ai-log`)).entries; } catch { /* none */ }
  const rows = [];
  for (const e of S.project.log) rows.push([e.t, 'Project', e.action, e.detail]);
  for (const e of ai) rows.push([e.t, 'AI request', `Suggestions for “${e.doc_title}”`, `${e.chars_sent} characters (offsets ${e.start}–${e.end}) to ${e.backend ? 'local model ' : ''}${e.model_used || e.model}; ${e.suggestions} suggestions returned; ${e.unplaced} dropped; ${e.seconds}s`]);
  for (const s of S.project.suggestions.filter((x) => x.decided)) {
    rows.push([s.decided, 'AI decision', s.status, `${s.code} on “${excerptText({ doc: s.doc, start: s.start, end: s.end }).slice(0, 80)}”`]);
  }
  rows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  const out = [['Time (local)', 'Kind', 'Action', 'Detail'], ...rows.map((r) => [localStamp(r[0]), ...r.slice(1)])];
  download(`${name()}-audit-trail.csv`, toCSV(out), csvType);
}

const ITEMS = [
  { section: 'Coded data' },
  { id: 'excerpts-csv', title: 'All coded excerpts (CSV)', desc: 'One row per coded excerpt, with document, attributes, location, code, categories, themes and who coded it. Opens in Google Sheets or Excel.' },
  { id: 'report', title: 'Excerpts by code', desc: 'Every excerpt grouped under its code, with citations. Copy it straight into Google Docs or Word, or save it as an HTML page.', buttons: [['report-copy', 'Copy for Docs'], ['report-html', 'Download HTML']] },
  { id: 'transcript', title: 'Coded transcript', desc: 'One document with its paragraphs numbered, coded passages underlined and codes in the margin.', doc: true },
  { section: 'Codebook' },
  { id: 'codebook', title: 'Codebook', desc: 'Codes with definitions, criteria, examples and counts. The CSV can be imported into another project.', buttons: [['codebook-csv', 'CSV'], ['codebook-copy', 'Copy for Docs'], ['codebook-md', 'Markdown']] },
  { section: 'Analysis' },
  { id: 'matrix-csv', title: 'Code × document matrix (CSV)', desc: 'Excerpt counts for every code in every document.' },
  { id: 'cooccur-csv', title: 'Code co-occurrence (CSV)', desc: 'How often each pair of codes appears in the same paragraph or turn.' },
  { id: 'themes-md', title: 'Theme map (Markdown)', desc: 'Themes, their categories and codes, with counts and descriptions.' },
  { section: 'Memos and audit trail' },
  { id: 'memos-md', title: 'Memos (Markdown)', desc: 'All memos in the order you wrote them, with their links and dates.' },
  { id: 'audit-csv', title: 'Audit trail (CSV)', desc: 'The project log (codes created, renamed, merged and deleted; documents added) plus every AI request and decision, if AI was used.' },
  { section: 'Backup' },
  { id: 'project-json', title: 'Full project file (JSON)', desc: 'Everything in this project. Import it on the Qual Coder home screen to restore it or share it with a co-coder.' },
];

export function render(el) {
  const p = S.project;
  el.innerHTML = `<div class="export-view"><div class="pane-scroll">
    <div class="export-inner">
      <h1>Export</h1>
      <p class="muted">${plural(p.documents.length, 'document')} · ${plural(p.codes.length, 'code')} · ${plural(p.codings.length, 'coded excerpt')} · ${plural(p.memos.length, 'memo')}. Projects also back themselves up automatically every 10 minutes while you work (Settings › Snapshots).</p>
      ${ITEMS.map((it) => (it.section ? `<h2>${it.section}</h2>` : `
        <div class="export-item">
          <div><h3>${it.title}</h3><p>${it.desc}</p></div>
          <div class="btn-row tight">
            ${it.doc ? `<select class="small" data-doc aria-label="Document">${p.documents.map((d) => `<option value="${d.id}">${esc(d.title)}</option>`).join('')}</select>` : ''}
            ${(it.buttons || [[it.id, it.doc ? 'Download HTML' : 'Download']]).map(([id, label]) => `<button class="btn small" data-x="${id}">${label}</button>`).join('')}
          </div>
        </div>`)).join('')}
    </div></div></div>`;
  el.querySelector('.export-view').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-x]');
    if (!b) return;
    try { await run(b.dataset.x, el); } catch (err) { toast(err.message, 'error'); }
  });
}

async function run(id, el) {
  const p = S.project;
  switch (id) {
    case 'excerpts-csv': download(`${name()}-coded-excerpts.csv`, toCSV(excerptRows(allCodings())), csvType); break;
    case 'report-copy':
    case 'report-html': {
      const r = excerptReport(allCodings(), { title: `Excerpts by code: ${p.name}`, subtitle: `Exported ${new Date().toLocaleDateString()}` });
      if (id === 'report-copy') toast((await copyRich(r.html, r.text)) ? 'Copied. Paste into Google Docs or Word.' : 'Copy failed');
      else download(`${name()}-excerpts-by-code.html`, htmlPage(`Excerpts by code: ${p.name}`, r.html), 'text/html;charset=utf-8');
      break;
    }
    case 'transcript': {
      const docId = el.querySelector('[data-doc]')?.value;
      if (!docId) return toast('Add a document first');
      download(`${slug(idx().docs.get(docId).title)}-coded.html`, codedTranscript(docId), 'text/html;charset=utf-8');
      break;
    }
    case 'codebook-csv': download(`${name()}-codebook.csv`, toCSV(codebookRows()), csvType); break;
    case 'codebook-copy': { const d = codebookDoc(); toast((await copyRich(d.html, d.md)) ? 'Copied. Paste into Google Docs or Word.' : 'Copy failed'); break; }
    case 'codebook-md': download(`${name()}-codebook.md`, codebookDoc().md, 'text/markdown;charset=utf-8'); break;
    case 'matrix-csv': {
      const { cols, rows } = codeMatrix({ colMode: 'doc' });
      const out = [['Code path', ...cols.map((c) => c.label), 'Total']];
      for (const r of rows) out.push([codePath(r.code.id, ' > '), ...r.cells, r.total]);
      download(`${name()}-code-by-document.csv`, toCSV(out), csvType);
      break;
    }
    case 'cooccur-csv': {
      const unit = S.ui.analyze?.unit || 'paragraph';
      const { codes, pairs, diag, key } = cooccurrence(unit);
      const out = [[`Code (${UNIT_LABELS[unit]})`, ...codes.map((c) => codePath(c, ' > '))]];
      for (const a of codes) out.push([codePath(a, ' > '), ...codes.map((b) => (a === b ? diag.get(a) || 0 : pairs.get(key(a, b))?.n || 0))]);
      download(`${name()}-cooccurrence.csv`, toCSV(out), csvType);
      break;
    }
    case 'themes-md': download(`${name()}-themes.md`, `# Theme map: ${p.name}\n\nExported ${new Date().toLocaleDateString()}\n\n\`\`\`\n${themeOutline()}\n\`\`\`\n`, 'text/markdown;charset=utf-8'); break;
    case 'memos-md': download(`${name()}-memos.md`, memosMarkdown(), 'text/markdown;charset=utf-8'); break;
    case 'audit-csv': await auditCSV(); break;
    case 'project-json': download(`${name()}-${localStamp(new Date()).slice(0, 10)}.qualcoder.json`, JSON.stringify(p, null, 1), 'application/json'); break;
    default: break;
  }
}
