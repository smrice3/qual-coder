// Optional AI code suggestions. Only shown when a project has AI turned on.
// Suggestions never become codings until the researcher accepts them.
import {
  S, idx, mutate, api, flushSave, makeCode, findCodeByName, logEvent, codePath, codeTree, rerender,
} from './store.js';
import { esc, truncate, uid, nowIso, toast, confirmDialog, plural, $ } from './util.js';

const busy = { on: false, label: '' };

function codeOptions() {
  return codeTree().map(({ code, depth }) => `<option value="${code.id}">${'  '.repeat(depth)}${esc(code.name)}</option>`).join('');
}

function existingCode(s) {
  return (s.code_id && idx().codes.get(s.code_id)) || findCodeByName(s.code);
}

export function pendingFor(docId) {
  return S.project.suggestions.filter((s) => s.doc === docId && s.status === 'pending').sort((a, b) => a.start - b.start);
}

export function aiSectionHtml(doc, u) {
  const p = S.project;
  const list = pendingFor(doc.id);
  const opts = codeOptions();
  return `<section class="card ai-card">
    <div class="card-head"><h3>AI suggestions</h3><span class="tag ai" title="Runs on this computer through Ollama">Local · ${esc(p.settings.ai_model || 'no model chosen')}</span></div>
    <p class="hint small">Suggestions come from a model running on this computer; nothing leaves it. Nothing is coded until you accept it, and each request is logged in Settings.</p>
    <div class="btn-row">
      <button class="btn small ai" data-act="ai-sel" ${u.pending && !busy.on ? '' : 'disabled'}>Suggest for selection</button>
      <button class="btn small ai" data-act="ai-doc" ${busy.on ? 'disabled' : ''}>Suggest for whole document</button>
    </div>
    ${busy.on ? `<p class="busy"><span class="spinner" aria-hidden="true"></span>${esc(busy.label)}</p>` : ''}
    ${list.length ? `<div class="btn-row"><span class="muted small">${plural(list.length, 'suggestion')} waiting</span>
      <button class="btn small" data-act="ai-accept-all">Accept all</button>
      <button class="btn small ghost" data-act="ai-reject-all">Reject all</button></div>` : ''}
    <div class="sugg-list">${list.map((s) => {
      const ex = existingCode(s);
      return `<div class="sugg ${u.aiFocus === s.id ? 'on' : ''}" data-sid="${s.id}">
        <div class="cc-head">${ex ? `<span class="dot" style="background:${ex.color}"></span><b>${esc(codePath(ex.id))}</b>` : `<span class="tag new">new code</span><b>${esc(s.code)}</b>`}</div>
        ${!ex && s.definition ? `<p class="small muted">${esc(s.definition)}</p>` : ''}
        <blockquote class="clickable" data-act="ai-goto" data-sid="${s.id}" title="Show in text">${esc(truncate(doc.text.slice(s.start, s.end), 220))}</blockquote>
        ${s.rationale ? `<p class="small">${esc(s.rationale)}</p>` : ''}
        <div class="btn-row">
          <button class="btn small primary" data-act="ai-accept" data-sid="${s.id}">Accept</button>
          <select class="small" data-ai-recode="${s.id}" aria-label="Accept with a different code"><option value="">Accept as…</option>${opts}</select>
          <button class="btn small ghost" data-act="ai-reject" data-sid="${s.id}">Reject</button>
        </div></div>`;
    }).join('')}</div>
  </section>`;
}

