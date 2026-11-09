// Code view: documents list, the text with highlights, and the coding panel.
import {
  S, idx, mutate, go, paragraphs, codeTree, descendants, codePath, locLabel, makeCode,
  findCodeByName, excerptText, logEvent,
} from '../store.js';
import { esc, rgba, truncate, oneLine, uid, nowIso, toast, fmtDate, plural, promptDialog, MOD, SHIFT, $, $$ } from '../util.js';
import { openImportDialog, editDocDialog } from '../import.js';
import { aiSectionHtml, handleAiAction, handleAiChange } from '../ai.js';
import { newMemo, editMemoModal, memosLinkedTo } from './memos.js';

const U = () => (S.ui.code ||= {});
function ui() {
  const u = U();
  u.pending ??= null; u.active ??= null; u.clicked ??= []; u.focus ??= [];
  u.docFilter ??= ''; u.codeFilter ??= ''; u.recent ??= [];
  return u;
}

let root = null;
let selecting = false;
const pop = { open: false, items: [], active: 0 };

export function render(el) {
  const u = ui();
  const p = S.project;
  const I = idx();
  if (!u.docId || !I.docs.has(u.docId)) { u.docId = p.documents[0]?.id || null; u.resetScroll = true; }
  if (u.pending && u.pending.doc !== u.docId) u.pending = null;
  u.clicked = u.clicked.filter((id) => p.codings.some((c) => c.id === id));
  root = el.querySelector('.code-view');
  if (!root) build(el);
  renderDocList();
  renderDocHead();
  renderText();
  renderSide();
}

function build(el) {
  el.innerHTML = `<div class="code-view">
    <aside class="pane docs-pane" aria-label="Documents">
      <div class="pane-head">
        <div class="pane-title"><h2>Documents</h2><button class="btn small primary" data-act="import">+ Add</button></div>
        <input type="search" class="filter" data-doc-filter placeholder="Filter by title or attribute" aria-label="Filter documents">
      </div>
      <div class="pane-scroll" data-scroll-key="docs" id="docList"></div>
    </aside>
    <section class="pane text-pane" aria-label="Document text">
      <div id="docHead"></div>
      <div class="pane-scroll text-scroll" data-scroll-key="text" id="docText"></div>
    </section>
    <aside class="pane side-pane" aria-label="Coding panel">
      <div class="pane-scroll" data-scroll-key="side" id="sidePanel"></div>
    </aside>
    <div id="codePop" class="code-pop" hidden></div>
  </div>`;
  root = el.querySelector('.code-view');
  $('[data-doc-filter]', root).value = ui().docFilter;
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('mouseover', onHover);
  root.addEventListener('mouseout', onHover);
  $('#docText', root).addEventListener('mousedown', onMouseDown);
}

// ---------------------------------------------------------------- left: documents

