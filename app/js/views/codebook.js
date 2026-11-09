// Codebook: code tree, definitions, inclusion/exclusion criteria, examples,
// merge and delete, and importing an a priori codebook.
import {
  S, idx, mutate, go, bindField, pushUndo, touch, codeTree, descendants, codePath, makeCode,
  findCodeByName, logEvent, excerptText, locLabel,
} from '../store.js';
import {
  esc, truncate, oneLine, fmtDate, plural, toast, confirmDialog, promptDialog, openModal,
  parseCSV, readFileText, MOD, $,
} from '../util.js';
import { groupsForCode } from '../analysis.js';
import { newMemo, editMemoModal, memosLinkedTo } from './memos.js';

const U = () => (S.ui.codebook ||= { sel: null, filter: '' });

export function render(el) {
  const u = U();
  let root = el.querySelector('.codebook-view');
  if (!root) {
    el.innerHTML = `<div class="codebook-view two-col">
      <aside class="pane list-pane" aria-label="Code tree">
        <div class="pane-head">
          <div class="pane-title"><h2>Codebook</h2>
            <span class="btn-row tight"><button class="btn small" data-act="import" title="Add codes from a list or CSV (a priori codebook)">Import…</button><button class="btn small primary" data-act="new">+ New code</button></span></div>
          <input type="search" class="filter" data-filter placeholder="Filter codes and definitions" aria-label="Filter codes">
          <p class="muted small" data-summary></p>
        </div>
        <div class="pane-scroll" data-scroll-key="cbtree" data-tree></div>
      </aside>
      <section class="pane editor-pane"><div class="pane-scroll" data-scroll-key="cbedit" data-editor></div></section>
    </div>`;
    root = el.querySelector('.codebook-view');
    $('[data-filter]', root).value = u.filter;
    root.addEventListener('input', (e) => { if (e.target.matches('[data-filter]')) { u.filter = e.target.value; renderTree(root); } });
    root.addEventListener('click', (e) => onClick(e, root));
  }
  if (u.sel && !idx().codes.has(u.sel)) u.sel = null;
  if (!u.sel && S.project.codes.length) u.sel = codeTree()[0].code.id;
  renderTree(root);
  renderEditor(root);
}

function renderTree(root) {
  const u = U();
  const I = idx();
  const q = u.filter.trim().toLowerCase();
  const rows = codeTree().filter(({ code }) => !q || `${code.name} ${code.definition} ${code.include} ${code.exclude}`.toLowerCase().includes(q));
  $('[data-summary]', root).textContent = `${plural(S.project.codes.length, 'code')} · ${plural(S.project.codings.length, 'coded excerpt')}`;
  $('[data-tree]', root).innerHTML = rows.length ? rows.map(({ code, depth }) => {
    const cs = I.byCode.get(code.id) || [];
    const docs = new Set(cs.map((c) => c.doc)).size;
    return `<button class="tree-item ${code.id === u.sel ? 'on' : ''}" data-sel="${code.id}" style="--depth:${q ? 0 : depth}">
      <span class="dot" style="background:${code.color}"></span>
      <span class="nm">${esc(q ? codePath(code.id) : code.name)}${code.definition ? '' : ' <span class="warn-dot" title="No definition yet">•</span>'}</span>
      <span class="ct" title="${plural(cs.length, 'excerpt')} in ${plural(docs, 'document')}">${cs.length}<small> / ${docs}</small></span></button>`;
  }).join('') : `<p class="empty small">${S.project.codes.length ? 'No codes match.' : 'No codes yet. Create codes here, import a list, or create them while coding.'}</p>`;
}

