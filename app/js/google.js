// Google Drive: sign in with Google, pick documents, download them to this computer.
//
// Uses the drive.file scope, so Qual Coder can only open the files you pick
// in Google's own picker. The access token lives in this page's memory only;
// it is never sent to the Qual Coder server or saved anywhere.
import { api } from './store.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GDOC = 'application/vnd.google-apps.document';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIMES = [GDOC, DOCX, 'text/plain', 'text/markdown', 'application/rtf', 'text/rtf', 'application/pdf', 'text/vtt', 'application/x-subrip'].join(',');

let cfg = null;
let token = null;
let tokenExp = 0;
let loading = null;

export async function googleConfig(force = false) {
  if (!cfg || force) cfg = (await api('GET', '/config')).google || {};
  return cfg;
}

export const googleReady = (c = cfg) => !!(c && c.client_id && c.api_key && c.project_number);

export const currentOrigin = () => location.origin;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => { s.remove(); reject(new Error('Couldn\'t reach Google. Check the internet connection and try again.')); };
    document.head.append(s);
  });
}

// Load Google's sign-in and picker code ahead of time, so the sign-in popup
// can open straight from a click (browsers block popups opened later).
export function preloadGoogle() {
  loading ||= Promise.all([
    loadScript('https://accounts.google.com/gsi/client'),
    loadScript('https://apis.google.com/js/api.js'),
  ]).then(() => new Promise((resolve, reject) => {
    window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Google\'s file picker didn\'t load.')) });
  })).catch((e) => { loading = null; throw e; });
  return loading;
}

export const googleLoaded = () => !!(window.google?.accounts?.oauth2 && window.google?.picker);

function friendlyError(code, desc) {
  const c = String(code || '');
  if (c === 'popup_closed' || c === 'popup_failed_to_open') return 'The Google sign-in window was closed or blocked. Allow pop-ups for this page and try again.';
  if (c === 'access_denied') return 'Google sign-in was cancelled, or access wasn\'t allowed.';
  if (c === 'admin_policy_enforced' || /admin|blocked/i.test(desc || '')) {
    return 'Your organization\'s Google settings blocked this app. Use a Drive download (.zip) instead, or ask your Google administrator to allow it.';
  }
  if (c === 'idpiframe_initialization_failed' || /origin/i.test(desc || '')) {
    return `Google didn't accept this page's address. In the Google Cloud console, add ${currentOrigin()} as an Authorized JavaScript origin for the OAuth client.`;
  }
  return desc || c || 'Google sign-in failed.';
}

// Must be called directly from a click handler, after preloadGoogle() has finished.
export function signIn() {
  return new Promise((resolve, reject) => {
    if (token && Date.now() < tokenExp - 60_000) { resolve(token); return; }
    if (!googleLoaded()) { reject(new Error('Google is still loading. Try again in a moment.')); return; }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: cfg.client_id,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) { reject(new Error(friendlyError(r.error, r.error_description))); return; }
        token = r.access_token;
        tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        resolve(token);
      },
      error_callback: (e) => reject(new Error(friendlyError(e?.type, e?.message))),
    });
    client.requestAccessToken({ prompt: token ? '' : 'select_account' });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => {});
  token = null;
  tokenExp = 0;
}

// Opens Google's picker. Resolves with the picked files ([] if cancelled).
export function pick() {
  const P = window.google.picker;
  return new Promise((resolve) => {
    const mine = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false)
      .setMimeTypes(MIMES).setMode(P.DocsViewMode.LIST);
    const shared = new P.DocsView(P.ViewId.DOCS).setEnableDrives(true).setIncludeFolders(true)
      .setSelectFolderEnabled(false).setMimeTypes(MIMES).setMode(P.DocsViewMode.LIST);
    const picker = new P.PickerBuilder()
      .addView(mine)
      .addView(shared)
      .enableFeature(P.Feature.MULTISELECT_ENABLED)
      .enableFeature(P.Feature.SUPPORT_DRIVES)
      .setOAuthToken(token)
      .setDeveloperKey(cfg.api_key)
      .setAppId(cfg.project_number)
      .setOrigin(location.origin)
      .setTitle('Choose documents for Qual Coder')
      .setCallback((data) => {
        const action = data[P.Response.ACTION];
        if (action === P.Action.PICKED) {
          resolve(data[P.Response.DOCUMENTS].map((d) => ({
            id: d[P.Document.ID], name: d[P.Document.NAME], mimeType: d[P.Document.MIME_TYPE], url: d[P.Document.URL],
          })));
        } else if (action === P.Action.CANCEL) resolve([]);
      })
      .build();
    picker.setVisible(true);
  });
}

// Downloads one picked file. Google Docs come down as Word files, so they are
// read exactly like a Drive .zip download or an uploaded .docx.
export async function download(f) {
  const isDoc = f.mimeType === GDOC;
  const id = encodeURIComponent(f.id);
  const url = isDoc
    ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(DOCX)}`
    : `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* not JSON */ }
    if (res.status === 401) { token = null; msg = 'Google sign-in expired. Choose the documents again.'; }
    throw new Error(`Couldn't download “${f.name}”: ${msg}`);
  }
  const blob = await res.blob();
  const filename = isDoc ? `${f.name}.docx` : f.name;
  return { filename, blob };
}
