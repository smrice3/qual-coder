// Memos: analytic, reflexive and methodological notes, linked to codes,
// documents, excerpts, categories and themes.
import {
  S, idx, mutate, go, rerender, bindField, pushUndo, touch, codeTree, excerptText, locLabel,
} from '../store.js';
import { esc, uid, nowIso, fmtDate, truncate, oneLine, openModal, confirmDialog, $, $$ } from '../util.js';

export const MEMO_TYPES = [
  ['analytic', 'Analytic'],
  ['code', 'Code'],
  ['document', 'Document / case'],
  ['theme', 'Category / theme'],
  ['reflexive', 'Reflexive'],
  ['method', 'Methodological'],
];
const typeLabel = (t) => MEMO_TYPES.find(([k]) => k === t)?.[1] || t;

const U = () => (S.ui.memos ||= { sel: null, q: '', type: '' });

export function newMemo(init = {}) {
  return mutate('new memo', (p) => {
    const m = {
      id: uid('m'),
      title: init.title || 'Untitled memo',
      type: init.type || 'analytic',
      body: init.body || '',
      quote: init.quote || '',
      links: init.links || [],
      created: nowIso(),
      updated: nowIso(),
    };
    p.memos.push(m);
    return m.id;
  }, { render: false });
}

export function memosLinkedTo(kind, id) {
  const p = S.project;
  let codingIds = null;
  if (kind === 'doc') codingIds = new Set(p.codings.filter((c) => c.doc === id).map((c) => c.id));
  return p.memos
    .filter((m) => m.links.some((l) => (l.kind === kind && l.id === id) || (codingIds && l.kind === 'coding' && codingIds.has(l.id))))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

export function linkHtml(l, i, removable = true) {
  const I = idx();
  let inner = '';
  let style = '';
  if (l.kind === 'code') {
    const c = I.codes.get(l.id);
    if (!c) return '';
    inner = `Code: ${esc(c.name)}`;
    style = ` style="--c:${c.color}"`;
  } else if (l.kind === 'doc') {
    const d = I.docs.get(l.id);
    if (!d) return '';
    inner = `Document: ${esc(truncate(d.title, 40))}`;
  } else if (l.kind === 'coding') {
    const c = S.project.codings.find((x) => x.id === l.id);
    if (!c) return '<span class="chip plain">Excerpt (removed)</span>';
    inner = `Excerpt: “${esc(truncate(oneLine(excerptText(c)), 40))}”`;
  } else if (l.kind === 'group') {
    const g = I.groups.get(l.id);
    if (!g) return '';
    inner = `${g.kind === 'theme' ? 'Theme' : 'Category'}: ${esc(g.name)}`;
  }
  return `<span class="chip ${l.kind === 'code' ? '' : 'plain'}"${style}>${inner}${removable ? ` <button class="chip-x" data-unlink="${i}" aria-label="Remove link">×</button>` : ''}</span>`;
}

function linkOptions() {
  const p = S.project;
  return `<option value="">+ Link to…</option>
    <optgroup label="Codes">${codeTree().map(({ code, depth }) => `<option value="code:${code.id}">${'  '.repeat(depth)}${esc(code.name)}</option>`).join('')}</optgroup>
    <optgroup label="Documents">${p.documents.map((d) => `<option value="doc:${d.id}">${esc(truncate(d.title, 60))}</option>`).join('')}</optgroup>
    ${p.groups.length ? `<optgroup label="Categories and themes">${p.groups.map((g) => `<option value="group:${g.id}">${esc(g.name)}</option>`).join('')}</optgroup>` : ''}`;
}

function editorHtml(m, rows) {
  return `<div class="memo-editor" data-mid="${m.id}">
    <input class="title-input" data-mf="title" value="${esc(m.title)}" aria-label="Memo title">
    <div class="memo-meta">
      <label class="inline-field">Type <select data-mf="type">${MEMO_TYPES.map(([k, l]) => `<option value="${k}" ${m.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <span class="muted small">Created ${esc(fmtDate(m.created))} · updated <span data-updated>${esc(fmtDate(m.updated))}</span></span>
    </div>
    <div class="links">${m.links.map((l, i) => linkHtml(l, i)).join(' ')} <select class="small" data-addlink aria-label="Add a link">${linkOptions()}</select></div>
    ${m.quote ? `<blockquote class="memo-quote">${esc(m.quote)}</blockquote>` : ''}
    <textarea data-mf="body" rows="${rows}" placeholder="What is going on here? What does this code or passage mean? How does it connect to other codes, to your research questions, or to your own position?">${esc(m.body)}</textarea>
  </div>`;
}

function bindEditor(box, m, rows, onTitle, after) {
  const draw = () => {
    box.innerHTML = editorHtml(m, rows);
    const stamp = () => {
      m.updated = nowIso();
      const u = $('[data-updated]', box);
      if (u) u.textContent = fmtDate(m.updated);
    };
    bindField($('[data-mf="title"]', box), m, 'title', { label: 'edit memo title', onInput: () => { stamp(); onTitle?.(); } });
    bindField($('[data-mf="body"]', box), m, 'body', { label: 'edit memo', onInput: stamp });
    $('[data-mf="type"]', box).addEventListener('change', (e) => { pushUndo('change memo type'); m.type = e.target.value; stamp(); touch(false); onTitle?.(); });
    $('[data-addlink]', box).addEventListener('change', (e) => {
      const [kind, id] = e.target.value.split(':');
      if (!kind) return;
      if (!m.links.some((l) => l.kind === kind && l.id === id)) {
        pushUndo('link memo');
        m.links.push({ kind, id });
        stamp();
        touch(false);
      }
      draw();
      onTitle?.();
    });
    box.querySelector('.links').addEventListener('click', (e) => {
      const b = e.target.closest('[data-unlink]');
      if (!b) return;
      pushUndo('unlink memo');
      m.links.splice(Number(b.dataset.unlink), 1);
      stamp();
      touch(false);
      draw();
      onTitle?.();
    });
    const title = $('[data-mf="title"]', box);
    title.addEventListener('focus', () => { if (m.title === 'Untitled memo') title.select(); });
    after?.();
  };
  draw();
}

function deleteMemo(id) {
  mutate('delete memo', (p) => { p.memos = p.memos.filter((m) => m.id !== id); });
}

export function editMemoModal(id) {
  const m = S.project.memos.find((x) => x.id === id);
  if (!m) return;
  const body = document.createElement('div');
  openModal({
    title: 'Memo',
    body,
    wide: true,
    actions: [
      {
        label: 'Delete memo',
        danger: true,
        left: true,
        onClick: async () => {
          if (!(await confirmDialog('Delete this memo? You can undo this.', { ok: 'Delete', danger: true }))) return false;
          deleteMemo(id);
          return true;
        },
      },
      { label: 'Open in Memos', onClick: () => go('memos', { memos: { sel: id } }) },
      { label: 'Done', primary: true },
    ],
    onClose: () => rerender(),
  });
  bindEditor(body, m, 12);
  setTimeout(() => $('[data-mf="body"]', body)?.focus(), 30);
}

// ---------------------------------------------------------------- view

export function render(el) {
  const u = U();
  if (!el.querySelector('.memos-view')) {
    el.innerHTML = `<div class="memos-view two-col">
      <aside class="pane list-pane" aria-label="Memo list">
        <div class="pane-head">
          <div class="pane-title"><h2>Memos</h2><button class="btn small primary" data-act="new">+ New memo</button></div>
          <input type="search" class="filter" data-q placeholder="Search memos" aria-label="Search memos">
          <select data-type aria-label="Filter by type"><option value="">All types</option>${MEMO_TYPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
        </div>
        <div class="pane-scroll" data-scroll-key="memolist" data-list></div>
      </aside>
      <section class="pane editor-pane"><div class="pane-scroll" data-scroll-key="memoedit" data-editor></div></section>
    </div>`;
    const root = el.querySelector('.memos-view');
    $('[data-q]', root).value = u.q;
    $('[data-type]', root).value = u.type;
    root.addEventListener('input', (e) => { if (e.target.matches('[data-q]')) { u.q = e.target.value; renderList(root); } });
    root.addEventListener('change', (e) => { if (e.target.matches('[data-type]')) { u.type = e.target.value; renderList(root); } });
    root.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act],[data-open-memo]');
      if (!t) return;
      if (t.dataset.openMemo) { u.sel = t.dataset.openMemo; renderList(root); renderEditor(root); return; }
      if (t.dataset.act === 'new') {
        u.sel = newMemo({});
        renderList(root);
        renderEditor(root);
        $('[data-mf="title"]', root)?.focus();
      } else if (t.dataset.act === 'delete') {
        if (await confirmDialog('Delete this memo? You can undo this.', { ok: 'Delete', danger: true })) {
          deleteMemo(u.sel);
          u.sel = null;
        }
      }
    });
  }
  const root = el.querySelector('.memos-view');
  if (u.sel && !S.project.memos.some((m) => m.id === u.sel)) u.sel = null;
  renderList(root);
  renderEditor(root);
}

function renderList(root) {
  const u = U();
  const q = u.q.trim().toLowerCase();
  const list = [...S.project.memos]
    .filter((m) => (!u.type || m.type === u.type) && (!q || `${m.title} ${m.body} ${m.quote}`.toLowerCase().includes(q)))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  $('[data-list]', root).innerHTML = list.length ? list.map((m) => `
    <button class="memo-item ${m.id === u.sel ? 'on' : ''}" data-open-memo="${m.id}">
      <span class="mi-title">${esc(m.title)}</span>
      <span class="mi-meta"><span class="tag">${esc(typeLabel(m.type))}</span> ${esc(fmtDate(m.updated, false))}</span>
      ${m.body ? `<span class="mi-snip">${esc(truncate(oneLine(m.body), 110))}</span>` : ''}
    </button>`).join('') : `<p class="empty small">${S.project.memos.length ? 'No memos match.' : 'No memos yet. Write one here, or from a code, an excerpt or a document.'}</p>`;
}

function renderEditor(root) {
  const u = U();
  const box = $('[data-editor]', root);
  const m = S.project.memos.find((x) => x.id === u.sel);
  if (!m) {
    box.innerHTML = '<div class="empty big"><h2>Memos</h2><p>Memos hold your thinking as you code: what codes mean, hunches, connections, and reflexive notes on your own position. Each one is dated, so together they form an audit trail.</p></div>';
    return;
  }
  bindEditor(box, m, 24, () => renderList(root), () => {
    const extra = [];
    for (const l of m.links) {
      if (l.kind !== 'coding') continue;
      const c = S.project.codings.find((x) => x.id === l.id);
      const d = c && idx().docs.get(c.doc);
      if (c && d) extra.push(`<p class="small muted">Excerpt from <a href="#" data-goto-coding="${c.id}">${esc(d.title)}, ${esc(locLabel(d, c.start))}</a></p>`);
    }
    box.insertAdjacentHTML('beforeend', `${extra.join('')}<div class="btn-row end"><button class="btn small danger-ghost" data-act="delete">Delete memo</button></div>`);
    $$('[data-goto-coding]', box).forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const c = S.project.codings.find((x) => x.id === a.dataset.gotoCoding);
      if (c) go('code', { code: { docId: c.doc, active: c.id, clicked: [c.id], scrollTo: c.id, pending: null } });
    }));
  });
}

export function memosMarkdown() {
  const p = S.project;
  const lines = [`# Memos: ${p.name}`, '', `Exported ${new Date().toLocaleString()}`, ''];
  for (const m of [...p.memos].sort((a, b) => String(a.created).localeCompare(String(b.created)))) {
    lines.push(`## ${m.title}`, '', `*${typeLabel(m.type)} memo · created ${fmtDate(m.created)} · updated ${fmtDate(m.updated)}*`, '');
    const links = m.links.map((l) => linkHtml(l, 0, false).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")).filter(Boolean);
    if (links.length) lines.push(`Linked to: ${links.join('; ')}`, '');
    if (m.quote) lines.push(...m.quote.split('\n').map((x) => `> ${x}`), '');
    lines.push(m.body || '', '');
  }
  return lines.join('\n');
}