function renderEditor(root) {
  const u = U();
  const I = idx();
  const c = I.codes.get(u.sel);
  const box = $('[data-editor]', root);
  if (!c) {
    box.innerHTML = `<div class="empty big"><h2>Build your codebook</h2>
      <p>Create codes as you go (inductive), or import a list of codes from a framework before you start (deductive). Give each code a definition, criteria for when to use it and when not to, and a typical example.</p>
      <div class="btn-row center"><button class="btn primary" data-act="new">+ New code</button><button class="btn" data-act="import">Import a codebook…</button></div></div>`;
    return;
  }
  const codings = I.byCode.get(c.id) || [];
  const docs = new Set(codings.map((x) => x.doc));
  const kids = descendants(c.id).slice(1);
  const g = groupsForCode(c.id);
  const memos = memosLinkedTo('code', c.id);
  const blocked = new Set(descendants(c.id));
  const parentOpts = codeTree().filter(({ code }) => !blocked.has(code.id))
    .map(({ code, depth }) => `<option value="${code.id}" ${code.id === c.parent ? 'selected' : ''}>${'  '.repeat(depth)}${esc(code.name)}</option>`).join('');
  const groupsLine = [...g.categories, ...g.themes].map((x) => `<span class="chip plain">${x.kind === 'theme' ? 'Theme' : 'Category'}: ${esc(x.name)}</span>`).join(' ');
  box.innerHTML = `<div class="editor">
    <div class="editor-head">
      <input type="color" data-color value="${esc(c.color)}" aria-label="Code color" title="Code color">
      <input class="title-input" data-f="name" value="${esc(c.name)}" aria-label="Code name">
    </div>
    <p class="muted small">${plural(codings.length, 'excerpt')} in ${plural(docs.size, 'document')}${kids.length ? ` · ${plural(kids.length, 'child code')}` : ''} · created ${esc(fmtDate(c.created))}${c.origin === 'ai' ? ' from an AI suggestion' : ''}</p>
    ${groupsLine ? `<p>${groupsLine}</p>` : ''}
    <label class="field"><span>Parent code</span><select data-parent><option value="">(top level)</option>${parentOpts}</select></label>
    <label class="field"><span>Definition</span><textarea data-f="definition" rows="3" placeholder="What this code means, in a sentence or two">${esc(c.definition)}</textarea></label>
    <div class="grid2">
      <label class="field"><span>When to use</span><textarea data-f="include" rows="3" placeholder="Inclusion criteria">${esc(c.include)}</textarea></label>
      <label class="field"><span>When not to use</span><textarea data-f="exclude" rows="3" placeholder="Exclusion criteria, and which code to use instead">${esc(c.exclude)}</textarea></label>
    </div>
    <label class="field"><span>Typical example</span><textarea data-f="example" rows="3" placeholder="A short quote that shows the code well">${esc(c.example)}</textarea></label>
    ${codings.length ? `<select class="small" data-example aria-label="Fill the example from an excerpt"><option value="">Fill the example from an excerpt…</option>${codings.slice(0, 60).map((x) => `<option value="${x.id}">${esc(truncate(oneLine(excerptText(x)), 100))}</option>`).join('')}</select>` : ''}
    <div class="btn-row spaced">
      <button class="btn small" data-act="excerpts" ${codings.length ? '' : 'disabled'}>View excerpts</button>
      <button class="btn small" data-act="child">+ Child code</button>
      <button class="btn small" data-act="memo">+ Code memo</button>
      <button class="btn small" data-act="merge">Merge into…</button>
      <button class="btn small danger-ghost" data-act="delete">Delete</button>
    </div>
    <h3>Memos about this code</h3>
    ${memos.length ? memos.map((m) => `<button class="memo-link" data-memo="${m.id}"><b>${esc(m.title)}</b><span class="muted small">${esc(fmtDate(m.updated, false))}</span></button>`).join('') : '<p class="muted small">None yet. Code memos are a good place to track how the meaning of a code changes.</p>'}
    <h3>Excerpts <span class="muted small">${codings.length > 8 ? `first 8 of ${codings.length}` : ''}</span></h3>
    ${codings.slice(0, 8).map((x) => {
      const d = I.docs.get(x.doc);
      return `<article class="excerpt small"><blockquote>${esc(truncate(excerptText(x), 400))}</blockquote>
        <div class="ex-meta"><b>${esc(d.title)}</b> · ${esc(locLabel(d, x.start))}${x.origin === 'ai' ? ' <span class="tag ai">AI</span>' : ''}
        <button class="link" data-goto="${x.id}">Open in document</button></div></article>`;
    }).join('') || '<p class="muted small">Not applied to any text yet.</p>'}
  </div>`;

  const name = $('[data-f="name"]', box);
  bindField(name, c, 'name', {
    label: 'rename code',
    onInput: () => {
      const item = $(`[data-sel="${c.id}"] .nm`, root);
      if (item) item.textContent = c.name;
    },
    onCommit: (before, after) => {
      if (!after.trim()) { c.name = before; name.value = before; toast('A code needs a name'); touch(false); return; }
      const dup = S.project.codes.find((x) => x !== c && x.name.trim().toLowerCase() === after.trim().toLowerCase());
      if (dup) toast('Another code already has this name. Consider merging them.', 'error');
      logEvent(S.project, 'Code renamed', `${before} → ${after}`);
      touch(false);
      renderTree(root);
    },
  });
  for (const f of ['definition', 'include', 'exclude', 'example']) {
    bindField($(`[data-f="${f}"]`, box), c, f, { label: `edit ${f}`, onCommit: () => { if (f === 'definition') renderTree(root); } });
  }
  $('[data-color]', box).addEventListener('change', (e) => {
    mutate('change code color', () => { c.color = e.target.value; });
  });
  $('[data-parent]', box).addEventListener('change', (e) => {
    const to = e.target.value || null;
    mutate('move code', (p) => {
      c.parent = to;
      logEvent(p, 'Code moved', `${c.name} → ${to ? codePath(to) : 'top level'}`);
    });
  });
  $('[data-example]', box)?.addEventListener('change', (e) => {
    const x = S.project.codings.find((k) => k.id === e.target.value);
    if (!x) return;
    const d = I.docs.get(x.doc);
    pushUndo('set example');
    c.example = `“${oneLine(excerptText(x))}” (${d.title}, ${locLabel(d, x.start)})`;
    $('[data-f="example"]', box).value = c.example;
    e.target.value = '';
    touch(false);
  });
}

