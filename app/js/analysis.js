// Retrieval, matrices, co-occurrence and report builders shared by Analyze and Export.
import {
  S, idx, descendants, codeTree, paragraphs, paraIndexAt, docMatches, locLabel, excerptText,
  codePath, parentGroups,
} from './store.js';
import { esc, localStamp } from './util.js';

export function ancestorsAndSelf(id) {
  const I = idx();
  const out = [];
  const seen = new Set();
  let c = I.codes.get(id);
  while (c && !seen.has(c.id)) {
    seen.add(c.id);
    out.push(c.id);
    c = c.parent ? I.codes.get(c.parent) : null;
  }
  return out;
}

// Categories and themes a code feeds, directly or through a parent code or a category.
export function groupsForCode(codeId) {
  const chain = new Set(ancestorsAndSelf(codeId));
  const direct = S.project.groups.filter((g) => g.members.some((m) => m.kind === 'code' && chain.has(m.id)));
  const all = new Map(direct.map((g) => [g.id, g]));
  const queue = [...direct];
  while (queue.length) {
    const g = queue.shift();
    for (const pg of parentGroups(g.id)) if (!all.has(pg.id)) { all.set(pg.id, pg); queue.push(pg); }
  }
  const gs = [...all.values()];
  return { categories: gs.filter((g) => g.kind !== 'theme'), themes: gs.filter((g) => g.kind === 'theme') };
}

export function codeOrder() {
  return new Map(codeTree().map(({ code }, i) => [code.id, i]));
}

export function retrieve({ codeIds = [], includeChildren = true, filters = null, origin = 'all', q = '' } = {}) {
  const I = idx();
  const set = new Set();
  for (const id of codeIds) for (const d of includeChildren ? descendants(id) : [id]) set.add(d);
  const needle = q.trim().toLowerCase();
  const out = [];
  for (const c of S.project.codings) {
    if (!set.has(c.code) || !I.codes.has(c.code)) continue;
    const doc = I.docs.get(c.doc);
    if (!doc || !docMatches(doc, filters)) continue;
    if (origin === 'human' && c.origin === 'ai') continue;
    if (origin === 'ai' && c.origin !== 'ai') continue;
    if (needle && !excerptText(c).toLowerCase().includes(needle)) continue;
    out.push(c);
  }
  const order = codeOrder();
  out.sort((a, b) => order.get(a.code) - order.get(b.code) || I.docOrder.get(a.doc) - I.docOrder.get(b.doc) || a.start - b.start);
  return out;
}

export function byCode(codings) {
  const m = new Map();
  for (const c of codings) {
    if (!m.has(c.code)) m.set(c.code, []);
    m.get(c.code).push(c);
  }
  return m;
}

// ---------------------------------------------------------------- matrices

export function columnsFor(colMode, filters) {
  const docs = S.project.documents.filter((d) => docMatches(d, filters));
  if (colMode === 'doc') return docs.map((d) => ({ key: d.id, label: d.title, docIds: new Set([d.id]) }));
  const getVal = colMode === 'set'
    ? (d) => d.set || '(no set)'
    : (d) => String(d.attrs?.[colMode] ?? '').trim() || '(blank)';
  const m = new Map();
  for (const d of docs) {
    const v = getVal(d);
    if (!m.has(v)) m.set(v, new Set());
    m.get(v).add(d.id);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([v, ids]) => ({ key: v, label: `${v} (${ids.size})`, value: v, docIds: ids }));
}

export function codeMatrix({ colMode = 'doc', rollup = false, measure = 'excerpts', filters = null } = {}) {
  const I = idx();
  const cols = columnsFor(colMode, filters);
  const inScope = new Set(cols.flatMap((c) => [...c.docIds]));
  const rows = codeTree().map(({ code, depth }) => {
    const ids = rollup ? descendants(code.id) : [code.id];
    const seen = new Set();
    const cs = [];
    for (const id of ids) {
      for (const c of I.byCode.get(id) || []) {
        const k = `${c.doc}:${c.start}:${c.end}`;
        if (rollup && seen.has(k)) continue;
        seen.add(k);
        cs.push(c);
      }
    }
    const count = (list) => (measure === 'docs' ? new Set(list.map((c) => c.doc)).size : list.length);
    const cells = cols.map((col) => count(cs.filter((c) => col.docIds.has(c.doc))));
    return { code, depth, cells, total: count(cs.filter((c) => inScope.has(c.doc))) };
  });
  return { cols, rows };
}

