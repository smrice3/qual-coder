// Themes: second-cycle work. Group codes into categories, and categories
// (or codes) into themes, then read the whole map as an outline.
import {
  S, idx, mutate, go, bindField, codeTree, codePath, groupCodeIds, parentGroups, logEvent, descendants,
} from '../store.js';
import { esc, uid, nowIso, plural, truncate, confirmDialog, toast, $, $$ } from '../util.js';
import { newMemo, editMemoModal, memosLinkedTo } from './memos.js';

const U = () => (S.ui.themes ||= { unassignedOnly: false });

function stats(groupId) {
  const I = idx();
  const ids = groupCodeIds(groupId);
  let n = 0;
  const docs = new Set();
  for (const id of ids) for (const c of I.byCode.get(id) || []) { n++; docs.add(c.doc); }
  return { codes: ids.size, excerpts: n, docs: docs.size };
}

function assignedCodeIds() {
  const out = new Set();
  for (const g of S.project.groups) for (const m of g.members) if (m.kind === 'code') out.add(m.id);
  return out;
}

export function render(el) {
  let root = el.querySelector('.themes-view');
  if (!root) {
    el.innerHTML = `<div class="themes-view">
      <aside class="pane palette-pane" aria-label="Codes">
        <div class="pane-head"><div class="pane-title"><h2>Codes</h2></div>
          <label class="check small"><input type="checkbox" data-unassigned> Only codes not yet in a category or theme</label>
          <p class="hint small">Drag codes onto a card, or use “+ Add code” on the card.</p></div>
        <div class="pane-scroll" data-scroll-key="palette" data-palette></div>
      </aside>
      <section class="pane board-pane"><div class="pane-scroll" data-scroll-key="board" data-board></div></section>
    </div>`;
    root = el.querySelector('.themes-view');
    bind(root);
  }
  $('[data-unassigned]', root).checked = U().unassignedOnly;
  renderPalette(root);
  renderBoard(root);
}

function renderPalette(root) {
  const I = idx();
  const assigned = assignedCodeIds();
  const rows = codeTree().filter(({ code }) => !U().unassignedOnly || !assigned.has(code.id));
  $('[data-palette]', root).innerHTML = rows.length ? rows.map(({ code, depth }) => `
    <div class="pal-item ${assigned.has(code.id) ? 'assigned' : ''}" draggable="true" data-drag-code="${code.id}" style="--depth:${U().unassignedOnly ? 0 : depth}" title="${esc(code.definition || '')}">
      <span class="dot" style="background:${code.color}"></span><span class="nm">${esc(code.name)}</span><span class="ct">${(I.byCode.get(code.id) || []).length}</span>
    </div>`).join('') : '<p class="empty small">No codes here.</p>';
}

function memberChip(m, g) {
  const I = idx();
  if (m.kind === 'code') {
    const c = I.codes.get(m.id);
    if (!c) return '';
    const ids = descendants(c.id);
    const n = ids.reduce((s, id) => s + (I.byCode.get(id) || []).length, 0);
    const note = ids.length > 1 ? `, including ${plural(ids.length - 1, 'child code')}` : '';
    return `<span class="chip member" style="--c:${c.color}" draggable="true" data-drag-code="${c.id}" data-from="${g.id}" title="${esc(codePath(c.id))}: ${plural(n, 'excerpt')}${note}">${esc(c.name)} <small>${n}</small><button class="chip-x" data-remove="${g.id}|code|${c.id}" aria-label="Remove ${esc(c.name)}">×</button></span>`;
  }
  const sub = I.groups.get(m.id);
  if (!sub) return '';
  const st = stats(sub.id);
  const codes = sub.members.filter((x) => x.kind === 'code').map((x) => I.codes.get(x.id)).filter(Boolean);
  return `<div class="sub-group" draggable="true" data-drag-group="${sub.id}" data-from="${g.id}">
    <div class="sg-head"><span class="kind-badge cat">Category</span><b>${esc(sub.name)}</b> <span class="muted small">${plural(st.excerpts, 'excerpt')}</span><button class="chip-x" data-remove="${g.id}|group|${sub.id}" aria-label="Remove ${esc(sub.name)}">×</button></div>
    <div class="sg-codes">${codes.map((c) => `<span class="mini-code"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</span>`).join('')}</div>
  </div>`;
}