async function onClick(e, root) {
  const u = U();
  const t = e.target.closest('[data-sel],[data-act],[data-memo],[data-goto]');
  if (!t) return;
  if (t.dataset.sel) { u.sel = t.dataset.sel; renderTree(root); renderEditor(root); return; }
  if (t.dataset.memo) { editMemoModal(t.dataset.memo); return; }
  if (t.dataset.goto) {
    const c = S.project.codings.find((x) => x.id === t.dataset.goto);
    if (c) go('code', { code: { docId: c.doc, active: c.id, clicked: [c.id], scrollTo: c.id, pending: null } });
    return;
  }
  const code = idx().codes.get(u.sel);
  switch (t.dataset.act) {
    case 'new': {
      const name = (await promptDialog('New code', 'Code name', ''))?.trim();
      if (!name) return;
      if (findCodeByName(name)) { toast('A code with that name already exists'); return; }
      u.sel = mutate('create code', (p) => makeCode(p, name).id);
      setTimeout(() => $('[data-f="definition"]', root)?.focus(), 0);
      break;
    }
    case 'child': {
      const name = (await promptDialog(`New child code under “${code.name}”`, 'Code name', ''))?.trim();
      if (!name) return;
      if (findCodeByName(name)) { toast('A code with that name already exists'); return; }
      u.sel = mutate('create code', (p) => makeCode(p, name, { parent: code.id }).id);
      break;
    }
    case 'excerpts':
      go('analyze', { analyze: { tab: 'retrieve', codes: [code.id], group: '', docs: [], sets: [], attrs: {}, q: '' } });
      break;
    case 'memo':
      editMemoModal(newMemo({ title: `Code memo: ${code.name}`, type: 'code', links: [{ kind: 'code', id: code.id }] }));
      break;
    case 'merge':
      mergeDialog(code);
      break;
    case 'delete': {
      const n = (idx().byCode.get(code.id) || []).length;
      const ok = await confirmDialog(`Delete “${code.name}” and remove it from ${plural(n, 'excerpt')}? Child codes move up a level. You can undo this.`, { title: 'Delete code', ok: 'Delete', danger: true });
      if (ok) deleteCode(code.id);
      break;
    }
    case 'import':
      importDialog();
      break;
    default: break;
  }
}

