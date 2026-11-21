// Updates: Qual Coder checks GitHub for a newer version (the server does the
// fetching and caches it for 6 hours) and can install it in place. Projects
// live in their own folder, so an update never touches them.
import { S, api, flushSave } from './store.js';
import { esc, fmtDate, openModal } from './util.js';

const listeners = new Set();
let pending = null;

/** Call fn whenever the update information changes. */
export function onUpdateInfo(fn) { listeners.add(fn); }

export function checkForUpdate(force = false) {
  if (pending && !force) return pending;
  pending = api(force ? 'POST' : 'GET', force ? '/update/check' : '/update')
    .catch((e) => ({ current: S.appVersion, available: false, error: e.message }))
    .then((r) => {
      S.update = r;
      listeners.forEach((fn) => fn(r));
      return r;
    })
    .finally(() => { pending = null; });
  return pending;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notesHtml = (u) => (u.notes ? `<details class="update-notes" open><summary>What's new in ${esc(u.latest)}</summary><div class="notes">${esc(u.notes)}</div></details>` : '');
const pageLink = (url, label = 'Open the download page') => (url ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a></p>` : '');

export function openUpdateDialog() {
  const u = S.update || {};
  if (!u.available) {
    openModal({
      title: 'Updates',
      body: u.error ? `<p class="error">${esc(u.error)}</p>` : `<p>You have the latest version of Qual Coder (${esc(u.current || S.appVersion || '')}).</p>`,
      actions: [{ label: 'Close', primary: true }],
    });
    return;
  }
  if (u.git) {
    openModal({
      title: 'Update Qual Coder',
      body: `<p>Qual Coder ${esc(u.latest)} is available. This copy is a git checkout, so update it with <code>git pull</code>, then restart Qual Coder.</p>${notesHtml(u)}`,
      actions: [{ label: 'Close', primary: true }],
    });
    return;
  }
  if (u.full_download) {
    openModal({
      title: 'Update Qual Coder',
      body: `<p>Qual Coder ${esc(u.latest)} is available. This version needs a fresh download: download it, unzip it, and use it instead of this copy. Your projects are kept in a separate folder, so they carry over.</p>${pageLink(u.page)}${notesHtml(u)}`,
      actions: [{ label: 'Close', primary: true }],
    });
    return;
  }
  const after = u.restart === 'manual'
    ? 'Afterward, close the Qual Coder window and start Qual Coder again.'
    : 'Qual Coder restarts by itself when it\'s done.';
  openModal({
    title: 'Update Qual Coder',
    body: `<p>Qual Coder <strong>${esc(u.latest)}</strong> is available. You have ${esc(u.current)}.</p>
      <p>Updating takes a few seconds. ${after} Your projects aren't touched.</p>${notesHtml(u)}`,
    actions: [
      { label: 'Not now' },
      { label: 'Update now', primary: true, onClick: (h) => { install(h); return false; } },
    ],
  });
}

async function install(h) {
  const buttons = [...h.el.querySelectorAll('.modal-foot button, [data-close]')];
  buttons.forEach((b) => { b.disabled = true; });
  h.body.innerHTML = '<p>Downloading and installing the update…</p>';
  try { await flushSave(); } catch { /* reported below */ }
  if (S.dirty || S.saveError) {
    h.body.innerHTML = `<p class="error">Your latest changes haven't been saved yet${S.saveError ? ` (${esc(S.saveError)})` : ''}. Try again in a moment.</p>`;
    buttons.forEach((b) => { b.disabled = false; });
    return;
  }
  let r;
  try {
    r = await api('POST', '/update/install');
  } catch (e) {
    h.body.innerHTML = `<p class="error">${esc(e.message)}</p>${pageLink(e.data?.page)}`;
    buttons.forEach((b) => { b.disabled = false; });
    return;
  }
  if (r.restart === 'manual') {
    h.body.innerHTML = `<p class="ok">Updated to ${esc(r.version)}.</p><p>Close the Qual Coder window, then start Qual Coder again to use the new version.</p>`;
    h.el.querySelector('[data-close]').disabled = false;
    return;
  }
  h.body.innerHTML = `<p class="ok">Updated to ${esc(r.version)}.</p><p>Qual Coder is restarting. This page reloads by itself in a few seconds.</p>`;
  await sleep(1500);
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    try {
      const res = await fetch('/api/projects', { headers: { 'X-QC': '1' }, cache: 'no-store' });
      if (res.ok && (await res.json()).version === r.version) {
        location.reload();
        return;
      }
    } catch { /* still restarting */ }
    await sleep(1000);
  }
  h.body.innerHTML = `<p class="ok">Updated to ${esc(r.version)}.</p><p>Qual Coder hasn't come back at this address yet. Look at the Qual Coder window: it shows the address to open. If that window has closed, start Qual Coder again.</p>`;
  h.el.querySelector('[data-close]').disabled = false;
}

/** The Updates section in Settings. */
export function renderUpdateSettings(el, checking = false) {
  if (!el) return;
  const u = S.update;
  const status = checking ? 'Checking…'
    : !u ? ''
      : u.error ? `<span class="error">${esc(u.error)}</span>`
        : u.available ? `Version <strong>${esc(u.latest)}</strong> is available.`
          : `That's the latest version${u.checked ? ` (checked ${esc(fmtDate(u.checked))})` : ''}.`;
  el.innerHTML = `
    <p>You have Qual Coder ${esc(S.appVersion || '')}. ${status}</p>
    <div class="btn-row">
      ${u?.available ? '<button class="btn small primary" data-upd="open">Update…</button>' : ''}
      <button class="btn small" data-upd="check" ${checking ? 'disabled' : ''}>Check for updates</button>
    </div>
    <p class="muted small">New versions come from Qual Coder's page on GitHub. Checking sends nothing about your projects.</p>`;
  el.onclick = async (e) => {
    const b = e.target.closest('[data-upd]');
    if (!b) return;
    if (b.dataset.upd === 'open') { openUpdateDialog(); return; }
    renderUpdateSettings(el, true);
    await checkForUpdate(true);
    if (el.isConnected) renderUpdateSettings(el);
  };
}
