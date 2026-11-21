// App shell: top bar, project home, routing, global shortcuts.
import {
  S, setRenderer, loadProjects, openProject, setProject, api, undo, redo, flushSave,
  updateSaveStatus, go, closeProject,
} from './store.js';
import { esc, fmtDate, toast, readFileText, $, plural, MOD, SHIFT } from './util.js';
import * as code from './views/code.js';
import * as codebook from './views/codebook.js';
import * as memos from './views/memos.js';
import * as search from './views/search.js';
import * as analyze from './views/analyze.js';
import * as themes from './views/themes.js';
import * as exporter from './views/export.js';
import * as settings from './views/settings.js';
import { checkForUpdate, onUpdateInfo, openUpdateDialog } from './update.js';

const VIEWS = [
  ['code', 'Code', code],
  ['codebook', 'Codebook', codebook],
  ['memos', 'Memos', memos],
  ['search', 'Search', search],
  ['analyze', 'Analyze', analyze],
  ['themes', 'Themes', themes],
  ['export', 'Export', exporter],
  ['settings', 'Settings', settings],
];

function renderTop() {
  const p = S.project;
  $('#topbar').innerHTML = `
    <button class="brand" data-act="home" title="All projects">Qual Coder</button>
    ${S.update?.available ? `<button class="update-pill" data-act="update" title="Qual Coder ${esc(S.update.latest)} is available">Update available</button>` : ''}
    ${p ? `
      <span class="proj-name" title="${esc(p.name)}">${esc(p.name)}</span>
      ${p.settings.ai_enabled ? '<span class="ai-badge" title="AI suggestions are on for this project">AI on</span>' : ''}
      <nav class="tabs" role="tablist" aria-label="Views">
        ${VIEWS.map(([k, label]) => `<button role="tab" class="tab ${S.view === k ? 'on' : ''}" data-view="${k}" aria-selected="${S.view === k}">${label}</button>`).join('')}
      </nav>
      <span class="top-right">
        <span id="saveStatus" class="save-status"></span>
        <button class="icon-btn" data-act="undo" title="Undo (${MOD}Z)" aria-label="Undo">↶</button>
        <button class="icon-btn" data-act="redo" title="Redo (${SHIFT}${MOD}Z)" aria-label="Redo">↷</button>
      </span>` : ''}`;
  updateSaveStatus();
}

function renderHome(el) {
  el.innerHTML = `<div class="home"><div class="home-card">
    <h1>Qual Coder</h1>
    <p class="lede">A local workspace for qualitative coding: codebook, coding, memos, retrieval and second-cycle themes. Projects are saved as files on this computer.</p>
    <form class="new-proj" data-new>
      <input name="name" placeholder="New project name" required aria-label="New project name">
      <button class="btn primary" type="submit">Create project</button>
    </form>
    <h2>Projects</h2>
    <div class="proj-list">${S.projects.length ? S.projects.map((p) => `
      <button class="proj-item" data-open="${esc(p.id)}">
        <span class="pi-name">${esc(p.name)} ${p.ai_enabled ? '<span class="ai-badge">AI on</span>' : ''}</span>
        <span class="pi-meta">${plural(p.documents, 'document')} · ${plural(p.codes, 'code')} · ${plural(p.codings, 'coded excerpt')} · updated ${esc(fmtDate(p.updated))}</span>
      </button>`).join('') : '<p class="muted">No projects yet. Create one above.</p>'}</div>
    <div class="home-foot">
      <label class="btn">Import a project file (.json)<input type="file" accept=".json,application/json" hidden data-import></label>
      <span class="muted small">Projects folder: <code>${esc(S.dataDir)}</code></span>
      <span class="muted small">Qual Coder ${esc(S.appVersion || '')}</span>
    </div>
  </div></div>`;
}

function render() {
  renderTop();
  const el = $('#view');
  if (!S.project) {
    el.dataset.view = 'home';
    renderHome(el);
    return;
  }
  const entry = VIEWS.find(([k]) => k === S.view) || VIEWS[0];
  if (el.dataset.view !== entry[0]) {
    el.innerHTML = '';
    el.dataset.view = entry[0];
  }
  entry[2].render(el);
}

async function goHome() {
  await flushSave();
  closeProject();
  try { await loadProjects(); } catch { /* keep old list */ }
  render();
}

function bindShell() {
  $('#topbar').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-view],[data-act]');
    if (!t) return;
    if (t.dataset.view) go(t.dataset.view);
    else if (t.dataset.act === 'home') goHome();
    else if (t.dataset.act === 'undo') undo();
    else if (t.dataset.act === 'redo') redo();
    else if (t.dataset.act === 'update') openUpdateDialog();
  });

  $('#view').addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-new]');
    if (!f) return;
    e.preventDefault();
    const name = f.name.value.trim();
    if (!name) return;
    try {
      const r = await api('POST', '/projects', { name });
      S.view = 'code';
      setProject(r.project);
      try { localStorage.setItem('qc.lastProject', r.project.id); } catch { /* ignore */ }
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#view').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-open]');
    if (b && !S.project) {
      S.view = 'code';
      try { await openProject(b.dataset.open); } catch (err) { toast(err.message, 'error'); }
    }
  });

  $('#view').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-import]');
    if (!input || S.project) return;
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await readFileText(file));
      const project = data.project && data.project.documents ? data.project : data;
      const r = await api('POST', '/projects/import', { project, name: project.name });
      S.view = 'code';
      setProject(r.project);
      toast(`Imported “${r.project.name}”`);
    } catch (err) { toast(err.message || 'That file could not be imported', 'error'); }
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
    if (e.key === '/' && !mod && !e.altKey && !typing && S.project && !document.querySelector('.modal-backdrop')) {
      e.preventDefault();
      go('search');
      search.focusSearch();
      return;
    }
    if (!mod || !S.project) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !typing && !document.querySelector('.modal-backdrop')) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (k === 's') {
      e.preventDefault();
      flushSave().then(() => toast(S.saveError ? S.saveError : 'Saved'));
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty || S.saving) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (S.project && VIEWS.some(([k]) => k === v) && v !== S.view) go(v);
  });
}

async function init() {
  setRenderer(render);
  bindShell();
  const hv = location.hash.slice(1);
  if (VIEWS.some(([k]) => k === hv)) S.view = hv;
  try { await loadProjects(); } catch (e) { toast(`Can't reach the Qual Coder server: ${e.message}`, 'error'); }
  let last = null;
  try { last = localStorage.getItem('qc.lastProject'); } catch { /* ignore */ }
  if (last && S.projects.some((p) => p.id === last)) {
    try { await openProject(last); } catch { render(); }
  } else render();
  api('GET', '/ai/status').then((r) => { S.ai = r; }).catch(() => { S.ai = { available: false }; });
  onUpdateInfo(() => renderTop());
  checkForUpdate();
}

init();