function card(g) {
  const st = stats(g.id);
  const memos = memosLinkedTo('group', g.id);
  const parents = parentGroups(g.id);
  const I = idx();
  const inGroup = new Set(g.members.map((m) => `${m.kind}:${m.id}`));
  const addCodeOpts = codeTree().filter(({ code }) => !inGroup.has(`code:${code.id}`))
    .map(({ code, depth }) => `<option value="${code.id}">${'  '.repeat(depth)}${esc(code.name)}</option>`).join('');
  const addCatOpts = g.kind === 'theme'
    ? S.project.groups.filter((x) => x.kind === 'category' && !inGroup.has(`group:${x.id}`)).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('') : '';
  return `<article class="gcard kind-${g.kind}" data-group="${g.id}">
    <div class="gcard-head">
      ${g.kind === 'theme' ? '<span class="kind-badge theme">Theme</span>' : `<span class="kind-badge cat drag-handle" draggable="true" data-drag-group="${g.id}" title="Drag onto a theme">⠿ Category</span>`}
      <textarea class="gname" data-gname="${g.id}" rows="${Math.min(3, Math.max(1, Math.ceil(g.name.length / 30)))}" aria-label="Name">${esc(g.name)}</textarea>
      <button class="icon-btn tiny" data-del-group="${g.id}" title="Delete" aria-label="Delete ${esc(g.name)}">×</button>
    </div>
    <textarea class="gdesc" data-gdesc="${g.id}" rows="2" placeholder="${g.kind === 'theme' ? 'State the theme as an assertion: what it says about the data' : 'What ties these codes together?'}">${esc(g.description || '')}</textarea>
    <div class="members" data-drop="${g.id}">${g.members.map((m) => memberChip(m, g)).join('') || `<p class="drop-hint">Drop ${g.kind === 'theme' ? 'categories or codes' : 'codes'} here</p>`}</div>
    <div class="gcard-add">
      <select class="small" data-add-code="${g.id}" aria-label="Add a code"><option value="">+ Add code</option>${addCodeOpts}</select>
      ${g.kind === 'theme' && addCatOpts ? `<select class="small" data-add-cat="${g.id}" aria-label="Add a category"><option value="">+ Add category</option>${addCatOpts}</select>` : ''}
    </div>
    <div class="gstats muted small">${plural(st.codes, 'code')} · ${plural(st.excerpts, 'excerpt')} · ${plural(st.docs, 'document')}${parents.length ? ` · in ${parents.map((x) => esc(x.name)).join(', ')}` : ''}</div>
    <div class="btn-row tight">
      <button class="btn small" data-view-group="${g.id}" ${st.excerpts ? '' : 'disabled'}>Read excerpts</button>
      <button class="btn small" data-memo-group="${g.id}">+ Memo</button>
      ${memos.map((m) => `<button class="memo-link inline" data-memo="${m.id}">✎ ${esc(truncate(m.title, 30))}</button>`).join('')}
    </div>
  </article>`;
}

