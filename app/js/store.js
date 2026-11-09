// Project state, saving, undo, and derived indexes.
import { uid, nowIso, PALETTE, toast } from './util.js';

export const S = {
  projects: [],
  dataDir: '',
  project: null,
  rev: 0,
  version: 0,
  dirty: false,
  saving: false,
  saveError: null,
  conflict: false,
  undo: [],
  redo: [],
  view: 'code',
  ui: {},
  ai: null, // { available, logged_in }
};

let renderFn = () => {};
export const setRenderer = (fn) => { renderFn = fn; };
export const rerender = () => renderFn();

export function go(view, patch = {}) {
  S.view = view;
  for (const [k, v] of Object.entries(patch)) S.ui[k] = Object.assign(S.ui[k] || {}, v);
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  rerender();
}

// ---------------------------------------------------------------- server

export async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-QC': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function loadProjects() {
  const r = await api('GET', '/projects');
  S.projects = r.projects;
  S.dataDir = r.data_dir;
  S.appVersion = r.version;
  return r.projects;
}

export function normalizeProject(p) {
  p.settings = Object.assign(
    { ai_enabled: false, ai_ack: null, ai_model: '', ai_instructions: '', stopwords: '' },
    p.settings || {},
  );
  // Version 1.0 sent AI requests to Claude. Projects turned on under that
  // version go back to off until someone confirms the local model.
  if (p.settings.ai_ack && p.settings.ai_ack.backend !== 'ollama') {
    p.settings.ai_enabled = false;
    p.settings.ai_ack = null;
    (p.log ||= []).push({ t: new Date().toISOString(), action: 'AI suggestions turned off', detail: 'Qual Coder now uses only a local model; turn AI on again to confirm.' });
  }
  if (['sonnet', 'opus', 'haiku'].includes(p.settings.ai_model)) p.settings.ai_model = '';
  for (const k of ['attributes', 'documents', 'codes', 'codings', 'memos', 'groups', 'suggestions', 'log']) {
    if (!Array.isArray(p[k])) p[k] = [];
  }
  for (const d of p.documents) { d.attrs ||= {}; d.set ||= ''; }
  for (const g of p.groups) g.members ||= [];
  for (const m of p.memos) m.links ||= [];
  return p;
}

export async function openProject(id) {
  if (S.project && S.dirty) await flushSave();
  const r = await api('GET', `/projects/${encodeURIComponent(id)}`);
  setProject(r.project);
  try { localStorage.setItem('qc.lastProject', id); } catch { /* private mode */ }
}

export function setProject(project) {
  S.project = normalizeProject(project);
  S.rev = project.rev;
  S.version++;
  S.undo = [];
  S.redo = [];
  S.dirty = false;
  S.conflict = false;
  S.saveError = null;
  S.ui = {};
  rerender();
}

export function closeProject() {
  S.project = null;
  S.ui = {};
  rerender();
}

// ---------------------------------------------------------------- changes & undo

export function mutate(label, fn, { render = true, undo = true } = {}) {
  if (!S.project) return undefined;
  if (undo) pushUndo(label);
  const r = fn(S.project);
  touch(render);
  return r;
}

export function pushUndo(label) {
  S.undo.push({ label, state: JSON.stringify(S.project) });
  if (S.undo.length > 100) S.undo.shift();
  S.redo = [];
}

export function touch(render = true) {
  S.version++;
  S.dirty = true;
  scheduleSave();
  if (render) rerender();
}

export function undo() {
  const u = S.undo.pop();
  if (!u) return toast('Nothing to undo');
  S.redo.push({ label: u.label, state: JSON.stringify(S.project) });
  S.project = normalizeProject(JSON.parse(u.state));
  touch(true);
  toast(`Undid: ${u.label}`);
}

export function redo() {
  const r = S.redo.pop();
  if (!r) return toast('Nothing to redo');
  S.undo.push({ label: r.label, state: JSON.stringify(S.project) });
  S.project = normalizeProject(JSON.parse(r.state));
  touch(true);
  toast(`Redid: ${r.label}`);
}