export function cooccurrence(unit = 'overlap', filters = null) {
  const I = idx();
  const docs = S.project.documents.filter((d) => docMatches(d, filters));
  const pairs = new Map();
  const diag = new Map();
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const addPair = (a, b, item) => {
    const k = key(a, b);
    if (!pairs.has(k)) pairs.set(k, { n: 0, items: [] });
    const e = pairs.get(k);
    e.n++;
    if (e.items.length < 300) e.items.push(item);
  };
  const addDiag = (a) => diag.set(a, (diag.get(a) || 0) + 1);
  for (const doc of docs) {
    const cs = I.byDoc.get(doc.id) || [];
    if (unit === 'overlap') {
      for (const c of cs) addDiag(c.code);
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const a = cs[i];
          const b = cs[j];
          if (b.start >= a.end) break;
          if (a.code !== b.code) addPair(a.code, b.code, { doc: doc.id, a: a.id, b: b.id });
        }
      }
    } else if (unit === 'paragraph') {
      const paraCodes = new Map();
      for (const c of cs) {
        const i0 = paraIndexAt(doc, c.start);
        const i1 = paraIndexAt(doc, Math.max(c.start, c.end - 1));
        for (let i = i0; i <= i1; i++) {
          if (!paraCodes.has(i)) paraCodes.set(i, new Set());
          paraCodes.get(i).add(c.code);
        }
      }
      for (const [pi, set] of paraCodes) {
        const arr = [...set];
        arr.forEach(addDiag);
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) addPair(arr[i], arr[j], { doc: doc.id, para: pi });
      }
    } else {
      const arr = [...new Set(cs.map((c) => c.code))];
      arr.forEach(addDiag);
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) addPair(arr[i], arr[j], { doc: doc.id });
    }
  }
  const codes = codeTree().map((x) => x.code.id).filter((id) => diag.has(id));
  return { codes, pairs, diag, key };
}

// ---------------------------------------------------------------- text search

// Length of a leading speaker label such as "[00:01:02] T4 Participant A: ".
export function speakerLabelEnd(text) {
  const m = text.match(/^\s*(?:\[[^\]\n]{1,20}\]\s*)?(?:T\d{1,4}\b[\s.:)-]*)?(?:[A-Z][^:\n]{0,40}:\s+)?/);
  return m ? m[0].length : 0;
}

export function parseTerms(q, mode) {
  q = String(q || '').trim();
  if (!q) return [];
  if (mode === 'phrase') return [q.replace(/^["“](.*)["”]$/, '$1')];
  const terms = [];
  const re = /["“]([^"”]+)["”]|(\S+)/g;
  let m;
  while ((m = re.exec(q))) terms.push(m[1] || m[2]);
  return terms;
}

function termRegex(term, whole, cased) {
  let t = term.trim();
  let prefix = false;
  if (t.endsWith('*')) { prefix = true; t = t.replace(/\*+$/, ''); }
  if (!t) return null;
  const body = t.split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]"))
    .join('\\s+');
  const start = whole ? '(?<![\\p{L}\\p{N}])' : '';
  const end = prefix ? "[\\p{L}\\p{N}'’-]*" : (whole ? '(?![\\p{L}\\p{N}])' : '');
  return new RegExp(start + body + end, `gu${cased ? '' : 'i'}`);
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

