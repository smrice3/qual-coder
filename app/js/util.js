// Small helpers shared by every view.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Keyboard labels: ⌘/⇧ on a Mac, Ctrl+/Shift+ elsewhere.
export const IS_MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';
export const SHIFT = IS_MAC ? '⇧' : 'Shift+';

// Join folder names with the separator the data folder already uses (\ on Windows).
export const joinPath = (base, ...parts) => [base, ...parts].join(String(base).includes('\\') ? '\\' : '/');

export const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const nowIso = () => new Date().toISOString();

export function fmtDate(iso, withTime = true) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

// "2026-11-08 18:56:40" in local time, for exports. Sorts correctly as text.
export function localStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const PALETTE = [
  '#d1495b', '#00798c', '#edae49', '#30638e', '#6a994e', '#8d6cab', '#e07a5f', '#2a9d8f',
  '#bc4b51', '#3d5a80', '#c08a1e', '#9c6644', '#5e548e', '#4f772d', '#e76f51', '#457b9d',
];

export function rgba(hex, a) {
  let h = String(hex || '#888888').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

export const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function slug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'export';
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

// ---------------------------------------------------------------- CSV

export function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCSV = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}`;

export function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const sep = guessSeparator(text);
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function guessSeparator(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const tabs = (first.match(/\t/g) || []).length;
  const commas = (first.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

// ---------------------------------------------------------------- files & clipboard

export function download(name, content, type = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

export async function copyRich(html, text) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
    return true;
  } catch {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }
}

export function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

// ---------------------------------------------------------------- toast & dialogs

let toastTimer;
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'error' ? 7000 : 2800);
}

export function openModal({ title, body, actions = [], wide = false, onClose }) {
  const root = document.getElementById('modalRoot');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">×</button></div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div></div>`;
  const bodyEl = wrap.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);
  const foot = wrap.querySelector('.modal-foot');
  let closed = false;
  const onKey = (e) => {
    if (e.key === 'Escape' && root.lastElementChild === wrap) { e.stopPropagation(); e.preventDefault(); close(); }
  };
  function close() {
    if (closed) return;
    closed = true;
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  }
  const handle = { el: wrap, body: bodyEl, close };
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    b.className = `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}${a.left ? ' left' : ''}`;
    b.addEventListener('click', async () => {
      const r = await a.onClick?.(handle);
      if (r !== false) close();
    });
    foot.append(b);
  }
  if (!actions.length) foot.remove();
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('[data-close]').addEventListener('click', close);
  root.append(wrap);
  const focusFirst = () => (wrap.querySelector('[autofocus]') || wrap.querySelector('.modal-body input, .modal-body textarea, .modal-body select'))?.focus();
  focusFirst();
  setTimeout(() => { if (!wrap.contains(document.activeElement)) focusFirst(); }, 0);
  return handle;
}

export function confirmDialog(message, { title = 'Are you sure?', ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    openModal({
      title,
      body: `<p>${esc(message)}</p>`,
      actions: [
        { label: 'Cancel', onClick: () => { done = true; resolve(false); } },
        { label: ok, primary: !danger, danger, onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function promptDialog(title, label, value = '', { ok = 'OK', multiline = false, placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const field = multiline
      ? `<textarea rows="4" autofocus placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input type="text" value="${esc(value)}" autofocus placeholder="${esc(placeholder)}">`;
    const m = openModal({
      title,
      body: `<label class="field"><span>${esc(label)}</span>${field}</label>`,
      actions: [
        { label: 'Cancel', onClick: () => { done = true; resolve(null); } },
        { label: ok, primary: true, onClick: (h) => { done = true; resolve(h.body.querySelector('input,textarea').value); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    m.body.querySelector('input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); m.el.querySelector('.btn.primary').click(); }
    });
  });
}

// Keep scroll positions of [data-scroll-key] elements across a re-render.
export function keepScroll(root, fn) {
  const saved = new Map($$('[data-scroll-key]', root).map((el) => [el.dataset.scrollKey, el.scrollTop]));
  fn();
  for (const el of $$('[data-scroll-key]', root)) {
    if (saved.has(el.dataset.scrollKey)) el.scrollTop = saved.get(el.dataset.scrollKey);
  }
}