function mergeDialog(src) {
  const blocked = new Set(descendants(src.id));
  const opts = codeTree().filter(({ code }) => !blocked.has(code.id))
    .map(({ code, depth }) => `<option value="${code.id}">${'  '.repeat(depth)}${esc(code.name)}</option>`).join('');
  if (!opts) { toast('There is no other code to merge into'); return; }
  const n = (idx().byCode.get(src.id) || []).length;
  openModal({
    title: `Merge “${src.name}”`,
    body: `<p>Move its ${plural(n, 'excerpt')}, child codes, memo links and category memberships to another code, then remove “${esc(src.name)}”. The change log keeps its old definition.</p>
      <label class="field"><span>Merge into</span><select data-target>${opts}</select></label>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Merge', primary: true, onClick: (h) => { mergeCodes(src.id, $('[data-target]', h.body).value); } },
    ],
  });
}

export function mergeCodes(srcId, dstId) {
  if (!srcId || !dstId || srcId === dstId) return;
  mutate('merge codes', (p) => {
    const src = p.codes.find((c) => c.id === srcId);
    const dst = p.codes.find((c) => c.id === dstId);
    let moved = 0;
    const drop = new Set();
    for (const c of p.codings) {
      if (c.code !== srcId) continue;
      if (p.codings.some((o) => o.code === dstId && o.doc === c.doc && o.start === c.start && o.end === c.end)) drop.add(c.id);
      else { c.code = dstId; moved++; }
    }
    p.codings = p.codings.filter((c) => !drop.has(c.id));
    for (const c of p.codes) if (c.parent === srcId) c.parent = dstId;
    for (const g of p.groups) {
      const has = g.members.some((m) => m.kind === 'code' && m.id === dstId);
      g.members = g.members.flatMap((m) => {
        if (m.kind !== 'code' || m.id !== srcId) return [m];
        return has ? [] : [{ kind: 'code', id: dstId }];
      });
    }
    for (const m of p.memos) {
      for (const l of m.links) if (l.kind === 'code' && l.id === srcId) l.id = dstId;
      m.links = m.links.filter((l, i, arr) => arr.findIndex((x) => x.kind === l.kind && x.id === l.id) === i);
    }
    for (const s of p.suggestions) if (s.code_id === srcId) s.code_id = dstId;
    if (!dst.definition && src.definition) dst.definition = src.definition;
    p.codes = p.codes.filter((c) => c.id !== srcId);
    logEvent(p, 'Codes merged', `“${src.name}” into “${dst.name}” (${moved} excerpts moved)${src.definition ? `. Its definition was: ${src.definition}` : ''}`);
  });
  U().sel = dstId;
  toast(`Codes merged. ${MOD}Z to undo.`);
}

export function deleteCode(id) {
  mutate('delete code', (p) => {
    const c = p.codes.find((x) => x.id === id);
    const n = p.codings.filter((x) => x.code === id).length;
    p.codings = p.codings.filter((x) => x.code !== id);
    for (const k of p.codes) if (k.parent === id) k.parent = c.parent || null;
    for (const g of p.groups) g.members = g.members.filter((m) => !(m.kind === 'code' && m.id === id));
    for (const m of p.memos) m.links = m.links.filter((l) => !(l.kind === 'code' && l.id === id));
    p.codes = p.codes.filter((x) => x.id !== id);
    logEvent(p, 'Code deleted', `${c.name} (${n} excerpts)${c.definition ? `. Definition was: ${c.definition}` : ''}`);
  });
  toast(`Code deleted. ${MOD}Z to undo.`);
}

// ---------------------------------------------------------------- import a codebook

const HEAD = {
  name: ['code', 'name', 'code name'],
  parent: ['parent', 'parent code'],
  definition: ['definition', 'description'],
  include: ['when to use', 'inclusion', 'include', 'inclusion criteria'],
  exclude: ['when not to use', 'exclusion', 'exclude', 'exclusion criteria'],
  example: ['typical example', 'example'],
  color: ['color', 'colour'],
};

function parseList(text) {
  const out = [];
  const stack = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^[\t ]*/)[0].replace(/\t/g, '  ').length;
    const line = raw.trim().replace(/^[-*•]\s+/, '');
    const m = line.match(/^(.+?)\s*[:—–]\s+(.+)$/);
    const name = (m ? m[1] : line).trim();
    const definition = m ? m[2].trim() : '';
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    out.push({ name, definition, parentName: stack.length ? stack[stack.length - 1].name : '' });
    stack.push({ indent, name });
  }
  return out;
}

function parseCodebookCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (k) => header.findIndex((h) => HEAD[k].includes(h));
  const idxs = Object.fromEntries(Object.keys(HEAD).map((k) => [k, col(k)]));
  if (idxs.name < 0) throw new Error('The CSV needs a column named “Code” or “Name”.');
  return rows.slice(1).map((r) => {
    const get = (k) => (idxs[k] >= 0 ? (r[idxs[k]] || '').trim() : '');
    return { name: get('name'), parentName: get('parent'), definition: get('definition'), include: get('include'), exclude: get('exclude'), example: get('example'), color: get('color') };
  }).filter((x) => x.name);
}

function importDialog() {
  const body = document.createElement('div');
  body.innerHTML = `<p class="hint">Paste a list with one code per line. Indent child codes with a tab or two spaces, and add a definition after a colon if you like. Or choose a CSV with columns such as Code, Parent, Definition, When to use, When not to use, Typical example (a codebook CSV exported from Qual Coder works).</p>
    <textarea rows="10" data-list placeholder="Belonging: feeling part of a group&#10;  Peer belonging&#10;  Faculty belonging&#10;Barriers&#10;  Time&#10;  Cost"></textarea>
    <p><input type="file" accept=".csv,.tsv,.txt" data-file aria-label="Choose a codebook CSV"></p>
    <p class="muted small">Codes whose names already exist are skipped.</p>`;
  let fromCsv = null;
  body.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-file]')) return;
    const f = e.target.files[0];
    if (!f) return;
    try {
      fromCsv = parseCodebookCSV(await readFileText(f));
      $('[data-list]', body).value = '';
      $('[data-list]', body).placeholder = `${plural(fromCsv.length, 'code')} read from ${f.name}`;
    } catch (err) { toast(err.message, 'error'); }
  });
  openModal({
    title: 'Import codes',
    body,
    wide: true,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Import',
        primary: true,
        onClick: () => {
          const text = $('[data-list]', body).value;
          const items = text.trim() ? parseList(text) : fromCsv || [];
          if (!items.length) { toast('Nothing to import'); return false; }
          let added = 0;
          mutate('import codes', (p) => {
            const created = [];
            for (const it of items) {
              if (p.codes.some((c) => c.name.trim().toLowerCase() === it.name.toLowerCase())) continue;
              const c = makeCode(p, it.name, { definition: it.definition, color: /^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : undefined });
              Object.assign(c, { include: it.include || '', exclude: it.exclude || '', example: it.example || '' });
              created.push([c, it.parentName]);
              added++;
            }
            for (const [c, parentName] of created) {
              if (!parentName) continue;
              const last = parentName.split('>').pop().trim().toLowerCase();
              const parent = p.codes.find((x) => x.id !== c.id && x.name.trim().toLowerCase() === last);
              if (parent) c.parent = parent.id;
            }
            // One log entry for the whole import instead of one per code.
            if (added) p.log.splice(p.log.length - added, added);
            logEvent(p, 'Codes imported', `${added} codes: ${created.map(([c]) => c.name).join('; ')}`);
          });
          toast(`Imported ${plural(added, 'code')}`);
          return true;
        },
      },
    ],
  });
}
