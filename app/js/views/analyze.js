// Analyze: retrieve excerpts by code, code-by-document matrix, co-occurrence.
import {
  S, idx, go, codeTree, codePath, groupCodeIds, attrValues, excerptText, locLabel, paragraphs,
} from '../store.js';
import {
  esc, truncate, plural, toast, download, copyRich, toCSV, slug, keepScroll, rgba, oneLine, $, $$,
} from '../util.js';
import {
  retrieve, byCode, codeMatrix, cooccurrence, excerptRows, contextHtml, excerptReport, htmlPage, UNIT_LABELS,
} from '../analysis.js';
import { newMemo, editMemoModal } from './memos.js';

const U = () => {
  const u = (S.ui.analyze ||= {});
  u.tab ??= 'retrieve'; u.codes ??= []; u.group ??= ''; u.includeChildren ??= true;
  u.attrs ??= {}; u.sets ??= []; u.docs ??= []; u.origin ??= 'all'; u.q ??= '';
  u.open ??= {}; u.colMode ??= 'doc'; u.rollup ??= false; u.measure ??= 'excerpts';
  u.unit ??= 'paragraph'; u.pair ??= null;
  return u;
};

const TABS = [['retrieve', 'Retrieve excerpts'], ['matrix', 'Code × document'], ['cooccur', 'Co-occurrence']];

export function render(el) {
  const u = U();
  let root = el.querySelector('.analyze-view');
  if (!root) {
    el.innerHTML = `<div class="analyze-view"><div class="subtabs" role="tablist"></div><div class="analyze-body" data-body></div></div>`;
    root = el.querySelector('.analyze-view');
    root.addEventListener('click', (e) => onClick(e, root));
    root.addEventListener('change', (e) => onChange(e, root));
    root.addEventListener('input', (e) => {
      if (e.target.matches('[data-q]')) {
        u.q = e.target.value;
        clearTimeout(root._t);
        root._t = setTimeout(() => renderResults(root), 200);
      }
    });
  }
  $('.subtabs', root).innerHTML = TABS.map(([k, l]) => `<button role="tab" class="subtab ${u.tab === k ? 'on' : ''}" data-tab="${k}" aria-selected="${u.tab === k}">${l}</button>`).join('');
  keepScroll(root, () => {
    const body = $('[data-body]', root);
    if (!S.project.codings.length) {
      body.innerHTML = '<div class="empty big"><h2>Nothing coded yet</h2><p>Code some text in the Code view, then come back to retrieve excerpts, compare documents and look for co-occurring codes.</p></div>';
      return;
    }
    if (u.tab === 'retrieve') renderRetrieve(body, root);
    else if (u.tab === 'matrix') renderMatrix(body);
    else renderCooccur(body);
  });
}

// ---------------------------------------------------------------- retrieve

function selectedCodeIds() {
  const u = U();
  return u.group ? [...groupCodeIds(u.group)] : u.codes.filter((id) => idx().codes.has(id));
}

function currentResults() {
  const u = U();
  return retrieve({
    codeIds: selectedCodeIds(),
    includeChildren: u.group ? false : u.includeChildren,
    filters: { docs: u.docs, sets: u.sets, attrs: u.attrs },
    origin: u.origin,
    q: u.q,
  });
}