function renderDocList() {
  const u = ui();
  const p = S.project;
  const I = idx();
  const q = u.docFilter.trim().toLowerCase();
  const sets = new Map();
  for (const d of p.documents) {
    if (q && !(`${d.title} ${d.set} ${Object.values(d.attrs).join(' ')}`.toLowerCase().includes(q))) continue;
    if (!sets.has(d.set || '')) sets.set(d.set || '', []);
    sets.get(d.set || '').push(d);
  }
  const keys = [...sets.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  let html = '';
  for (const k of keys) {
    if (k) html += `<div class="set-head">${esc(k)} <span class="muted">${sets.get(k).length}</span></div>`;
    for (const d of sets.get(k)) {
      const n = (I.byDoc.get(d.id) || []).length;
      const attrs = Object.entries(d.attrs).filter(([, v]) => v).map(([, v]) => v).join(' · ');
      html += `<button class="doc-item ${d.id === u.docId ? 'on' : ''}" data-doc="${d.id}">
        <span class="doc-title">${esc(d.title)}</span>
        <span class="doc-meta">${attrs ? `${esc(truncate(attrs, 60))} · ` : ''}${plural(n, 'excerpt')}</span></button>`;
    }
  }
  if (!p.documents.length) {
    html = '<p class="empty small">No documents yet. Use <b>+ Add</b> to bring in transcripts, notes or survey responses.</p>';
  } else if (!html) html = '<p class="empty small">No documents match.</p>';
  $('#docList', root).innerHTML = html;
}

// ---------------------------------------------------------------- center: text

function renderDocHead() {
  const u = ui();
  const doc = idx().docs.get(u.docId);
  const head = $('#docHead', root);
  if (!doc) { head.innerHTML = ''; return; }
  const n = (idx().byDoc.get(doc.id) || []).length;
  const attrs = Object.entries(doc.attrs).filter(([, v]) => v)
    .map(([k, v]) => `<span class="chip plain" title="${esc(k)}">${esc(k)}: ${esc(v)}</span>`).join('');
  const focus = u.focus.length ? `<div class="focus-bar">Highlighting only ${u.focus.map((id) => {
    const c = idx().codes.get(id);
    return c ? `<span class="chip" style="--c:${c.color}">${esc(c.name)}</span>` : '';
  }).join(' ')} and their child codes <button class="link" data-act="clear-focus">Show all codes</button></div>` : '';
  head.innerHTML = `<div class="doc-head">
      <div class="dh-main"><h1>${esc(doc.title)}</h1>
        <div class="dh-meta">${doc.set ? `<span class="chip plain">${esc(doc.set)}</span>` : ''}${attrs}<span class="muted small">${plural(paragraphs(doc).filter((x) => x.n).length, 'paragraph')} · ${plural(n, 'coded excerpt')}</span></div></div>
      <div class="dh-actions">
        <button class="btn small" data-act="doc-details">Details</button>
        <button class="btn small" data-act="doc-memo">Memo</button>
        <button class="icon-btn" data-act="prev-doc" title="Previous document" aria-label="Previous document">‹</button>
        <button class="icon-btn" data-act="next-doc" title="Next document" aria-label="Next document">›</button>
      </div></div>${focus}`;
}

function segStyle(cov, activeIds) {
  const sorted = [...cov].sort((a, b) => (a.end - a.start) - (b.end - b.start));
  const colors = sorted.map((c) => idx().codes.get(c.code)?.color || '#888');
  const isActive = sorted.some((c) => activeIds.has(c.id));
  const bg = rgba(colors[0], isActive ? 0.42 : 0.2);
  const lines = colors.slice(0, 4).map((col, i) => `inset 0 -${2 * (i + 1)}px 0 ${col}`).join(',');
  return `background:${bg};box-shadow:${lines}`;
}

function renderText() {
  const u = ui();
  const I = idx();
  const doc = I.docs.get(u.docId);
  const box = $('#docText', root);
  if (!doc) {
    box.innerHTML = `<div class="empty big"><h2>Start by adding documents</h2>
      <p>Interview transcripts, field notes, open-ended survey responses or any other text.</p>
      <button class="btn primary" data-act="import">Add documents</button></div>`;
    return;
  }
  const scroll = u.resetScroll ? 0 : box.scrollTop;
  u.resetScroll = false;
  let codings = I.byDoc.get(doc.id) || [];
  if (u.focus.length) {
    const allowed = new Set(u.focus.flatMap((id) => descendants(id)));
    codings = codings.filter((c) => allowed.has(c.code));
  }
  const activeIds = new Set([u.active, ...u.clicked].filter(Boolean));
  const sugg = S.project.settings.ai_enabled
    ? S.project.suggestions.filter((s) => s.doc === doc.id && s.status === 'pending') : [];
  const pend = u.pending;
  const out = [];
  for (const para of paragraphs(doc)) {
    if (para.n == null) {
      out.push(`<div class="para blank"><div class="pnum"></div><div class="ptext" data-s="${para.start}">${esc(para.text)}</div><div class="pchips"></div></div>`);
      continue;
    }
    const pc = codings.filter((c) => c.start < para.end && c.end > para.start);
    const ps = sugg.filter((s) => s.start < para.end && s.end > para.start);
    const pts = new Set([para.start, para.end]);
    const addPts = (a, b) => { pts.add(Math.max(a, para.start)); pts.add(Math.min(b, para.end)); };
    for (const c of pc) addPts(c.start, c.end);
    for (const s of ps) addPts(s.start, s.end);
    if (pend && pend.start < para.end && pend.end > para.start) addPts(pend.start, pend.end);
    const cuts = [...pts].sort((a, b) => a - b);
    let html = '';
    for (let k = 0; k < cuts.length - 1; k++) {
      const a = cuts[k];
      const b = cuts[k + 1];
      if (a >= b) continue;
      const seg = esc(doc.text.slice(a, b));
      const cov = pc.filter((c) => c.start < b && c.end > a);
      const sv = ps.filter((s) => s.start < b && s.end > a);
      const isPend = pend && pend.start < b && pend.end > a;
      if (!cov.length && !sv.length && !isPend) { html += seg; continue; }
      const cls = ['seg'];
      if (isPend) cls.push('pending');
      if (sv.length) cls.push('sugg');
      const title = cov.map((c) => codePath(c.code)).join('\n');
      html += `<span class="${cls.join(' ')}"${cov.length ? ` data-cs="${cov.map((c) => c.id).join(' ')}" style="${segStyle(cov, activeIds)}"` : ''}${sv.length ? ` data-sg="${sv.map((s) => s.id).join(' ')}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${seg}</span>`;
    }
    const chips = pc.filter((c) => c.start >= para.start).map((c) => {
      const code = I.codes.get(c.code);
      return `<button class="chip ${activeIds.has(c.id) ? 'on' : ''}" data-coding="${c.id}" style="--c:${code.color}" title="${esc(codePath(c.code))}: “${esc(truncate(oneLine(excerptText(c)), 120))}”">${esc(truncate(code.name, 28))}${c.origin === 'ai' ? '<i class="ai-dot" title="Accepted from an AI suggestion">AI</i>' : ''}${c.end > para.end ? ' ↓' : ''}</button>`;
    }).join('');
    out.push(`<div class="para"><div class="pnum">${para.n}</div><div class="ptext" data-s="${para.start}">${html}</div><div class="pchips">${chips}</div></div>`);
  }
  box.innerHTML = `<div class="text-inner">${out.join('')}</div>`;
  box.scrollTop = scroll;
  if (u.scrollTo) {
    const target = u.scrollTo === 'pending'
      ? $('.seg.pending', box)
      : $(`[data-cs~="${u.scrollTo}"]`, box) || $(`[data-sg~="${u.scrollTo}"]`, box);
    target?.scrollIntoView({ block: 'center' });
    u.scrollTo = null;
  }
}

// ---------------------------------------------------------------- right: panel

function codeOptions(selected = '') {
  return codeTree().map(({ code, depth }) => `<option value="${code.id}" ${code.id === selected ? 'selected' : ''}>${'  '.repeat(depth)}${esc(code.name)}</option>`).join('');
}

function codingCard(c, doc) {
  const u = ui();
  const memos = memosLinkedTo('coding', c.id);
  return `<div class="coding-card ${c.id === u.active ? 'on' : ''}" data-cid="${c.id}">
    <div class="cc-head"><span class="dot" style="background:${idx().codes.get(c.code)?.color}"></span><b>${esc(codePath(c.code))}</b>${c.origin === 'ai' ? '<span class="tag ai" title="Accepted from an AI suggestion">AI</span>' : ''}</div>
    <blockquote>${esc(truncate(excerptText(c), 240))}</blockquote>
    <div class="cc-meta">${esc(locLabel(doc, c.start))} · coded ${esc(fmtDate(c.created))}</div>
    <div class="btn-row">
      <button class="btn small" data-act="add-same" data-cid="${c.id}" title="Apply another code to this exact text">+ Code</button>
      <select class="small" data-recode="${c.id}" aria-label="Recode"><option value="">Recode as…</option>${codeOptions()}</select>
      <button class="btn small" data-act="coding-memo" data-cid="${c.id}">Memo</button>
      <button class="btn small danger-ghost" data-act="uncode" data-cid="${c.id}">Remove</button>
    </div>
    ${memos.length ? `<div class="mini-memos">${memos.map((m) => `<button class="memo-link" data-memo="${m.id}">✎ ${esc(m.title)}</button>`).join('')}</div>` : ''}
  </div>`;
}

function codeListHtml() {
  const u = ui();
  const I = idx();
  const q = u.codeFilter.trim().toLowerCase();
  const inDoc = new Map();
  for (const c of I.byDoc.get(u.docId) || []) inDoc.set(c.code, (inDoc.get(c.code) || 0) + 1);
  const rows = codeTree().filter(({ code }) => !q || code.name.toLowerCase().includes(q) || (code.definition || '').toLowerCase().includes(q));
  if (!rows.length) return `<p class="empty small">${S.project.codes.length ? 'No codes match.' : 'No codes yet. Select text and type a name to create the first one.'}</p>`;
  return rows.map(({ code, depth }) => `<div class="code-row ${u.focus.includes(code.id) ? 'on' : ''}" style="--depth:${q ? 0 : depth}">
      <button class="code-btn" data-code="${code.id}" title="${esc(code.definition || codePath(code.id))}"><span class="dot" style="background:${code.color}"></span><span class="nm">${esc(q ? codePath(code.id) : code.name)}</span><span class="ct" title="Excerpts in this document / in all documents">${inDoc.get(code.id) || 0}/${(I.byCode.get(code.id) || []).length}</span></button>
      <button class="icon-btn tiny" data-edit-code="${code.id}" title="Open in codebook" aria-label="Open ${esc(code.name)} in codebook">✎</button>
    </div>`).join('');
}

function renderSide() {
  const u = ui();
  const p = S.project;
  const I = idx();
  const doc = I.docs.get(u.docId);
  const box = $('#sidePanel', root);
  const parts = [];
  if (u.pending && doc) {
    parts.push(`<section class="card ctx"><h3>Selected text</h3>
      <blockquote>${esc(truncate(doc.text.slice(u.pending.start, u.pending.end), 320))}</blockquote>
      <div class="btn-row">
        <button class="btn small primary" data-act="pop">Apply code…</button>
        <button class="btn small" data-act="invivo" title="Create a code from the selected words">In vivo</button>
        <button class="btn small" data-act="sel-memo">Memo</button>
        <button class="btn small ghost" data-act="cancel-sel">Cancel</button>
      </div></section>`);
  } else if (u.clicked.length && doc) {
    const list = u.clicked.map((id) => p.codings.find((c) => c.id === id)).filter(Boolean);
    parts.push(`<section class="card ctx"><div class="card-head"><h3>${list.length === 1 ? 'Coded excerpt' : `${list.length} codes on this text`}</h3><button class="icon-btn tiny" data-act="close-ctx" aria-label="Close">×</button></div>${list.map((c) => codingCard(c, doc)).join('')}</section>`);
  } else if (doc) {
    parts.push('<section class="card hint-card"><p>Select text to code it. Click highlighted text or a code label in the margin to see its codes.</p></section>');
  }
  parts.push(`<section class="card codes-card">
    <div class="card-head"><h3>Codes <span class="muted">${p.codes.length}</span></h3><button class="btn small" data-act="new-code">+ New</button></div>
    <input type="search" class="filter" data-code-filter placeholder="Filter codes" value="${esc(u.codeFilter)}" aria-label="Filter codes">
    <div class="code-list" data-code-list>${codeListHtml()}</div>
    <p class="hint small">${u.pending ? 'Click a code to apply it to the selected text.' : `Click a code to highlight only that code (${SHIFT}click to add more).`}</p>
  </section>`);
  if (p.settings.ai_enabled && doc) parts.push(aiSectionHtml(doc, u));
  if (doc) {
    const memos = memosLinkedTo('doc', doc.id);
    parts.push(`<section class="card"><div class="card-head"><h3>Memos on this document</h3><button class="btn small" data-act="doc-memo">+ Memo</button></div>
      ${memos.length ? memos.map((m) => `<button class="memo-link" data-memo="${m.id}"><b>${esc(m.title)}</b><span class="muted small">${esc(fmtDate(m.updated, false))}</span></button>`).join('') : '<p class="muted small">None yet.</p>'}</section>`);
  }
  const scroll = box.scrollTop;
  box.innerHTML = parts.join('');
  box.scrollTop = scroll;
  if (u.aiFocus) {
    $(`[data-sid="${u.aiFocus}"]`, box)?.scrollIntoView({ block: 'nearest' });
  }
}

function renderAll() {
  renderDocList();
  renderDocHead();
  renderText();
  renderSide();
}

// ---------------------------------------------------------------- selection → offsets

function pointOffset(box, node, offset, doc) {
  if (!box.contains(node)) {
    const pos = box.compareDocumentPosition(node);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return doc.text.length;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 0;
    return null;
  }
  const el = node.nodeType === 1 ? node : node.parentElement;
  const ptext = el.closest('.ptext');
  if (ptext) {
    const r = document.createRange();
    r.setStart(ptext, 0);
    r.setEnd(node, offset);
    return Number(ptext.dataset.s) + r.toString().length;
  }
  const para = el.closest('.para');
  if (para) {
    const pt = $('.ptext', para);
    if (el.closest('.pnum')) return Number(pt.dataset.s);
    return Number(pt.dataset.s) + pt.textContent.length;
  }
  const inner = $('.text-inner', box);
  if (inner && (node === inner || node === box)) {
    const kids = inner.children;
    if (node === inner && offset < kids.length) return Number($('.ptext', kids[offset]).dataset.s);
    return node === box && offset === 0 ? 0 : doc.text.length;
  }
  return null;
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('.pchips, button, .pnum')) return;
  selecting = true;
  if (pop.open) closePop(false);
}