function outline() {
  const p = S.project;
  const I = idx();
  const lines = [];
  const codeLine = (id, indent) => {
    const c = I.codes.get(id);
    if (c) lines.push(`${indent}• ${c.name} (${(I.byCode.get(id) || []).length})`);
  };
  const groupLines = (g, indent) => {
    const st = stats(g.id);
    lines.push(`${indent}${g.kind === 'theme' ? 'THEME' : 'Category'}: ${g.name} (${plural(st.excerpts, 'excerpt')}, ${plural(st.docs, 'document')})`);
    if (g.description) lines.push(`${indent}  ${g.description.replace(/\n/g, ' ')}`);
    for (const m of g.members) {
      if (m.kind === 'group') { const sub = I.groups.get(m.id); if (sub) groupLines(sub, `${indent}    `); }
      else codeLine(m.id, `${indent}    `);
    }
  };
  for (const g of p.groups.filter((x) => x.kind === 'theme')) { groupLines(g, ''); lines.push(''); }
  const loose = p.groups.filter((x) => x.kind !== 'theme' && !parentGroups(x.id).length);
  if (loose.length) {
    lines.push('Categories not yet in a theme:');
    for (const g of loose) groupLines(g, '  ');
    lines.push('');
  }
  const assigned = assignedCodeIds();
  const un = p.codes.filter((c) => !assigned.has(c.id) && !(c.parent && [...assigned].some((a) => a === c.parent)));
  if (un.length) lines.push(`Codes not in any category or theme (${un.length}): ${un.map((c) => c.name).join(', ')}`);
  return lines.join('\n');
}

export const themeOutline = outline;

function renderBoard(root) {
  const p = S.project;
  const themes = p.groups.filter((g) => g.kind === 'theme');
  const cats = p.groups.filter((g) => g.kind !== 'theme');
  $('[data-board]', root).innerHTML = `
    <div class="board-head">
      <div><h2>Categories and themes</h2>
      <p class="muted small">Second-cycle coding: cluster codes into categories, then bring categories together as themes. Click a name to rename it.</p></div>
      <div class="btn-row tight"><button class="btn small" data-new="category">+ Category</button><button class="btn small primary" data-new="theme">+ Theme</button></div>
    </div>
    ${!p.groups.length ? '<div class="empty big"><h2>No categories or themes yet</h2><p>Start with <b>+ Category</b> and drag in codes that belong together. When patterns emerge across categories, add a <b>Theme</b> and drag the categories into it.</p></div>' : ''}
    ${themes.length ? `<h3 class="board-sec">Themes</h3><div class="cards">${themes.map(card).join('')}</div>` : ''}
    ${cats.length ? `<h3 class="board-sec">Categories</h3><div class="cards">${cats.map(card).join('')}</div>` : ''}
    ${p.groups.length ? `<h3 class="board-sec">Outline</h3><pre class="outline">${esc(outline())}</pre>` : ''}`;
  for (const g of p.groups) {
    const n = $(`[data-gname="${g.id}"]`, root);
    n?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); n.blur(); } });
    n?.addEventListener('input', () => { n.rows = Math.min(3, Math.max(1, Math.ceil(n.value.length / 30))); });
    if (n) bindField(n, g, 'name', { label: 'rename', onCommit: (a, b) => { logEvent(p, `${g.kind === 'theme' ? 'Theme' : 'Category'} renamed`, `${a} → ${b}`); } });
    const d = $(`[data-gdesc="${g.id}"]`, root);
    if (d) bindField(d, g, 'description', { label: 'edit description' });
  }
}

function addMember(groupId, member, fromGroupId) {
  const p = S.project;
  const g = p.groups.find((x) => x.id === groupId);
  if (!g) return;
  if (member.kind === 'group') {
    if (g.kind !== 'theme') { toast('Categories go inside themes. Drop codes here instead.'); return; }
    if (member.id === groupId) return;
  }
  if (g.members.some((m) => m.kind === member.kind && m.id === member.id)) {
    if (fromGroupId && fromGroupId !== groupId) { /* already here: just remove from source */ } else return;
  }
  mutate(member.kind === 'code' ? 'add code to group' : 'add category to theme', (pp) => {
    const gg = pp.groups.find((x) => x.id === groupId);
    if (!gg.members.some((m) => m.kind === member.kind && m.id === member.id)) gg.members.push(member);
    if (fromGroupId && fromGroupId !== groupId) {
      const src = pp.groups.find((x) => x.id === fromGroupId);
      if (src) src.members = src.members.filter((m) => !(m.kind === member.kind && m.id === member.id));
    }
  });
}