// Bind an input/textarea to obj[key]: live edits, one undo step per focus,
// no re-render while typing. onCommit runs on change (blur).
export function bindField(el, obj, key, { onInput, onCommit, label = 'edit' } = {}) {
  let pushed = false;
  let before = obj[key];
  el.addEventListener('focus', () => { pushed = false; before = obj[key]; });
  el.addEventListener('input', () => {
    if (!pushed) { pushUndo(label); pushed = true; }
    obj[key] = el.type === 'checkbox' ? el.checked : el.value;
    onInput?.(el.value);
    touch(false);
  });
  el.addEventListener('change', () => {
    if (onCommit && obj[key] !== before) onCommit(before, obj[key]);
    before = obj[key];
  });
}

// ---------------------------------------------------------------- saving

let saveTimer = null;
let savePromise = null;

export function scheduleSave(delay = 700) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow(); }, delay);
  updateSaveStatus();
}

export async function flushSave() {
  clearTimeout(saveTimer);
  if (savePromise) await savePromise;
  if (S.dirty) await saveNow();
}

async function saveNow() {
  if (!S.project || S.conflict) return;
  if (savePromise) {
    await savePromise;
    if (!S.dirty) return;
  }
  S.dirty = false;
  S.saving = true;
  updateSaveStatus();
  const pid = S.project.id;
  savePromise = api('PUT', `/projects/${pid}`, { project: S.project, base_rev: S.rev })
    .then((r) => {
      S.rev = r.rev;
      if (S.project?.id === pid) S.project.rev = r.rev;
      S.saveError = null;
    })
    .catch((e) => {
      S.dirty = true;
      S.saveError = e.message;
      if (e.status === 409) S.conflict = true;
      else setTimeout(() => scheduleSave(0), 5000);
      toast(e.message, 'error');
    })
    .finally(() => {
      S.saving = false;
      savePromise = null;
      updateSaveStatus();
    });
  await savePromise;
}

export function updateSaveStatus() {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  let text = '';
  let cls = '';
  if (!S.project) text = '';
  else if (S.conflict) { text = 'Not saved: reload the page'; cls = 'bad'; }
  else if (S.saveError) { text = 'Save failed, retrying…'; cls = 'bad'; }
  else if (S.saving) text = 'Saving…';
  else if (S.dirty) text = 'Unsaved changes';
  else text = 'All changes saved';
  el.textContent = text;
  el.className = `save-status ${cls}`;
}

// ---------------------------------------------------------------- indexes

let cache = { v: -1, p: null, I: null };