document.addEventListener('mouseup', (e) => {
  if (!selecting) return;
  selecting = false;
  if (S.view !== 'code' || !root?.isConnected) return;
  // Let the browser finish updating the selection first.
  setTimeout(() => finishSelection(e), 0);
});

function finishSelection(e) {
  const u = ui();
  const box = $('#docText', root);
  const doc = idx().docs.get(u.docId);
  if (!doc) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) { clickText(e); return; }
  const range = sel.getRangeAt(0);
  let a = pointOffset(box, range.startContainer, range.startOffset, doc);
  let b = pointOffset(box, range.endContainer, range.endOffset, doc);
  if (a == null || b == null) return;
  if (a > b) [a, b] = [b, a];
  while (a < b && /\s/.test(doc.text[a])) a++;
  while (b > a && /\s/.test(doc.text[b - 1])) b--;
  if (b <= a) { clickText(e); return; }
  const rects = range.getClientRects();
  const r = rects[rects.length - 1] || range.getBoundingClientRect();
  const anchor = { left: r.left, top: r.top, bottom: r.bottom };
  u.pending = { doc: doc.id, start: a, end: b };
  u.clicked = [];
  u.active = null;
  sel.removeAllRanges();
  renderText();
  renderSide();
  openPop(anchor);
}

function clickText(e) {
  const u = ui();
  const seg = e.target.closest?.('.seg');
  const had = u.pending || u.clicked.length || u.active;
  u.pending = null;
  if (seg?.dataset.sg) {
    u.aiFocus = seg.dataset.sg.split(' ')[0];
  }
  if (seg?.dataset.cs) {
    u.clicked = seg.dataset.cs.split(' ');
    u.active = u.clicked[0];
  } else {
    u.clicked = [];
    u.active = null;
  }
  if (had || seg) { renderText(); renderSide(); }
}