function renderRetrieve(body, root) {
  const u = U();
  const p = S.project;
  const I = idx();
  const sets = [...new Set(p.documents.map((d) => d.set || ''))];
  const hasAi = p.codings.some((c) => c.origin === 'ai');
  body.innerHTML = `<div class="retrieve two-col">
    <aside class="pane filter-pane"><div class="pane-scroll" data-scroll-key="rfilter">
      <h3>Codes</h3>
      <div class="btn-row tight"><button class="link" data-act="all-codes">Select all</button><button class="link" data-act="no-codes">Clear</button></div>
      <div class="check-tree">${codeTree().map(({ code, depth }) => `<label style="--depth:${depth}"><input type="checkbox" data-code-check value="${code.id}" ${u.codes.includes(code.id) ? 'checked' : ''} ${u.group ? 'disabled' : ''}><span class="dot" style="background:${code.color}"></span><span class="nm">${esc(code.name)}</span><span class="muted small">${(I.byCode.get(code.id) || []).length}</span></label>`).join('')}</div>
      <label class="check"><input type="checkbox" data-children ${u.includeChildren ? 'checked' : ''} ${u.group ? 'disabled' : ''}> Include child codes</label>
      ${p.groups.length ? `<label class="field"><span>Or everything in a category or theme</span><select data-group><option value="">(none)</option>${p.groups.map((g) => `<option value="${g.id}" ${u.group === g.id ? 'selected' : ''}>${g.kind === 'theme' ? 'Theme' : 'Category'}: ${esc(g.name)}</option>`).join('')}</select></label>` : ''}
      <h3>Documents</h3>
      ${u.docs.length ? `<p class="small">Limited to ${u.docs.map((id) => `<span class="chip plain">${esc(truncate(I.docs.get(id)?.title || '', 30))}</span>`).join(' ')} <button class="link" data-act="clear-docs">Clear</button></p>` : ''}
      ${sets.length > 1 ? `<details open><summary>Set</summary>${sets.map((s) => `<label class="check"><input type="checkbox" data-set-check value="${esc(s)}" ${u.sets.includes(s) ? 'checked' : ''}> ${esc(s || '(no set)')}</label>`).join('')}</details>` : ''}
      ${p.attributes.map((k) => {
        const vals = attrValues(k);
        if (vals.length > 40) return '';
        return `<details ${u.attrs[k]?.length ? 'open' : ''}><summary>${esc(k)}</summary>${vals.map((v) => `<label class="check"><input type="checkbox" data-attr-check="${esc(k)}" value="${esc(v)}" ${(u.attrs[k] || []).includes(v) ? 'checked' : ''}> ${esc(v || '(blank)')}</label>`).join('')}</details>`;
      }).join('')}
      ${hasAi ? `<label class="field"><span>Coded by</span><select data-origin>
        <option value="all" ${u.origin === 'all' ? 'selected' : ''}>Anyone</option>
        <option value="human" ${u.origin === 'human' ? 'selected' : ''}>Researcher only</option>
        <option value="ai" ${u.origin === 'ai' ? 'selected' : ''}>Accepted AI suggestions only</option></select></label>` : ''}
      <label class="field"><span>Excerpt contains</span><input type="search" data-q value="${esc(u.q)}" placeholder="Words in the excerpt"></label>
      <button class="btn small" data-act="reset">Reset all filters</button>
    </div></aside>
    <section class="pane results-pane"><div class="pane-scroll" data-scroll-key="rresults" data-results></div></section>
  </div>`;
  renderResults(root);
}

function resultsTitle() {
  const u = U();
  const I = idx();
  if (u.group) {
    const g = I.groups.get(u.group);
    return `${g?.kind === 'theme' ? 'Theme' : 'Category'}: ${g?.name || ''}`;
  }
  const names = u.codes.map((id) => I.codes.get(id)?.name).filter(Boolean);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
}

