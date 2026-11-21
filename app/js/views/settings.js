// Settings: project name, document attributes, AI assistance, snapshots, change log.
import {
  S, mutate, api, bindField, flushSave, setProject, logEvent, rerender, touch, closeProject, loadProjects,
} from '../store.js';
import {
  esc, fmtDate, plural, toast, confirmDialog, promptDialog, openModal, joinPath, MOD, SHIFT, $, $$,
} from '../util.js';
import * as gdrive from '../google.js';
import { renderUpdateSettings } from '../update.js';

export function render(el) {
  const p = S.project;
  const st = p.settings;
  const ai = S.ai;
  const sugg = p.suggestions;
  const count = (s) => sugg.filter((x) => x.status === s || (s === 'accepted' && x.status === 'accepted-recoded')).length;
  const models = ai?.models || [];
  const aiStatus = !ai ? 'Checking for Ollama on this computer…'
    : ai.reason ? esc(ai.reason)
      : !ai.running ? 'Ollama isn\'t running on this computer. Install it from <a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com</a>, open it, then click Check again.'
        : !models.length ? `Ollama ${esc(ai.version || '')} is running but has no models yet. In a terminal, run <code>ollama pull llama3.1:8b</code>, then click Check again.`
          : `Ollama ${esc(ai.version || '')} is running on this computer with ${plural(models.length, 'model')}.`;
  const modelOpts = [
    ...(st.ai_model ? [] : ['<option value="">Choose a model…</option>']),
    ...models.map((m) => `<option value="${esc(m)}" ${st.ai_model === m ? 'selected' : ''}>${esc(m)}</option>`),
    ...(st.ai_model && !models.includes(st.ai_model) ? [`<option value="${esc(st.ai_model)}" selected>${esc(st.ai_model)} (not installed)</option>`] : []),
  ].join('');

  el.innerHTML = `<div class="settings-view"><div class="pane-scroll" data-scroll-key="settings"><div class="settings-inner">
    <h1>Settings</h1>

    <section class="set-sec">
      <h2>Project</h2>
      <label class="field"><span>Name</span><input data-name value="${esc(p.name)}"></label>
      <p class="muted small">Created ${esc(fmtDate(p.created))}. Saved as <code>${esc(joinPath(S.dataDir, p.id, 'project.json'))}</code>.</p>
    </section>

    <section class="set-sec">
      <h2>Document attributes</h2>
      <p class="muted small">Attributes describe documents (participant, role, college, date…) so you can filter and compare in Analyze.</p>
      <div class="attr-list">${p.attributes.map((k, i) => `<div class="attr-row"><input value="${esc(k)}" data-attr-name="${i}" aria-label="Attribute name"><span class="muted small">${plural(p.documents.filter((d) => d.attrs[k]).length, 'document')} filled in</span><button class="btn small danger-ghost" data-attr-del="${i}">Remove</button></div>`).join('') || '<p class="muted small">None yet.</p>'}</div>
      <button class="btn small" data-act="attr-add">+ Attribute</button>
    </section>

    <section class="set-sec ${st.ai_enabled ? 'ai-on' : ''}">
      <h2>AI suggestions ${st.ai_enabled ? '<span class="ai-badge">On</span>' : '<span class="tag">Off</span>'}</h2>
      <p>${st.ai_enabled
        ? `On since ${esc(fmtDate(st.ai_ack?.t))}. In the Code view, the panel on the right can ask the local model to suggest codes for a selection or a whole document. You accept or reject each one.`
        : 'Off. This project is coded by you alone.'} AI suggestions only ever use a model running on this computer through <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a>; nothing is sent over the internet.</p>
      <p class="small">${aiStatus} <button class="link" data-act="ai-check">Check again</button></p>
      ${st.ai_enabled ? `
        <div class="grid2">
          <label class="field"><span>Model</span><select data-model>${modelOpts}</select>
            <span class="muted small">Bigger models suggest better codes but run slower. <code>llama3.1:8b</code> suits most laptops with 16 GB of memory.</span></label>
          <div class="field"><span>Decisions so far</span><p class="small">${count('pending')} waiting · ${count('accepted')} accepted · ${count('rejected')} rejected</p></div>
        </div>
        <label class="field"><span>Research focus and coding instructions for the model</span>
          <textarea data-instructions rows="4" placeholder="e.g. Research question: How do first-year faculty decide which course tools to adopt? Code for reasons, barriers and sources of support. Prefer short descriptive codes.">${esc(st.ai_instructions)}</textarea></label>
        <div class="btn-row"><button class="btn small danger-ghost" data-act="ai-off">Turn AI suggestions off</button></div>
        <h3>AI requests</h3><div data-ai-log class="small muted">Loading…</div>`
        : '<button class="btn small" data-act="ai-on">Turn on AI suggestions</button>'}
    </section>

    <section class="set-sec">
      <h2>Google Drive <span class="tag">all projects on this computer</span></h2>
      <div data-google-settings><p class="muted small">Loading…</p></div>
    </section>

    <section class="set-sec">
      <h2>Updates <span class="tag">all projects on this computer</span></h2>
      <div data-update-settings></div>
    </section>

    <section class="set-sec">
      <h2>Snapshots</h2>
      <p class="muted small">The project is copied to its backups folder every 10 minutes while you work (the last 60 copies are kept). Save a named snapshot before a big change, such as merging codes or starting second-cycle coding.</p>
      <div class="btn-row"><input data-snap-label placeholder="Snapshot name, e.g. End of first-cycle coding" aria-label="Snapshot name"><button class="btn small primary" data-act="snap">Save snapshot</button></div>
      <div data-snaps class="small muted">Loading…</div>
    </section>

    <section class="set-sec">
      <h2>Change log</h2>
      <p class="muted small">Codebook and project changes, newest first. Included in the audit-trail export.</p>
      <table class="log-table"><tbody>${[...p.log].reverse().slice(0, 300).map((e) => `<tr><td class="nowrap">${esc(fmtDate(e.t))}</td><td>${esc(e.action)}</td><td>${esc(e.detail)}</td></tr>`).join('')}</tbody></table>
    </section>

    <section class="set-sec">
      <h2>Delete project</h2>
      <p class="muted small">Moves this project's folder, with its backups and AI log, into <code>${esc(joinPath(S.dataDir, '_trash'))}</code>. Nothing is erased. To bring a project back, move its folder out of <code>_trash</code> and into the projects folder, then reload this page.</p>
      <button class="btn small danger-ghost" data-act="trash">Delete this project…</button>
    </section>

    <section class="set-sec">
      <h2>Keyboard shortcuts</h2>
      <table class="log-table"><tbody>
        <tr><td><kbd>Enter</kbd></td><td>In the code picker: apply the highlighted code. <kbd>${SHIFT}Enter</kbd> applies it and keeps the picker open for another code.</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Close the picker or clear the selection and highlighting.</td></tr>
        <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>Previous or next document.</td></tr>
        <tr><td><kbd>${SHIFT}click</kbd> a code</td><td>Highlight several codes at once.</td></tr>
        <tr><td><kbd>${MOD}Z</kbd> / <kbd>${SHIFT}${MOD}Z</kbd></td><td>Undo or redo.</td></tr>
        <tr><td><kbd>/</kbd></td><td>Go to Search.</td></tr>
        <tr><td><kbd>${MOD}S</kbd></td><td>Save now (saving is also automatic).</td></tr>
      </tbody></table>
    </section>
  </div></div></div>`;

  const root = el.querySelector('.settings-view');
  bindField($('[data-name]', root), p, 'name', {
    label: 'rename project',
    onCommit: (a, b) => {
      if (!b.trim()) { p.name = a; return; }
      logEvent(p, 'Project renamed', `${a} → ${b}`);
      const entry = S.projects.find((x) => x.id === p.id);
      if (entry) entry.name = b;
      touch(true);
    },
  });
  const instr = $('[data-instructions]', root);
  if (instr) bindField(instr, st, 'ai_instructions', { label: 'edit AI instructions' });
  renderGoogleSettings(root);
  renderUpdateSettings($('[data-update-settings]', root));

  if (!S.ai) {
    api('GET', '/ai/status').then((r) => { S.ai = r; if (S.view === 'settings') rerender(); }).catch(() => {});
  }
  $('[data-model]', root)?.addEventListener('change', (e) => {
    mutate('change AI model', (pp) => { pp.settings.ai_model = e.target.value; logEvent(pp, 'AI model changed', e.target.value); });
  });
  $$('[data-attr-name]', root).forEach((input) => input.addEventListener('change', () => {
    const i = Number(input.dataset.attrName);
    const from = p.attributes[i];
    const to = input.value.trim();
    if (!to || to === from) { input.value = from; return; }
    if (p.attributes.includes(to)) { toast('That attribute already exists'); input.value = from; return; }
    mutate('rename attribute', (pp) => {
      pp.attributes[i] = to;
      for (const d of pp.documents) if (from in d.attrs) { d.attrs[to] = d.attrs[from]; delete d.attrs[from]; }
      logEvent(pp, 'Attribute renamed', `${from} → ${to}`);
    });
  }));

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-attr-del],[data-restore]');
    if (!t) return;
    if (t.dataset.attrDel != null) {
      const k = p.attributes[Number(t.dataset.attrDel)];
      if (!(await confirmDialog(`Remove the attribute “${k}” and its values from every document? You can undo this.`, { ok: 'Remove', danger: true }))) return;
      mutate('remove attribute', (pp) => {
        pp.attributes = pp.attributes.filter((x) => x !== k);
        for (const d of pp.documents) delete d.attrs[k];
        logEvent(pp, 'Attribute removed', k);
      });
      return;
    }
    if (t.dataset.restore) {
      const ok = await confirmDialog(`Replace the current project with the snapshot “${t.dataset.label}”? The current version is saved as a snapshot first, so you can switch back.`, { title: 'Restore snapshot', ok: 'Restore' });
      if (!ok) return;
      try {
        await flushSave();
        const r = await api('POST', `/projects/${p.id}/restore`, { name: t.dataset.restore });
        setProject(r.project);
        toast('Snapshot restored');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    switch (t.dataset.act) {
      case 'attr-add': {
        const k = (await promptDialog('New attribute', 'Attribute name', '', { placeholder: 'e.g. participant, role, college' }))?.trim();
        if (!k) return;
        if (p.attributes.includes(k)) { toast('That attribute already exists'); return; }
        mutate('add attribute', (pp) => { pp.attributes.push(k); });
        break;
      }
      case 'ai-check':
        S.ai = null;
        rerender();
        try { S.ai = await api('GET', '/ai/status'); } catch { S.ai = { available: false }; }
        rerender();
        break;
      case 'ai-on':
        mutate('turn on AI suggestions', (pp) => {
          pp.settings.ai_enabled = true;
          pp.settings.ai_ack = { t: new Date().toISOString(), backend: 'ollama' };
          if (!pp.settings.ai_model && models.length) {
            pp.settings.ai_model = models.includes('llama3.1:8b') ? 'llama3.1:8b' : models[0];
          }
          logEvent(pp, 'AI suggestions turned on', `Local model through Ollama${pp.settings.ai_model ? ` (${pp.settings.ai_model})` : ''}`);
        });
        break;
      case 'ai-off':
        mutate('turn off AI suggestions', (pp) => {
          pp.settings.ai_enabled = false;
          pp.settings.ai_ack = null;
          logEvent(pp, 'AI suggestions turned off', '');
        });
        break;
      case 'trash': {
        const ok = await confirmDialog(`Delete “${p.name}”? It disappears from Qual Coder, but its folder is kept in the _trash folder, so you can restore it.`, { title: 'Delete project', ok: 'Delete project', danger: true });
        if (!ok) return;
        try {
          await flushSave();
          const r = await api('POST', `/projects/${p.id}/trash`, {});
          try { if (localStorage.getItem('qc.lastProject') === p.id) localStorage.removeItem('qc.lastProject'); } catch { /* private mode */ }
          closeProject();
          await loadProjects();
          rerender();
          toast(`Deleted “${p.name}”. Its folder is now ${r.moved_to}`);
        } catch (err) { toast(err.message, 'error'); }
        break;
      }
      case 'snap': {
        const label = $('[data-snap-label]', root).value.trim();
        try {
          await flushSave();
          await api('POST', `/projects/${p.id}/snapshots`, { label });
          mutate('snapshot', (pp) => logEvent(pp, 'Snapshot saved', label || '(no name)'), { undo: false });
          toast('Snapshot saved');
        } catch (err) { toast(err.message, 'error'); }
        break;
      }
      default: break;
    }
  });

  api('GET', `/projects/${p.id}/snapshots`).then((r) => {
    const box = $('[data-snaps]', root);
    if (!box) return;
    const kindLabel = { auto: 'Automatic', snap: 'Snapshot', prerestore: 'Before a restore' };
    const list = r.snapshots;
    box.innerHTML = list.length ? `<table class="log-table"><tbody>${list.slice(0, 80).map((s) => `<tr>
      <td class="nowrap">${esc(fmtDate(s.time))}</td><td>${kindLabel[s.kind] || s.kind}</td><td>${esc(s.label)}</td>
      <td class="nowrap">${Math.max(1, Math.round(s.size / 1024))} KB</td>
      <td><button class="btn small" data-restore="${esc(s.name)}" data-label="${esc(s.label || fmtDate(s.time))}">Restore</button></td></tr>`).join('')}</tbody></table>`
      : '<p>No snapshots yet. The first automatic one is made the first time the project saves.</p>';
  }).catch(() => {});

  if (st.ai_enabled) {
    api('GET', `/projects/${p.id}/ai-log`).then((r) => {
      const box = $('[data-ai-log]', root);
      if (!box) return;
      const list = [...r.entries].reverse();
      box.innerHTML = list.length ? `<table class="log-table"><tbody>${list.map((e) => `<tr>
        <td class="nowrap">${esc(fmtDate(e.t))}</td><td>${esc(e.doc_title)}</td>
        <td>${e.chars_sent.toLocaleString()} characters · ${esc(e.backend ? `local ${e.model_used || e.model}` : `${e.model_used || e.model} (before the switch to local models)`)} · ${plural(e.suggestions, 'suggestion')}${e.unplaced ? ` (${e.unplaced} dropped)` : ''} · ${e.seconds}s</td></tr>`).join('')}</tbody></table>`
        : '<p>No requests yet.</p>';
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------- Google Drive

async function renderGoogleSettings(root, message = '') {
  const box = $('[data-google-settings]', root);
  if (!box) return;
  let c = {};
  try { c = await gdrive.googleConfig(true); } catch { /* older server */ }
  if (!box.isConnected) return;
  const ready = gdrive.googleReady(c);
  const port = location.port || '80';
  const onIp = location.hostname === '127.0.0.1';
  box.innerHTML = `
    <p>${ready
      ? `Set up${c.source === 'included with Qual Coder' ? ' (settings included with this copy of Qual Coder)' : ''}. In <b>+ Add</b> › <b>Google Drive</b>, sign in with Google and pick documents. Qual Coder can open only the documents you pick, and your Google sign-in stays in the browser; it isn't saved.`
      : 'Not set up. Without it, you can still bring in Google Docs: in Drive, select documents or a folder › Download, then add the .zip in <b>+ Add</b> › <b>Files</b>.'}</p>
    ${onIp ? `<p class="small">Google sign-in needs the address <a href="http://localhost:${port}/#settings">http://localhost:${port}</a>. Open Qual Coder there instead of ${esc(location.origin)}.</p>` : ''}
    <div class="grid3">
      <label class="field"><span>OAuth client ID</span><input data-g="client_id" value="${esc(c.client_id || '')}" placeholder="…apps.googleusercontent.com" spellcheck="false"></label>
      <label class="field"><span>API key</span><input data-g="api_key" value="${esc(c.api_key || '')}" placeholder="AIza…" spellcheck="false"></label>
      <label class="field"><span>Project number</span><input data-g="project_number" value="${esc(c.project_number || '')}" placeholder="123456789012" spellcheck="false"></label>
    </div>
    <div class="btn-row">
      <button class="btn small primary" data-gact="save">Save</button>
      <button class="btn small" data-gact="test" ${ready ? '' : 'disabled'}>Test sign-in</button>
      ${ready ? '<button class="btn small ghost" data-gact="signout">Sign out of Google</button>' : ''}
    </div>
    ${message ? `<p class="small ${message.startsWith('✓') ? 'ok' : 'error'}">${esc(message)}</p>` : ''}
    <details ${ready ? '' : 'open'}><summary>How to set this up (once, about 15 minutes)</summary>
      <ol class="small steps">
        <li>Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a>, sign in with the Google account whose Drive you'll use, and create a project named <b>Qual Coder</b>.</li>
        <li>In <b>APIs &amp; Services › Library</b>, enable the <b>Google Drive API</b> and the <b>Google Picker API</b>.</li>
        <li>In <b>Google Auth Platform › Branding</b>, set the app name to Qual Coder and add your email. Under <b>Audience</b>, choose <b>Internal</b> if it's offered (anyone in your organization can sign in, with no review). Otherwise choose External, leave it in Testing, and add each person who'll use it as a test user.</li>
        <li>In <b>Data Access</b>, add the scope <code>…/auth/drive.file</code>. It only covers files a person picks.</li>
        <li>In <b>Clients</b>, create a client of type <b>Web application</b>. Under <b>Authorized JavaScript origins</b>, add <code>http://localhost:${esc(port)}</code>, plus <code>http://localhost:4351</code> for when that port is in use. Copy the <b>Client ID</b>.</li>
        <li>In <b>APIs &amp; Services › Credentials</b>, choose <b>Create credentials › API key</b>. Restrict it to the <b>Google Picker API</b> and to the websites <code>http://localhost:${esc(port)}/*</code>. Copy the key.</li>
        <li>Copy the <b>Project number</b> from the console's Welcome page (Project info).</li>
        <li>Paste all three above, click <b>Save</b>, then <b>Test sign-in</b>.</li>
      </ol>
      <p class="small muted">To share this setup with classmates, save the three values in a file named <code>google.json</code> next to <code>server.py</code> before you build the zip. They can then sign in without doing this setup, as long as the app lets them in (Internal, or added as test users).</p>
    </details>`;

  box.onclick = async (e) => {
    const b = e.target.closest('[data-gact]');
    if (!b) return;
    if (b.dataset.gact === 'save') {
      const vals = Object.fromEntries($$('[data-g]', box).map((i) => [i.dataset.g, i.value.trim()]));
      try {
        await api('PUT', '/config', { google: vals });
        await renderGoogleSettings(root, gdrive.googleReady(vals) ? '✓ Saved. Click Test sign-in to check it works.' : '✓ Saved.');
      } catch (err) { renderGoogleSettings(root, err.message); }
    } else if (b.dataset.gact === 'test') {
      if (!gdrive.googleLoaded()) {
        toast('Loading Google…');
        gdrive.preloadGoogle()
          .then(() => toast('Google is ready. Click Test sign-in again.'))
          .catch((err) => renderGoogleSettings(root, err.message));
        return;
      }
      gdrive.signIn()
        .then(() => renderGoogleSettings(root, '✓ Signed in. Google Drive is ready: use + Add › Google Drive in the Code view.'))
        .catch((err) => renderGoogleSettings(root, err.message));
    } else if (b.dataset.gact === 'signout') {
      gdrive.signOut();
      renderGoogleSettings(root, '✓ Signed out of Google in Qual Coder.');
    }
  };
  if (ready) gdrive.preloadGoogle().catch(() => {});
}