export function idx() {
  const p = S.project;
  if (cache.v === S.version && cache.p === p && cache.I) return cache.I;
  const codes = new Map(p.codes.map((c) => [c.id, c]));
  const docs = new Map(p.documents.map((d) => [d.id, d]));
  const groups = new Map(p.groups.map((g) => [g.id, g]));
  const children = new Map();
  for (const c of p.codes) {
    const k = c.parent && codes.has(c.parent) ? c.parent : '';
    if (!children.has(k)) children.set(k, []);
    children.get(k).push(c);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  for (const arr of children.values()) arr.sort(byName);
  const byDoc = new Map();
  const byCode = new Map();
  for (const c of p.codings) {
    if (!codes.has(c.code) || !docs.has(c.doc)) continue;
    if (!byDoc.has(c.doc)) byDoc.set(c.doc, []);
    byDoc.get(c.doc).push(c);
    if (!byCode.has(c.code)) byCode.set(c.code, []);
    byCode.get(c.code).push(c);
  }
  const docOrder = new Map(p.documents.map((d, i) => [d.id, i]));
  for (const arr of byDoc.values()) arr.sort((a, b) => a.start - b.start || b.end - a.end);
  for (const arr of byCode.values()) arr.sort((a, b) => docOrder.get(a.doc) - docOrder.get(b.doc) || a.start - b.start);
  const I = { codes, docs, groups, children, byDoc, byCode, docOrder };
  cache = { v: S.version, p, I };
  return I;
}

export function codeTree() {
  const I = idx();
  const out = [];
  const walk = (pid, depth) => {
    for (const c of I.children.get(pid) || []) {
      out.push({ code: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

export function descendants(id) {
  const I = idx();
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const c of I.children.get(out[i]) || []) out.push(c.id);
  return out;
}

export function codePath(id, sep = ' › ') {
  const I = idx();
  const names = [];
  const seen = new Set();
  let c = I.codes.get(id);
  while (c && !seen.has(c.id)) {
    seen.add(c.id);
    names.unshift(c.name);
    c = c.parent ? I.codes.get(c.parent) : null;
  }
  return names.join(sep);
}

export const codeColor = (id) => idx().codes.get(id)?.color || '#888888';

export function nextColor() {
  const used = new Map(PALETTE.map((c) => [c, 0]));
  for (const c of S.project.codes) if (used.has(c.color)) used.set(c.color, used.get(c.color) + 1);
  let best = PALETTE[0];
  for (const c of PALETTE) if (used.get(c) < used.get(best)) best = c;
  return best;
}

export function findCodeByName(name) {
  const n = String(name || '').trim().toLowerCase();
  return S.project.codes.find((c) => c.name.trim().toLowerCase() === n) || null;
}

// Call inside mutate(): creates a code and logs it.
export function makeCode(p, name, extra = {}) {
  const code = {
    id: uid('c'),
    name: String(name).trim(),
    color: extra.color || nextColor(),
    parent: extra.parent || null,
    definition: extra.definition || '',
    include: '',
    exclude: '',
    example: '',
    created: nowIso(),
    origin: extra.origin || 'human',
  };
  p.codes.push(code);
  logEvent(p, 'Code created', code.name + (code.origin === 'ai' ? ' (from an AI suggestion)' : ''));
  return code;
}

export function logEvent(p, action, detail = '') {
  p.log.push({ t: nowIso(), action, detail });
}

// ---------------------------------------------------------------- documents

const paraCache = new Map();

export function paragraphs(doc) {
  const key = `${doc.id}:${doc.text.length}`;
  let out = paraCache.get(key);
  if (out) return out;
  out = [];
  let pos = 0;
  let n = 0;
  for (const t of doc.text.split('\n')) {
    const blank = !t.trim();
    out.push({ n: blank ? null : ++n, start: pos, end: pos + t.length, text: t });
    pos += t.length + 1;
  }
  paraCache.set(key, out);
  return out;
}

export function paraIndexAt(doc, off) {
  const ps = paragraphs(doc);
  let lo = 0;
  let hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ps[mid].start <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function locLabel(doc, off) {
  const ps = paragraphs(doc);
  let i = paraIndexAt(doc, off);
  while (i < ps.length - 1 && ps[i].n == null) i++;
  const para = ps[i];
  if (!para) return '';
  const turn = para.text.match(/^\s*\[?(T\d{1,4})\b/);
  if (turn) return turn[1];
  const time = para.text.match(/^\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
  return `¶${para.n ?? ''}${time ? ` · ${time[1]}` : ''}`;
}

export const excerptText = (c) => idx().docs.get(c.doc)?.text.slice(c.start, c.end) ?? '';

// Codes in a category or theme, following nested groups, with child codes.
export function groupCodeIds(groupId, { withChildren = true } = {}) {
  const I = idx();
  const out = new Set();
  const seen = new Set();
  const walk = (gid) => {
    if (seen.has(gid)) return;
    seen.add(gid);
    const g = I.groups.get(gid);
    if (!g) return;
    for (const m of g.members) {
      if (m.kind === 'code' && I.codes.has(m.id)) {
        for (const id of withChildren ? descendants(m.id) : [m.id]) out.add(id);
      } else if (m.kind === 'group') walk(m.id);
    }
  };
  walk(groupId);
  return out;
}

export function groupsOfCode(codeId) {
  return S.project.groups.filter((g) => g.members.some((m) => m.kind === 'code' && m.id === codeId));
}

export function parentGroups(groupId) {
  return S.project.groups.filter((g) => g.members.some((m) => m.kind === 'group' && m.id === groupId));
}

export function docMatches(doc, filters) {
  if (!filters) return true;
  if (filters.docs?.length && !filters.docs.includes(doc.id)) return false;
  if (filters.sets?.length && !filters.sets.includes(doc.set || '')) return false;
  for (const [k, vals] of Object.entries(filters.attrs || {})) {
    if (vals?.length && !vals.includes(String(doc.attrs?.[k] ?? ''))) return false;
  }
  return true;
}

export function attrValues(key) {
  const vals = new Set();
  for (const d of S.project.documents) vals.add(String(d.attrs?.[key] ?? ''));
  return [...vals].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