function renderResults(root) {
  const u = U();
  const I = idx();
  const box = $('[data-results]', root);
  if (!box) return;
  if (!selectedCodeIds().length) {
    box.innerHTML = '<div class="empty big"><h2>Retrieve excerpts</h2><p>Pick one or more codes, or a category or theme, on the left. Then narrow by document attributes to compare groups of participants.</p></div>';
    return;
  }
  const list = currentResults();
  const groups = byCode(list);
  const docs = new Set(list.map((c) => c.doc)).size;
  const head = `<div class="results-head">
      <div><h2>${esc(resultsTitle())}</h2><p class="muted">${plural(list.length, 'excerpt')} from ${plural(docs, 'document')}</p></div>
      <div class="btn-row tight">
        <button class="btn small" data-act="copy" ${list.length ? '' : 'disabled'} title="Copy as formatted text to paste into Google Docs or Word">Copy for Docs</button>
        <button class="btn small" data-act="csv" ${list.length ? '' : 'disabled'}>CSV</button>
        <button class="btn small" data-act="html" ${list.length ? '' : 'disabled'}>HTML</button>
      </div></div>`;
  let html = '';
  for (const [codeId, cs] of groups) {
    const code = I.codes.get(codeId);
    const nd = new Set(cs.map((c) => c.doc)).size;
    html += `<section class="code-sec"><h3><span class="dot" style="background:${code.color}"></span>${esc(codePath(codeId))} <span class="muted small">${plural(cs.length, 'excerpt')} · ${plural(nd, 'document')}</span></h3>
      ${code.definition ? `<p class="def">${esc(code.definition)}</p>` : ''}
      ${cs.map((c) => {
        const d = I.docs.get(c.doc);
        const attrs = Object.entries(d.attrs).filter(([, v]) => v).map(([k, v]) => `<span class="chip plain" title="${esc(k)}">${esc(v)}</span>`).join('');
        return `<article class="excerpt">
          <blockquote>${esc(excerptText(c))}</blockquote>
          <div class="ex-meta"><b>${esc(d.title)}</b> · ${esc(locLabel(d, c.start))} ${attrs}${c.origin === 'ai' ? '<span class="tag ai">AI</span>' : ''}
            <span class="ex-actions"><button class="link" data-ctx="${c.id}">${u.open[c.id] ? 'Hide context' : 'Context'}</button>
            <button class="link" data-goto="${c.id}">Open in document</button>
            <button class="link" data-memo-on="${c.id}">Memo</button></span></div>
          ${u.open[c.id] ? contextHtml(c) : ''}
        </article>`;
      }).join('')}</section>`;
  }
  const scroll = box.scrollTop;
  box.innerHTML = head + (html || '<p class="empty">No excerpts match these filters.</p>');
  box.scrollTop = scroll;
}

// ---------------------------------------------------------------- matrix

function heat(v, max) {
  if (!v || !max) return '';
  return `background:${rgba('#30638e', 0.1 + 0.55 * (v / max))}`;
}

function renderMatrix(body) {
  const u = U();
  const p = S.project;
  const sets = [...new Set(p.documents.map((d) => d.set).filter(Boolean))];
  const { cols, rows } = codeMatrix({ colMode: u.colMode, rollup: u.rollup, measure: u.measure });
  const max = Math.max(1, ...rows.flatMap((r) => r.cells));
  body.innerHTML = `<div class="pane matrix-pane">
    <div class="controls">
      <label class="inline-field">Columns <select data-colmode>
        <option value="doc" ${u.colMode === 'doc' ? 'selected' : ''}>Documents</option>
        ${sets.length ? `<option value="set" ${u.colMode === 'set' ? 'selected' : ''}>Sets</option>` : ''}
        ${p.attributes.map((k) => `<option value="${esc(k)}" ${u.colMode === k ? 'selected' : ''}>Attribute: ${esc(k)}</option>`).join('')}
      </select></label>
      <label class="inline-field">Count <select data-measure>
        <option value="excerpts" ${u.measure === 'excerpts' ? 'selected' : ''}>Excerpts</option>
        <option value="docs" ${u.measure === 'docs' ? 'selected' : ''}>Documents with the code</option>
      </select></label>
      <label class="check"><input type="checkbox" data-rollup ${u.rollup ? 'checked' : ''}> Include child codes in parent rows</label>
      <button class="btn small" data-act="matrix-csv">Download CSV</button>
    </div>
    <p class="hint small">Click a cell to read those excerpts.</p>
    <div class="matrix-wrap" data-scroll-key="matrix"><table class="matrix">
      <thead><tr><th class="corner">Code</th>${cols.map((c) => `<th class="colh" title="${esc(c.label)}"><span>${esc(truncate(c.label, 32))}</span></th>`).join('')}<th class="colh tot"><span>Total</span></th></tr></thead>
      <tbody>${rows.map((r) => `<tr><th class="rowh" style="--depth:${r.depth}"><span class="dot" style="background:${r.code.color}"></span>${esc(r.code.name)}</th>
        ${r.cells.map((v, i) => `<td ${v ? `data-cell="${r.code.id}" data-col="${i}" class="hit"` : ''} style="${heat(v, max)}">${v || ''}</td>`).join('')}
        <td class="tot">${r.total || ''}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
}