export async function requestSuggestions(docId, start, end) {
  if (busy.on) return;
  const p = S.project;
  const doc = idx().docs.get(docId);
  if (!doc) return;
  busy.on = true;
  busy.label = end - start > 6000
    ? 'Asking the local model… a whole document can take several minutes on a laptop.'
    : 'Asking the local model… this can take a minute.';
  rerender();
  try {
    await flushSave();
    const r = await api('POST', `/projects/${p.id}/ai/suggest`, { doc_id: docId, start, end });
    if (S.project?.id !== p.id) return;
    let added = 0;
    mutate('AI suggestions', (pp) => {
      for (const s of r.suggestions) {
        const dup = pp.suggestions.some((x) => x.doc === docId && x.status === 'pending' && x.start === s.start && x.end === s.end && x.code.toLowerCase() === s.code.toLowerCase());
        if (dup) continue;
        pp.suggestions.push({
          id: uid('sg'), doc: docId, start: s.start, end: s.end, code: s.code, code_id: s.code_id,
          definition: s.definition, rationale: s.rationale, status: 'pending', log_id: r.log.id, created: nowIso(),
        });
        added++;
      }
      logEvent(pp, 'AI suggestions requested', `${r.suggestions.length} for “${doc.title}” (${r.log.chars_sent.toLocaleString()} characters to local model ${r.log.model_used || r.log.model})`);
    }, { undo: false, render: false });
    const dropped = r.log.unplaced;
    toast(`${plural(added, 'suggestion')} to review${dropped ? `. ${dropped} didn't match the text exactly and ${dropped === 1 ? 'was' : 'were'} dropped.` : ''}`);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy.on = false;
    rerender();
  }
}

function accept(p, s, codeId) {
  if (!s || s.status !== 'pending') return;
  let code = codeId ? p.codes.find((c) => c.id === codeId) : null;
  code ||= (s.code_id && p.codes.find((c) => c.id === s.code_id)) || p.codes.find((c) => c.name.trim().toLowerCase() === s.code.trim().toLowerCase());
  code ||= makeCode(p, s.code, { definition: s.definition, origin: 'ai' });
  if (!p.codings.some((c) => c.doc === s.doc && c.code === code.id && c.start === s.start && c.end === s.end)) {
    p.codings.push({ id: uid('cd'), doc: s.doc, start: s.start, end: s.end, code: code.id, origin: 'ai', suggestion: s.id, created: nowIso() });
  }
  s.status = codeId && code.name.toLowerCase() !== s.code.toLowerCase() ? 'accepted-recoded' : 'accepted';
  s.final_code = code.id;
  s.decided = nowIso();
}

export function handleAiAction(act, t) {
  if (!act?.startsWith('ai-')) return false;
  const u = S.ui.code;
  const docId = u.docId;
  const sid = t.dataset.sid;
  switch (act) {
    case 'ai-sel':
      if (u.pending) requestSuggestions(docId, u.pending.start, u.pending.end);
      break;
    case 'ai-doc': {
      const doc = idx().docs.get(docId);
      if (doc) requestSuggestions(docId, 0, doc.text.length);
      break;
    }
    case 'ai-accept':
      mutate('accept AI suggestion', (p) => accept(p, p.suggestions.find((s) => s.id === sid)));
      break;
    case 'ai-reject':
      mutate('reject AI suggestion', (p) => {
        const s = p.suggestions.find((x) => x.id === sid);
        if (s) { s.status = 'rejected'; s.decided = nowIso(); }
      });
      break;
    case 'ai-goto':
      u.aiFocus = sid;
      u.scrollTo = sid;
      rerender();
      break;
    case 'ai-accept-all':
    case 'ai-reject-all': {
      const list = pendingFor(docId);
      const verb = act === 'ai-accept-all' ? 'Accept' : 'Reject';
      confirmDialog(`${verb} all ${plural(list.length, 'suggestion')} for this document?`, { ok: verb }).then((ok) => {
        if (!ok) return;
        mutate(`${verb.toLowerCase()} all AI suggestions`, (p) => {
          for (const s of p.suggestions.filter((x) => x.doc === docId && x.status === 'pending')) {
            if (act === 'ai-accept-all') accept(p, s);
            else { s.status = 'rejected'; s.decided = nowIso(); }
          }
        });
      });
      break;
    }
    default: return false;
  }
  return true;
}

export function handleAiChange(t) {
  if (!t.dataset.aiRecode || !t.value) return false;
  const sid = t.dataset.aiRecode;
  const codeId = t.value;
  mutate('accept AI suggestion with another code', (p) => accept(p, p.suggestions.find((s) => s.id === sid), codeId));
  return true;
}

// Settings: turning AI on requires an explicit acknowledgment.
export function aiAckHtml() {
  return `<p>Turning this on lets you ask an AI model for code suggestions in this project. The model runs on this computer through Ollama, so the passage you choose and your codebook never leave the computer. Nothing is sent automatically, and nothing is coded until you accept it. Accepted codings are labeled AI here and in every export, and each request is logged.</p>
    <p>Confirm both before turning it on:</p>
    <label class="check"><input type="checkbox" data-ack="rules"> No course, program, IRB or project rule prohibits AI-assisted coding or analysis of this data. (Some courses don't allow it even with a local model. If yours doesn't, leave this off.)</label>
    <label class="check"><input type="checkbox" data-ack="review"> I'll read every suggestion before accepting it. Local models make mistakes, and the coding decisions are mine.</label>`;
}

export function readAck(body) {
  return $('[data-ack="rules"]', body).checked && $('[data-ack="review"]', body).checked;
}