// ---------------------------------------------------------------- the code picker

function openPop(anchor) {
  const el = $('#codePop', root);
  pop.open = true;
  pop.active = 0;
  el.hidden = false;
  el.innerHTML = `<input type="text" class="pop-input" placeholder="Type to find or create a code" aria-label="Code name" autocomplete="off">
    <div class="pop-list" role="listbox"></div>
    <div class="pop-foot">↑↓ choose · Enter apply · ${SHIFT}Enter apply and keep open · Esc close</div>`;
  const w = 340;
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - w - 8);
  let top = anchor.bottom + 8;
  if (top + 330 > window.innerHeight) top = Math.max(8, anchor.top - 330 - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const input = $('.pop-input', el);
  input.addEventListener('input', () => { pop.active = 0; renderPopList(); });
  input.addEventListener('keydown', popKey);
  el.onmousedown = (e) => { if (!e.target.matches('input')) e.preventDefault(); };
  el.onclick = (e) => {
    const it = e.target.closest('[data-pi]');
    if (it) choosePop(Number(it.dataset.pi), e.shiftKey);
  };
  renderPopList();
  input.focus();
}

function popItems(q) {
  const u = ui();
  const I = idx();
  const items = [];
  const qn = q.trim().toLowerCase();
  if (!qn) {
    for (const id of u.recent) if (I.codes.has(id)) items.push({ kind: 'code', id, recent: true });
    for (const { code } of codeTree()) {
      if (items.length >= 12) break;
      if (!items.some((x) => x.id === code.id)) items.push({ kind: 'code', id: code.id });
    }
  } else {
    const rank = (c) => (c.name.toLowerCase().startsWith(qn) ? 0 : c.name.toLowerCase().includes(qn) ? 1 : 2);
    const matches = S.project.codes.filter((c) => c.name.toLowerCase().includes(qn) || codePath(c.id).toLowerCase().includes(qn));
    matches.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    for (const c of matches.slice(0, 12)) items.push({ kind: 'code', id: c.id });
    if (!findCodeByName(q)) items.push({ kind: 'create', name: q.trim() });
  }
  items.push({ kind: 'invivo' });
  return items;
}

