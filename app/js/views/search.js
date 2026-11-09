// Search: find words or phrases across documents, read them in context,
// and code the results in one step.
import {
  S, idx, mutate, go, codeTree, codePath, locLabel, makeCode, findCodeByName, logEvent, attrValues,
  bindField,
} from '../store.js';
import {
  esc, plural, toast, uid, nowIso, promptDialog, keepScroll, MOD, $, $$,
} from '../util.js';
import { textSearch, frequentWords, rowRanges } from '../analysis.js';

const U = () => {
  const u = (S.ui.search ||= {});
  u.q ??= ''; u.mode ??= 'phrase'; u.whole ??= true; u.cased ??= false; u.uncoded ??= false;
  u.sets ??= []; u.attrs ??= {}; u.sel ??= new Set(); u.spread ??= 'sentence'; u.target ??= ''; u.limit ??= 150;
  return u;
};

const SPREAD = [['match', 'just the matching words'], ['sentence', 'the sentence'], ['paragraph', 'the whole paragraph or turn']];
const filters = (u) => ({ sets: u.sets, attrs: u.attrs });

export function render(el) {
  const u = U();
  let root = el.querySelector('.search-view');
  if (!root) {
    el.innerHTML = `<div class="search-view two-col">
      <aside class="pane filter-pane"><div class="pane-scroll" data-scroll-key="sfilter" data-left></div></aside>
      <section class="pane results-pane"><div class="pane-scroll" data-scroll-key="sresults" data-results></div></section>
    </div>`;
    root = el.querySelector('.search-view');
    bind(root);
  }
  keepScroll(root, () => {
    renderLeft(root);
    renderResults(root);
  });
}

export function focusSearch() {
  setTimeout(() => { const q = document.querySelector('.search-view [data-q]'); q?.focus(); q?.select(); }, 0);
}

function renderLeft(root) {
  const u = U();
  const p = S.project;
  const sets = [...new Set(p.documents.map((d) => d.set || ''))];
  const words = frequentWords({ filters: filters(u), ignore: p.settings.stopwords || '', limit: 40 });
  const left = $('[data-left]', root);
  left.innerHTML = `
    <form data-form autocomplete="off">
      <label class="field"><span>Search for</span>
        <input type="search" data-q value="${esc(u.q)}" placeholder="e.g. help desk, &quot;office hours&quot;, train*" aria-label="Search text"></label>
      <div class="radio-col">
        ${[['phrase', 'This exact phrase'], ['any', 'Any of these words'], ['all', 'All of these words, in the same paragraph']].map(([k, l]) => `<label class="check"><input type="radio" name="mode" value="${k}" ${u.mode === k ? 'checked' : ''}> ${l}</label>`).join('')}
      </div>
      <label class="check"><input type="checkbox" data-opt="whole" ${u.whole ? 'checked' : ''}> <span>Whole words only <span class="muted small">(end a word with * to match endings: support* finds supported and supportive)</span></span></label>
      <label class="check"><input type="checkbox" data-opt="cased" ${u.cased ? 'checked' : ''}> Match capitalization</label>
      <label class="check"><input type="checkbox" data-opt="uncoded" ${u.uncoded ? 'checked' : ''}> Only text that isn't coded yet</label>
      <button class="btn small primary" type="submit">Search</button>
    </form>
    ${sets.length > 1 || p.attributes.length ? '<h3>Documents</h3>' : ''}
    ${sets.length > 1 ? `<details open><summary>Set</summary>${sets.map((s) => `<label class="check"><input type="checkbox" data-sset value="${esc(s)}" ${u.sets.includes(s) ? 'checked' : ''}> ${esc(s || '(no set)')}</label>`).join('')}</details>` : ''}
    ${p.attributes.map((k) => {
      const vals = attrValues(k);
      if (vals.length > 40) return '';
      return `<details ${u.attrs[k]?.length ? 'open' : ''}><summary>${esc(k)}</summary>${vals.map((v) => `<label class="check"><input type="checkbox" data-sattr="${esc(k)}" value="${esc(v)}" ${(u.attrs[k] || []).includes(v) ? 'checked' : ''}> ${esc(v || '(blank)')}</label>`).join('')}</details>`;
    }).join('')}
    <h3>Frequent words</h3>
    <p class="hint small">The most common words in ${u.sets.length || Object.values(u.attrs).some((v) => v?.length) ? 'the chosen documents' : 'all documents'}, leaving out common English words and speaker labels. Click one to search for it.</p>
    <div class="word-list">${words.length ? words.map(([w, n]) => `<button class="word" data-word="${esc(w)}">${esc(w)} <small>${n}</small></button>`).join('') : '<span class="muted small">No documents yet.</span>'}</div>
    <label class="field"><span>Also leave out</span><input data-stop value="${esc(p.settings.stopwords || '')}" placeholder="e.g. interviewer, participant, tool"></label>`;
  bindField($('[data-stop]', left), p.settings, 'stopwords', { label: 'edit ignored words', onCommit: () => renderLeft(root) });
}