// Find matches paragraph by paragraph. mode: phrase | any | all (all words in one paragraph).
export function textSearch({ q, mode = 'phrase', whole = true, cased = false, uncoded = false, filters = null } = {}) {
  const res = parseTerms(q, mode).map((t) => termRegex(t, whole, cased)).filter(Boolean);
  if (!res.length) return { rows: [], hits: 0, docs: 0 };
  const I = idx();
  const rows = [];
  let hits = 0;
  const docSet = new Set();
  for (const doc of S.project.documents) {
    if (!docMatches(doc, filters)) continue;
    const codings = I.byDoc.get(doc.id) || [];
    paragraphs(doc).forEach((para, pi) => {
      if (para.n == null) return;
      const per = res.map((re) => {
        re.lastIndex = 0;
        const found = [];
        let m;
        while ((m = re.exec(para.text))) {
          if (!m[0].length) { re.lastIndex++; continue; }
          found.push([para.start + m.index, para.start + m.index + m[0].length]);
        }
        return found;
      });
      if (mode === 'all' && per.some((f) => !f.length)) return;
      let matches = mergeRanges(per.flat());
      if (uncoded) matches = matches.filter(([a, b]) => !codings.some((c) => c.start < b && c.end > a));
      if (!matches.length) return;
      rows.push({ key: `${doc.id}:${pi}`, doc: doc.id, pi, para, matches });
      hits += matches.length;
      docSet.add(doc.id);
    });
  }
  return { rows, hits, docs: docSet.size };
}