function renderPopList() {
  const el = $('#codePop', root);
  const q = $('.pop-input', el).value;
  pop.items = popItems(q);
  pop.active = Math.min(pop.active, pop.items.length - 1);
  const I = idx();
  const sel = ui().pending;
  const doc = I.docs.get(ui().docId);
  $('.pop-list', el).innerHTML = pop.items.map((it, i) => {
    const on = i === pop.active ? ' on' : '';
    if (it.kind === 'code') {
      const c = I.codes.get(it.id);
      return `<div class="pop-item${on}" data-pi="${i}" role="option" aria-selected="${!!on}"><span class="dot" style="background:${c.color}"></span><span class="nm">${esc(codePath(c.id))}</span>${it.recent ? '<span class="muted small">recent</span>' : ''}</div>`;
    }
    if (it.kind === 'create') return `<div class="pop-item create${on}" data-pi="${i}" role="option">+ Create code “${esc(it.name)}”</div>`;
    const words = sel && doc ? truncate(oneLine(doc.text.slice(sel.start, sel.end)), 40) : '';
    return `<div class="pop-item invivo${on}" data-pi="${i}" role="option">In vivo: “${esc(words)}”</div>`;
  }).join('');
}

function popKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); pop.active = (pop.active + 1) % pop.items.length; renderPopList(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pop.active = (pop.active - 1 + pop.items.length) % pop.items.length; renderPopList(); }
  else if (e.key === 'Enter') { e.preventDefault(); choosePop(pop.active, e.shiftKey); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(true); }
}