function currentResults() {
  const u = U();
  return textSearch({ q: u.q, mode: u.mode, whole: u.whole, cased: u.cased, uncoded: u.uncoded, filters: filters(u) });
}

function snippet(row) {
  const { para, matches } = row;
  const base = para.start;
  const text = para.text;
  const rel = matches.map(([a, b]) => [a - base, b - base]);
  let windows = [[0, text.length]];
  if (text.length > 700) {
    windows = [];
    for (const [a, b] of rel) {
      const w = [Math.max(0, a - 180), Math.min(text.length, b + 180)];
      const last = windows[windows.length - 1];
      if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]); else windows.push(w);
    }
  }
  return windows.map(([s, e]) => {
    let html = s > 0 ? '… ' : '';
    let pos = s;
    for (const [a, b] of rel) {
      if (b <= s || a >= e) continue;
      html += esc(text.slice(pos, Math.max(pos, a)));
      html += `<mark>${esc(text.slice(Math.max(a, pos), b))}</mark>`;
      pos = b;
    }
    html += esc(text.slice(pos, e)) + (e < text.length ? ' …' : '');
    return html;
  }).join('<br>');
}

function renderResults(root) {
  const u = U();
  const I = idx();
  const box = $('[data-results]', root);
  if (!u.q.trim()) {
    box.innerHTML = `<div class="empty big"><h2>Search your documents</h2>
      <p>Find every place a word or phrase appears, read each one in context, and code the ones that fit, all at once. Searching for what you haven't coded yet is a good way to check for missed passages.</p>
      <p class="muted small">Press <kbd>/</kbd> anywhere to jump here.</p></div>`;
    return;
  }
  const { rows, hits, docs } = currentResults();
  for (const k of [...u.sel]) if (!rows.some((r) => r.key === k)) u.sel.delete(k);
  const shown = rows.slice(0, u.limit);
  const codeOpts = codeTree().map(({ code, depth }) => `<option value="${code.id}" ${u.target === code.id ? 'selected' : ''}>${'  '.repeat(depth)}${esc(code.name)}</option>`).join('');
  let html = `<div class="results-head search-head">
      <div><h2>${esc(u.q)}</h2><p class="muted">${plural(hits, 'match', 'matches')} in ${plural(rows.length, 'paragraph')} across ${plural(docs, 'document')}${u.uncoded ? ', in text not yet coded' : ''}</p></div>
    </div>`;
  if (rows.length) {
    html += `<div class="code-bar">
      <label class="check"><input type="checkbox" data-all ${u.sel.size && u.sel.size === rows.length ? 'checked' : ''}> Select all</label>
      <span class="muted small" data-count>${u.sel.size} selected</span>
      <span class="small">Code</span>
      <select class="small" data-spread aria-label="How much text to code">${SPREAD.map(([k, l]) => `<option value="${k}" ${u.spread === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="small">as</span>
      <select class="small" data-target aria-label="Code to apply"><option value="">Choose a code…</option>${codeOpts}<option value="__new">+ New code…</option></select>
      <button class="btn small primary" data-act="apply" ${u.sel.size ? '' : 'disabled'}>Apply</button>
    </div>`;
  }
  let lastDoc = null;
  for (const r of shown) {
    const d = I.docs.get(r.doc);
    if (r.doc !== lastDoc) {
      const n = rows.filter((x) => x.doc === r.doc).length;
      html += `<h3 class="doc-group">${esc(d.title)} <span class="muted small">${plural(n, 'paragraph')}</span></h3>`;
      lastDoc = r.doc;
    }
    const here = (I.byDoc.get(r.doc) || []).filter((c) => c.start < r.para.end && c.end > r.para.start);
    const chips = [...new Set(here.map((c) => c.code))].map((id) => {
      const c = I.codes.get(id);
      return `<span class="chip" style="--c:${c.color}" title="${esc(codePath(id))}">${esc(c.name)}</span>`;
    }).join('');
    html += `<article class="hit-row ${u.sel.has(r.key) ? 'on' : ''}">
      <label class="hit-check"><input type="checkbox" data-row="${r.key}" ${u.sel.has(r.key) ? 'checked' : ''} aria-label="Select this paragraph"></label>
      <div class="hit-body">
        <div class="hit-text">${snippet(r)}</div>
        <div class="ex-meta">${esc(locLabel(d, r.para.start))} ${chips}<span class="ex-actions"><button class="link" data-open="${r.key}">Open in document</button></span></div>
      </div></article>`;
  }
  if (rows.length > shown.length) html += `<div class="btn-row center"><button class="btn small" data-act="more">Show ${Math.min(150, rows.length - shown.length)} more of ${rows.length - shown.length}</button></div>`;
  if (!rows.length) html += '<p class="empty">No matches. Try “Any of these words”, turn off “Whole words only”, or end a word with *.</p>';
  box.innerHTML = html;
}

function run(root) {
  const u = U();
  u.sel = new Set();
  u.limit = 150;
  renderResults(root);
}

async function apply(root) {
  const u = U();
  const rows = currentResults().rows.filter((r) => u.sel.has(r.key));
  if (!rows.length) return;
  let target = u.target;
  let newName = null;
  if (!target) { toast('Choose a code to apply'); return; }
  if (target === '__new') {
    newName = (await promptDialog('New code', 'Code name', u.q.replace(/\*/g, '').trim()))?.trim();
    if (!newName) return;
    const existing = findCodeByName(newName);
    if (existing) { target = existing.id; newName = null; }
  }
  const spreadLabel = SPREAD.find(([k]) => k === u.spread)[1];
  if (!newName) {
    const code = S.project.codes.find((c) => c.id === target);
    const fresh = rows.some((r) => rowRanges(r, u.spread).some(([a, b]) => !S.project.codings.some((c) => c.doc === r.doc && c.code === target && c.start === a && c.end === b)));
    if (!fresh) { toast(`Those passages are already coded “${code.name}”.`); return; }
  }
  let added = 0;
  let codeName = '';
  mutate('code search results', (p) => {
    const code = newName ? makeCode(p, newName) : p.codes.find((c) => c.id === target);
    codeName = code.name;
    for (const r of rows) {
      for (const [a, b] of rowRanges(r, u.spread)) {
        if (p.codings.some((c) => c.doc === r.doc && c.code === code.id && c.start === a && c.end === b)) continue;
        p.codings.push({ id: uid('cd'), doc: r.doc, start: a, end: b, code: code.id, origin: 'human', via: 'search', query: u.q, created: nowIso() });
        added++;
      }
    }
    logEvent(p, 'Coded from text search', `${added} excerpts as “${code.name}” from the search “${u.q}” (${spreadLabel})`);
    if (newName) u.target = code.id;
  }, { render: false });
  u.sel = new Set();
  renderResults(root);
  toast(`Coded ${plural(added, 'excerpt')} as “${codeName}”. ${MOD}Z to undo.`);
}

function bind(root) {
  const u = U();
  let timer;
  root.addEventListener('submit', (e) => { e.preventDefault(); u.q = $('[data-q]', root).value; run(root); });
  root.addEventListener('input', (e) => {
    if (!e.target.matches('[data-q]')) return;
    u.q = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => { if (u.q.trim().length !== 1) run(root); }, 300);
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'mode') { u.mode = t.value; run(root); }
    else if (t.dataset.opt) { u[t.dataset.opt] = t.checked; run(root); }
    else if (t.matches('[data-sset]')) { u.sets = $$('[data-sset]:checked', root).map((x) => x.value); renderLeft(root); run(root); }
    else if (t.matches('[data-sattr]')) {
      const k = t.dataset.sattr;
      u.attrs[k] = $$(`[data-sattr="${CSS.escape(k)}"]:checked`, root).map((x) => x.value);
      renderLeft(root);
      run(root);
    } else if (t.matches('[data-row]')) {
      if (t.checked) u.sel.add(t.dataset.row); else u.sel.delete(t.dataset.row);
      t.closest('.hit-row').classList.toggle('on', t.checked);
      $('[data-count]', root).textContent = `${u.sel.size} selected`;
      $('[data-act="apply"]', root).disabled = !u.sel.size;
    } else if (t.matches('[data-all]')) {
      u.sel = t.checked ? new Set(currentResults().rows.map((r) => r.key)) : new Set();
      renderResults(root);
    } else if (t.matches('[data-spread]')) u.spread = t.value;
    else if (t.matches('[data-target]')) u.target = t.value;
  });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-word],[data-open],[data-act]');
    if (!t) return;
    if (t.dataset.word) {
      Object.assign(u, { q: t.dataset.word, mode: 'phrase', whole: true });
      renderLeft(root);
      run(root);
    } else if (t.dataset.open) {
      const r = currentResults().rows.find((x) => x.key === t.dataset.open);
      if (!r) return;
      const [a, b] = r.matches[0];
      go('code', { code: { docId: r.doc, pending: { doc: r.doc, start: a, end: b }, clicked: [], active: null, scrollTo: 'pending' } });
    } else if (t.dataset.act === 'apply') apply(root);
    else if (t.dataset.act === 'more') { u.limit += 150; renderResults(root); }
  });
}