// Widen a match to the sentence or the paragraph (without its speaker label).
export function spreadRange(doc, a, b, spread) {
  if (spread === 'match') return [a, b];
  const para = paragraphs(doc)[paraIndexAt(doc, a)];
  const labelEnd = para.start + speakerLabelEnd(para.text);
  const lo = labelEnd <= a ? labelEnd : para.start;
  const text = doc.text;
  let s;
  let e;
  if (spread === 'paragraph') {
    s = lo;
    e = para.end;
  } else {
    s = a;
    while (s > lo && !/[.!?]/.test(text[s - 1])) s--;
    while (s < a && /[\s"”’)]/.test(text[s])) s++;
    e = b;
    while (e < para.end && !/[.!?]/.test(text[e])) e++;
    if (e < para.end) {
      e++;
      while (e < para.end && /["”’)]/.test(text[e])) e++;
    }
  }
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [Math.min(s, a), Math.max(e, b)];
}

export function rowRanges(row, spread) {
  const doc = idx().docs.get(row.doc);
  return mergeRanges(row.matches.map(([a, b]) => spreadRange(doc, a, b, spread)));
}

const STOP = new Set(`a about above after again against all also am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each even few for from further get gets getting go goes going gonna got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself just kind know let's like lot make me mean more most much my myself no nor not now of off oh ok okay on once one only or other ought our ours ourselves out over own really right said same say says she she'd she'll she's should shouldn't so some something sort such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've thing things think this those through to too uh um under until up us very want was wasn't way we we'd we'll we're we've well were weren't what what's when when's where where's which while who who's whom why why's will with won't would wouldn't yeah yes you you'd you'll you're you've your yours yourself yourselves`.split(/\s+/));

export function frequentWords({ filters = null, ignore = '', limit = 40 } = {}) {
  const extra = new Set(String(ignore).toLowerCase().split(/[,;\s]+/).filter(Boolean));
  const counts = new Map();
  for (const doc of S.project.documents) {
    if (!docMatches(doc, filters)) continue;
    for (const para of paragraphs(doc)) {
      if (para.n == null) continue;
      const t = para.text.slice(speakerLabelEnd(para.text));
      for (const m of t.matchAll(/\p{L}[\p{L}'’-]*\p{L}|\p{L}/gu)) {
        const w = m[0].toLowerCase().replace(/’/g, "'");
        if (w.length < 3 || STOP.has(w) || extra.has(w)) continue;
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

export const UNIT_LABELS = {
  overlap: 'Overlapping excerpts',
  paragraph: 'Same paragraph or turn',
  document: 'Same document',
};

// ---------------------------------------------------------------- rows & reports

export function excerptRows(codings) {
  const p = S.project;
  const I = idx();
  const keys = p.attributes;
  const header = ['Document', 'Set', ...keys, 'Location', 'Code', 'Code path', 'Categories', 'Themes', 'Excerpt', 'Start', 'End', 'Coded by', 'Coded at'];
  const rows = codings.map((c) => {
    const d = I.docs.get(c.doc);
    const g = groupsForCode(c.code);
    return [
      d.title, d.set || '', ...keys.map((k) => d.attrs?.[k] ?? ''), locLabel(d, c.start),
      I.codes.get(c.code).name, codePath(c.code, ' > '),
      g.categories.map((x) => x.name).join('; '), g.themes.map((x) => x.name).join('; '),
      excerptText(c), c.start, c.end,
      c.origin === 'ai' ? 'AI suggestion, accepted by researcher' : c.via === 'search' ? `Researcher, from text search “${c.query || ''}”` : 'Researcher',
      c.created ? localStamp(c.created) : '',
    ];
  });
  return [header, ...rows];
}

export function contextHtml(c, { before = 1, after = 1 } = {}) {
  const doc = idx().docs.get(c.doc);
  const ps = paragraphs(doc);
  let i0 = paraIndexAt(doc, c.start);
  let i1 = paraIndexAt(doc, Math.max(c.start, c.end - 1));
  for (let k = 0; k < before && i0 > 0;) { i0--; if (ps[i0].n != null) k++; }
  for (let k = 0; k < after && i1 < ps.length - 1;) { i1++; if (ps[i1].n != null) k++; }
  const out = [];
  for (let i = i0; i <= i1; i++) {
    const para = ps[i];
    if (para.n == null) continue;
    const a = Math.max(para.start, c.start);
    const b = Math.min(para.end, c.end);
    let html;
    if (a < b) html = `${esc(doc.text.slice(para.start, a))}<mark>${esc(doc.text.slice(a, b))}</mark>${esc(doc.text.slice(b, para.end))}`;
    else html = esc(para.text);
    out.push(`<p><span class="pn">${para.n}</span>${html}</p>`);
  }
  return `<div class="context">${out.join('')}</div>`;
}

// A report of excerpts grouped by code, as HTML that pastes cleanly into Google Docs or Word.
export function excerptReport(codings, { title, subtitle = '' } = {}) {
  const I = idx();
  const groups = byCode(codings);
  const htmlParts = [`<h1>${esc(title)}</h1>`];
  const textParts = [title, ''];
  if (subtitle) { htmlParts.push(`<p><em>${esc(subtitle)}</em></p>`); textParts.push(subtitle, ''); }
  for (const [codeId, list] of groups) {
    const code = I.codes.get(codeId);
    const docs = new Set(list.map((c) => c.doc)).size;
    htmlParts.push(`<h2>${esc(codePath(codeId))}</h2>`);
    textParts.push(codePath(codeId), '');
    const meta = `${list.length} excerpt${list.length === 1 ? '' : 's'} from ${docs} document${docs === 1 ? '' : 's'}`;
    htmlParts.push(`<p><em>${esc(meta)}</em>${code.definition ? `<br>${esc(code.definition)}` : ''}</p>`);
    textParts.push(meta, ...(code.definition ? [code.definition] : []), '');
    for (const c of list) {
      const d = I.docs.get(c.doc);
      const cite = `${d.title}, ${locLabel(d, c.start)}${c.origin === 'ai' ? ' [AI-suggested]' : ''}`;
      htmlParts.push(`<blockquote>${esc(excerptText(c)).replace(/\n/g, '<br>')}<br>— <em>${esc(cite)}</em></blockquote>`);
      textParts.push(`“${excerptText(c)}”`, `— ${cite}`, '');
    }
  }
  const html = htmlParts.join('\n');
  return { html, text: textParts.join('\n') };
}

export function htmlPage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:16px/1.6 Georgia,serif;max-width:760px;margin:40px auto;padding:0 20px;color:#222}
h1{font-size:1.6em}h2{font-size:1.2em;margin-top:2em;border-bottom:1px solid #ddd}
blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid #999;background:#f7f7f7}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;vertical-align:top;text-align:left}
.code{font:12px/1.4 -apple-system,sans-serif;display:inline-block;border-radius:3px;padding:0 4px;margin:0 2px 2px 0;color:#fff}
.pn{color:#999;font:12px -apple-system,sans-serif;margin-right:.6em}</style></head><body>${bodyHtml}</body></html>`;
}