function choosePop(i, keepOpen) {
  const it = pop.items[i];
  if (!it) return;
  if (it.kind === 'code') applyCode(it.id, keepOpen);
  else if (it.kind === 'create') createAndApply(it.name, keepOpen);
  else invivo(keepOpen);
}

function closePop(clearPending) {
  const el = root && $('#codePop', root);
  if (el) el.hidden = true;
  pop.open = false;
  if (clearPending) {
    ui().pending = null;
    renderText();
    renderSide();
  }
}

// ---------------------------------------------------------------- coding actions

function addCoding(p, pend, codeId) {
  const c = { id: uid('cd'), doc: pend.doc, start: pend.start, end: pend.end, code: codeId, origin: 'human', created: nowIso() };
  p.codings.push(c);
  return c.id;
}

function afterApply(codingId, codeId, keepOpen) {
  const u = ui();
  u.recent = [codeId, ...u.recent.filter((x) => x !== codeId)].slice(0, 6);
  if (keepOpen && pop.open) {
    const input = $('#codePop .pop-input', root);
    input.value = '';
    renderPopList();
    input.focus();
    toast(`Applied “${idx().codes.get(codeId)?.name}”`);
  } else {
    u.pending = null;
    u.active = codingId;
    u.clicked = [codingId];
    closePop(false);
  }
  renderAll();
}