function matrixCSV() {
  const u = U();
  const { cols, rows } = codeMatrix({ colMode: u.colMode, rollup: u.rollup, measure: u.measure });
  const out = [['Code path', ...cols.map((c) => c.value ?? c.label), 'Total']];
  for (const r of rows) out.push([codePath(r.code.id, ' > '), ...r.cells, r.total]);
  download(`${slug(S.project.name)}-code-matrix.csv`, toCSV(out), 'text/csv;charset=utf-8');
}

// ---------------------------------------------------------------- co-occurrence

function renderCooccur(body) {
  const u = U();
  const I = idx();
  const { codes, pairs, diag, key } = cooccurrence(u.unit);
  const max = Math.max(1, ...[...pairs.values()].map((x) => x.n));
  const top = [...pairs.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15);
  const unitWord = { overlap: 'overlaps', paragraph: 'paragraphs', document: 'documents' }[u.unit];
  let details = '';
  if (u.pair && pairs.has(u.pair)) details = pairDetails(u.pair, pairs.get(u.pair));
  body.innerHTML = `<div class="pane cooccur-pane"><div class="pane-scroll" data-scroll-key="cooccur">
    <div class="controls">
      <label class="inline-field">Count codes together when they share <select data-unit>
        ${Object.entries(UNIT_LABELS).map(([k, l]) => `<option value="${k}" ${u.unit === k ? 'selected' : ''}>${l.toLowerCase()}</option>`).join('')}
      </select></label>
      <button class="btn small" data-act="cooccur-csv">Download CSV</button>
    </div>
    <p class="hint small">${u.unit === 'overlap' ? 'Each cell counts pairs of excerpts whose text overlaps. The diagonal shows how many excerpts each code has.' : u.unit === 'paragraph' ? 'Each cell counts paragraphs (or speaker turns) where both codes appear. The diagonal shows how many paragraphs each code touches.' : 'Each cell counts documents where both codes appear. The diagonal shows how many documents each code appears in.'} Click a cell to see where.</p>
    ${codes.length < 2 ? '<p class="empty">Co-occurrence needs at least two codes in use.</p>' : `
    <div class="cooccur-grid">
      <div class="matrix-wrap"><table class="matrix co">
        <thead><tr><th class="corner"></th>${codes.map((id, i) => `<th class="colh num" title="${esc(codePath(id))}"><span>${i + 1}</span></th>`).join('')}</tr></thead>
        <tbody>${codes.map((a, i) => `<tr><th class="rowh"><span class="num">${i + 1}</span><span class="dot" style="background:${I.codes.get(a).color}"></span>${esc(truncate(I.codes.get(a).name, 34))}</th>
          ${codes.map((b) => {
            if (a === b) return `<td class="diag">${diag.get(a) || ''}</td>`;
            const e = pairs.get(key(a, b));
            const k = key(a, b);
            return e ? `<td class="hit ${u.pair === k ? 'sel' : ''}" data-pair="${k}" style="${heat(e.n, max)}" title="${esc(I.codes.get(a).name)} + ${esc(I.codes.get(b).name)}: ${e.n}">${e.n}</td>` : '<td></td>';
          }).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <div class="top-pairs"><h3>Most frequent pairs</h3>
        ${top.length ? `<ol>${top.map(([k, e]) => {
          const [a, b] = k.split('|');
          const share = Math.round((100 * e.n) / Math.min(diag.get(a) || 1, diag.get(b) || 1));
          return `<li><button class="link" data-pair="${k}">${esc(I.codes.get(a).name)} + ${esc(I.codes.get(b).name)}</button> <span class="muted small">${plural(e.n, unitWord.replace(/s$/, ''), unitWord)}${u.unit !== 'overlap' ? ` · ${Math.min(share, 100)}% of the rarer code's ${unitWord}` : ''}</span></li>`;
        }).join('')}</ol>` : '<p class="muted small">No codes co-occur yet.</p>'}
      </div>
    </div>`}
    ${details}
  </div></div>`;
}

function pairDetails(k, e) {
  const I = idx();
  const [a, b] = k.split('|');
  const A = I.codes.get(a);
  const B = I.codes.get(b);
  const items = e.items.map((it) => {
    const d = I.docs.get(it.doc);
    if (it.a) {
      const ca = S.project.codings.find((c) => c.id === it.a);
      const cb = S.project.codings.find((c) => c.id === it.b);
      const s = Math.min(ca.start, cb.start);
      const t = Math.max(ca.end, cb.end);
      return `<article class="excerpt"><blockquote>${esc(d.text.slice(s, t))}</blockquote><div class="ex-meta"><b>${esc(d.title)}</b> · ${esc(locLabel(d, s))} <button class="link" data-goto="${ca.id}">Open in document</button></div></article>`;
    }
    if (it.para != null) {
      const para = paragraphs(d)[it.para];
      return `<article class="excerpt"><blockquote>${esc(para.text)}</blockquote><div class="ex-meta"><b>${esc(d.title)}</b> · ${esc(locLabel(d, para.start))}</div></article>`;
    }
    const na = (I.byDoc.get(d.id) || []).filter((c) => c.code === a).length;
    const nb = (I.byDoc.get(d.id) || []).filter((c) => c.code === b).length;
    return `<p><b>${esc(d.title)}</b> <span class="muted small">${esc(A.name)}: ${na} · ${esc(B.name)}: ${nb}</span></p>`;
  }).join('');
  return `<section class="pair-details"><h3><span class="dot" style="background:${A.color}"></span>${esc(A.name)} + <span class="dot" style="background:${B.color}"></span>${esc(B.name)} <span class="muted small">${e.n}</span>
    <button class="link" data-act="pair-retrieve" data-a="${a}" data-b="${b}">Retrieve both codes</button></h3>${items}</section>`;
}

function cooccurCSV() {
  const u = U();
  const { codes, pairs, diag, key } = cooccurrence(u.unit);
  const out = [[`Code (${UNIT_LABELS[u.unit]})`, ...codes.map((id) => codePath(id, ' > '))]];
  for (const a of codes) out.push([codePath(a, ' > '), ...codes.map((b) => (a === b ? diag.get(a) || 0 : pairs.get(key(a, b))?.n || 0))]);
  download(`${slug(S.project.name)}-cooccurrence-${u.unit}.csv`, toCSV(out), 'text/csv;charset=utf-8');
}

// ---------------------------------------------------------------- events

function clearDocFilters(u) {
  u.docs = []; u.sets = []; u.attrs = {};
}

async function onClick(e, root) {
  const u = U();
  const t = e.target.closest('[data-tab],[data-act],[data-ctx],[data-goto],[data-memo-on],[data-cell],[data-pair]');
  if (!t) return;
  if (t.dataset.tab) { u.tab = t.dataset.tab; render(root.parentElement); return; }
  if (t.dataset.ctx) { u.open[t.dataset.ctx] = !u.open[t.dataset.ctx]; renderResults(root); return; }
  if (t.dataset.goto) {
    const c = S.project.codings.find((x) => x.id === t.dataset.goto);
    if (c) go('code', { code: { docId: c.doc, active: c.id, clicked: [c.id], scrollTo: c.id, pending: null } });
    return;
  }
  if (t.dataset.memoOn) {
    const c = S.project.codings.find((x) => x.id === t.dataset.memoOn);
    if (!c) return;
    editMemoModal(newMemo({ title: `On “${truncate(oneLine(excerptText(c)), 50)}”`, quote: excerptText(c), links: [{ kind: 'coding', id: c.id }, { kind: 'code', id: c.code }, { kind: 'doc', id: c.doc }] }));
    return;
  }
  if (t.dataset.cell) {
    const { cols } = codeMatrix({ colMode: u.colMode, rollup: u.rollup, measure: u.measure });
    const col = cols[Number(t.dataset.col)];
    clearDocFilters(u);
    if (u.colMode === 'doc') u.docs = [...col.docIds];
    else if (u.colMode === 'set') u.sets = [col.value === '(no set)' ? '' : col.value];
    else u.attrs = { [u.colMode]: [col.value === '(blank)' ? '' : col.value] };
    Object.assign(u, { tab: 'retrieve', codes: [t.dataset.cell], group: '', includeChildren: u.rollup, q: '', origin: 'all' });
    render(root.parentElement);
    return;
  }
  if (t.dataset.pair) { u.pair = u.pair === t.dataset.pair ? null : t.dataset.pair; render(root.parentElement); return; }
  switch (t.dataset.act) {
    case 'all-codes': u.codes = S.project.codes.map((c) => c.id); u.group = ''; break;
    case 'no-codes': u.codes = []; u.group = ''; break;
    case 'clear-docs': u.docs = []; break;
    case 'reset': clearDocFilters(u); Object.assign(u, { origin: 'all', q: '', group: '' }); break;
    case 'pair-retrieve':
      clearDocFilters(u);
      Object.assign(u, { tab: 'retrieve', codes: [t.dataset.a, t.dataset.b], group: '', includeChildren: false, q: '' });
      break;
    case 'copy': {
      const r = excerptReport(currentResults(), { title: resultsTitle(), subtitle: `${S.project.name} · retrieved ${new Date().toLocaleDateString()}` });
      toast((await copyRich(r.html, r.text)) ? 'Copied. Paste into Google Docs or Word.' : 'Copy failed', 'ok');
      return;
    }
    case 'csv':
      download(`${slug(S.project.name)}-${slug(resultsTitle())}-excerpts.csv`, toCSV(excerptRows(currentResults())), 'text/csv;charset=utf-8');
      return;
    case 'html': {
      const r = excerptReport(currentResults(), { title: resultsTitle(), subtitle: `${S.project.name} · retrieved ${new Date().toLocaleDateString()}` });
      download(`${slug(S.project.name)}-${slug(resultsTitle())}-excerpts.html`, htmlPage(resultsTitle(), r.html), 'text/html;charset=utf-8');
      return;
    }
    case 'matrix-csv': matrixCSV(); return;
    case 'cooccur-csv': cooccurCSV(); return;
    default: return;
  }
  render(root.parentElement);
}

function onChange(e, root) {
  const u = U();
  const t = e.target;
  if (t.matches('[data-code-check]')) {
    u.codes = $$('[data-code-check]:checked', root).map((x) => x.value);
    renderResults(root);
    return;
  }
  if (t.matches('[data-children]')) u.includeChildren = t.checked;
  else if (t.matches('[data-group]')) u.group = t.value;
  else if (t.matches('[data-set-check]')) u.sets = $$('[data-set-check]:checked', root).map((x) => x.value);
  else if (t.matches('[data-attr-check]')) {
    const k = t.dataset.attrCheck;
    u.attrs[k] = $$(`[data-attr-check="${CSS.escape(k)}"]:checked`, root).map((x) => x.value);
  } else if (t.matches('[data-origin]')) u.origin = t.value;
  else if (t.matches('[data-colmode]')) u.colMode = t.value;
  else if (t.matches('[data-measure]')) u.measure = t.value;
  else if (t.matches('[data-rollup]')) u.rollup = t.checked;
  else if (t.matches('[data-unit]')) { u.unit = t.value; u.pair = null; }
  else return;
  if (u.tab === 'retrieve' && !t.matches('[data-group],[data-children]')) renderResults(root);
  else render(root.parentElement);
}
