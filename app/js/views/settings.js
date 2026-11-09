// Settings: project name, document attributes, AI assistance, snapshots, change log.
import {
  S, mutate, api, bindField, flushSave, setProject, logEvent, rerender, touch, closeProject, loadProjects,
} from '../store.js';
import {
  esc, fmtDate, plural, toast, confirmDialog, promptDialog, openModal, joinPath, MOD, SHIFT, $, $$,
} from '../util.js';
import { aiAckHtml, readAck } from '../ai.js';

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
        : '<button class="btn small" data-act="ai-on">Turn on AI suggestions…</button>'}
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
      case 'ai-on': {
        openModal({
          title: 'Turn on AI suggestions',
          body: aiAckHtml(),
          wide: true,
          actions: [
            { label: 'Cancel' },
            {
              label: 'Turn on',
              primary: true,
              onClick: (h) => {
                if (!readAck(h.body)) { toast('Check both boxes to turn this on'); return false; }
                mutate('turn on AI suggestions', (pp) => {
                  pp.settings.ai_enabled = true;
                  pp.settings.ai_ack = { t: new Date().toISOString(), backend: 'ollama', rules_allow: true, will_review: true };
                  if (!pp.settings.ai_model && models.length) {
                    pp.settings.ai_model = models.includes('llama3.1:8b') ? 'llama3.1:8b' : models[0];
                  }
                  logEvent(pp, 'AI suggestions turned on', 'Local model through Ollama. Researcher confirmed no rule prohibits AI-assisted coding and that they will review every suggestion.');
                });
                return true;
              },
            },
          ],
        });
        break;
      }
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