function applyCode(codeId, keepOpen = false) {
  const pend = ui().pending;
  if (!pend) return;
  if (S.project.codings.some((c) => c.doc === pend.doc && c.code === codeId && c.start === pend.start && c.end === pend.end)) {
    toast('That code is already on this exact text');
    return;
  }
  const id = mutate('apply code', (p) => addCoding(p, pend, codeId), { render: false });
  afterApply(id, codeId, keepOpen);
}

function createAndApply(name, keepOpen = false) {
  const pend = ui().pending;
  if (!pend || !name.trim()) return;
  let codeId;
  const id = mutate('create and apply code', (p) => {
    const code = makeCode(p, name);
    codeId = code.id;
    return addCoding(p, pend, code.id);
  }, { render: false });
  afterApply(id, codeId, keepOpen);
}

function invivo(keepOpen = false) {
  const u = ui();
  const pend = u.pending;
  const doc = idx().docs.get(u.docId);
  if (!pend || !doc) return;
  const name = `“${truncate(oneLine(doc.text.slice(pend.start, pend.end)), 60)}”`;
  const existing = findCodeByName(name);
  if (existing) applyCode(existing.id, keepOpen);
  else createAndApply(name, keepOpen);
}

function moveDoc(step) {
  const u = ui();
  const docs = S.project.documents;
  const i = docs.findIndex((d) => d.id === u.docId);
  const next = docs[i + step];
  if (!next) return;
  openDoc(next.id);
}

function openDoc(id) {
  const u = ui();
  u.docId = id;
  u.pending = null;
  u.clicked = [];
  u.active = null;
  u.aiFocus = null;
  u.resetScroll = true;
  closePop(false);
  renderAll();
}

// ---------------------------------------------------------------- events

function onClick(e) {
  const u = ui();
  const t = e.target.closest('[data-act],[data-doc],[data-coding],[data-code],[data-edit-code],[data-memo]');
  if (!t || !root.contains(t)) return;
  if (t.dataset.doc) return openDoc(t.dataset.doc);
  if (t.dataset.coding) {
    u.pending = null;
    u.active = t.dataset.coding;
    u.clicked = [t.dataset.coding];
    renderText();
    renderSide();
    return;
  }
  if (t.dataset.code) {
    const id = t.dataset.code;
    if (u.pending) return applyCode(id, e.shiftKey);
    if (e.shiftKey) u.focus = u.focus.includes(id) ? u.focus.filter((x) => x !== id) : [...u.focus, id];
    else u.focus = u.focus.length === 1 && u.focus[0] === id ? [] : [id];
    renderDocHead(); renderText(); renderSide();
    return;
  }
  if (t.dataset.editCode) return go('codebook', { codebook: { sel: t.dataset.editCode } });
  if (t.dataset.memo) return editMemoModal(t.dataset.memo);
  const act = t.dataset.act;
  const doc = idx().docs.get(u.docId);
  if (handleAiAction(act, t, e)) return;
  switch (act) {
    case 'import': openImportDialog(); break;
    case 'doc-details': if (doc) editDocDialog(doc.id); break;
    case 'prev-doc': moveDoc(-1); break;
    case 'next-doc': moveDoc(1); break;
    case 'clear-focus': u.focus = []; renderDocHead(); renderText(); renderSide(); break;
    case 'close-ctx': u.clicked = []; u.active = null; renderText(); renderSide(); break;
    case 'pop': {
      const seg = $('#docText .seg.pending:last-of-type', root) || $('#docText .seg.pending', root);
      const r = seg ? seg.getBoundingClientRect() : t.getBoundingClientRect();
      openPop({ left: r.left, top: r.top, bottom: r.bottom });
      break;
    }
    case 'invivo': invivo(); break;
    case 'cancel-sel': closePop(true); break;
    case 'new-code': newCodeFromPanel(); break;
    case 'add-same': {
      const c = S.project.codings.find((x) => x.id === t.dataset.cid);
      if (!c) break;
      u.pending = { doc: c.doc, start: c.start, end: c.end };
      u.clicked = [];
      renderText();
      renderSide();
      const r = t.getBoundingClientRect();
      openPop({ left: r.left - 200, top: r.top, bottom: r.bottom });
      break;
    }
    case 'uncode': {
      const c = S.project.codings.find((x) => x.id === t.dataset.cid);
      if (!c) break;
      const name = idx().codes.get(c.code)?.name;
      mutate('remove code', (p) => { p.codings = p.codings.filter((x) => x.id !== c.id); }, { render: false });
      u.clicked = u.clicked.filter((x) => x !== c.id);
      if (u.active === c.id) u.active = null;
      renderAll();
      toast(`Removed “${name}”. ${MOD}Z to undo.`);
      break;
    }
    case 'coding-memo': {
      const c = S.project.codings.find((x) => x.id === t.dataset.cid);
      if (!c) break;
      const id = newMemo({
        title: `On “${truncate(oneLine(excerptText(c)), 50)}”`,
        quote: excerptText(c),
        links: [{ kind: 'coding', id: c.id }, { kind: 'code', id: c.code }, { kind: 'doc', id: c.doc }],
      });
      editMemoModal(id);
      break;
    }
    case 'sel-memo': {
      if (!u.pending || !doc) break;
      const quote = doc.text.slice(u.pending.start, u.pending.end);
      const id = newMemo({ title: `On “${truncate(oneLine(quote), 50)}”`, quote: `${quote}\n(${doc.title}, ${locLabel(doc, u.pending.start)})`, links: [{ kind: 'doc', id: doc.id }] });
      editMemoModal(id);
      break;
    }
    case 'doc-memo': {
      if (!doc) break;
      const id = newMemo({ title: `Memo on ${doc.title}`, type: 'document', links: [{ kind: 'doc', id: doc.id }] });
      editMemoModal(id);
      break;
    }
    default: break;
  }
}