function bind(root) {
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-unassigned]')) { U().unassignedOnly = t.checked; renderPalette(root); }
    else if (t.dataset.addCode && t.value) addMember(t.dataset.addCode, { kind: 'code', id: t.value });
    else if (t.dataset.addCat && t.value) addMember(t.dataset.addCat, { kind: 'group', id: t.value });
  });
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-new],[data-remove],[data-del-group],[data-view-group],[data-memo-group],[data-memo]');
    if (!t) return;
    if (t.dataset.new) {
      const kind = t.dataset.new;
      mutate(`new ${kind}`, (p) => {
        p.groups.push({ id: uid('g'), kind, name: kind === 'theme' ? 'New theme' : 'New category', description: '', members: [], created: nowIso() });
        logEvent(p, kind === 'theme' ? 'Theme created' : 'Category created', '');
      });
      const inputs = $$('[data-gname]', root);
      const last = inputs.find((i) => i.value === (kind === 'theme' ? 'New theme' : 'New category'));
      last?.focus();
      last?.select();
    } else if (t.dataset.remove) {
      const [gid, kind, id] = t.dataset.remove.split('|');
      mutate('remove from group', (p) => {
        const g = p.groups.find((x) => x.id === gid);
        g.members = g.members.filter((m) => !(m.kind === kind && m.id === id));
      });
    } else if (t.dataset.delGroup) {
      const g = idx().groups.get(t.dataset.delGroup);
      if (!(await confirmDialog(`Delete “${g.name}”? Its codes stay in the codebook. You can undo this.`, { ok: 'Delete', danger: true }))) return;
      mutate('delete group', (p) => {
        p.groups = p.groups.filter((x) => x.id !== g.id);
        for (const x of p.groups) x.members = x.members.filter((m) => !(m.kind === 'group' && m.id === g.id));
        for (const m of p.memos) m.links = m.links.filter((l) => !(l.kind === 'group' && l.id === g.id));
        logEvent(p, `${g.kind === 'theme' ? 'Theme' : 'Category'} deleted`, g.name);
      });
    } else if (t.dataset.viewGroup) {
      go('analyze', { analyze: { tab: 'retrieve', group: t.dataset.viewGroup, codes: [], docs: [], sets: [], attrs: {}, q: '' } });
    } else if (t.dataset.memoGroup) {
      const g = idx().groups.get(t.dataset.memoGroup);
      editMemoModal(newMemo({ title: `${g.kind === 'theme' ? 'Theme' : 'Category'} memo: ${g.name}`, type: 'theme', links: [{ kind: 'group', id: g.id }] }));
    } else if (t.dataset.memo) {
      editMemoModal(t.dataset.memo);
    }
  });

  // Drag and drop
  root.addEventListener('dragstart', (e) => {
    const code = e.target.closest?.('[data-drag-code]');
    const grp = e.target.closest?.('[data-drag-group]');
    const el = code || grp;
    if (!el || e.target.matches('input, textarea')) return;
    const payload = code
      ? { kind: 'code', id: code.dataset.dragCode, from: code.dataset.from || null }
      : { kind: 'group', id: grp.dataset.dragGroup, from: grp.dataset.from || null };
    e.dataTransfer.setData('application/x-qc', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copyMove';
    e.stopPropagation();
  });
  root.addEventListener('dragover', (e) => {
    const target = e.target.closest('.gcard');
    if (!target || !e.dataTransfer.types.includes('application/x-qc')) return;
    e.preventDefault();
    target.classList.add('drag-over');
  });
  root.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.gcard');
    if (target && !target.contains(e.relatedTarget)) target.classList.remove('drag-over');
  });
  root.addEventListener('drop', (e) => {
    const target = e.target.closest('.gcard');
    $$('.drag-over', root).forEach((x) => x.classList.remove('drag-over'));
    if (!target) return;
    e.preventDefault();
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('application/x-qc')); } catch { return; }
    const from = e.altKey ? null : payload.from;
    addMember(target.dataset.group, { kind: payload.kind, id: payload.id }, from);
  });
}