async function newCodeFromPanel() {
  const name = (await promptDialog('New code', 'Code name', ui().codeFilter || ''))?.trim();
  if (!name) return;
  if (findCodeByName(name)) { toast('A code with that name already exists'); return; }
  mutate('create code', (p) => makeCode(p, name));
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.recode) {
    const codeId = t.value;
    const c = S.project.codings.find((x) => x.id === t.dataset.recode);
    if (!c || !codeId || codeId === c.code) return;
    const from = idx().codes.get(c.code)?.name;
    mutate('recode', (p) => {
      const cc = p.codings.find((x) => x.id === c.id);
      cc.code = codeId;
      cc.recoded = nowIso();
      logEvent(p, 'Excerpt recoded', `${from} → ${idx().codes.get(codeId)?.name}`);
    });
    return;
  }
  handleAiChange(t);
}

function onInput(e) {
  const t = e.target;
  const u = ui();
  if (t.matches('[data-doc-filter]')) { u.docFilter = t.value; renderDocList(); }
  else if (t.matches('[data-code-filter]')) { u.codeFilter = t.value; $('[data-code-list]', root).innerHTML = codeListHtml(); }
}

function onHover(e) {
  const chip = e.target.closest?.('.pchips .chip[data-coding]');
  if (!chip) return;
  const on = e.type === 'mouseover';
  $$(`[data-cs~="${chip.dataset.coding}"]`, root).forEach((s) => s.classList.toggle('hl', on));
}

document.addEventListener('keydown', (e) => {
  if (S.view !== 'code' || !root?.isConnected || document.querySelector('.modal-backdrop')) return;
  if (e.target.closest?.('input, textarea, select')) return;
  const u = ui();
  if (e.key === 'Escape' && (u.pending || u.clicked.length || u.focus.length)) {
    if (u.pending || u.clicked.length) { u.pending = null; u.clicked = []; u.active = null; }
    else u.focus = [];
    closePop(false);
    renderAll();
  } else if (e.key === 'Enter' && u.pending && !pop.open) {
    e.preventDefault();
    const seg = $('#docText .seg.pending', root);
    const r = seg ? seg.getBoundingClientRect() : { left: 200, top: 200, bottom: 220 };
    openPop({ left: r.left, top: r.top, bottom: r.bottom });
  } else if ((e.key === ']' || e.key === '[') && !e.metaKey && !e.ctrlKey) {
    moveDoc(e.key === ']' ? 1 : -1);
  }
});
