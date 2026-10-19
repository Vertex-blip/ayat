import { tokenize } from './align.js';
import { spokenForms } from './live-progress.js?v=8e86ad911261';

// A small text index, not a speech model. Coordinates refer to the unchanged
// QPC glyphs; normalized forms are used only to match speech transcripts.
export function createRecitationIndex(corpus) {
  const tokens = [], byForm = new Map(), pageStarts = new Map(), pageWords = new Map();
  for (const [page, words] of corpus) {
    pageStarts.set(page, tokens.length); pageWords.set(page, words.length);
    for (const [glyph, [text, surah, ayah]] of words.entries()) {
      const parts = tokenize(text);
      for (const token of parts) {
        const forms = spokenForms(token.display);
        const position = tokens.length;
        tokens.push({ page, glyph, surah, ayah, forms, parts: parts.length });
        for (const form of forms) {
          if (!byForm.has(form)) byForm.set(form, []);
          byForm.get(form).push(position);
        }
      }
    }
  }
  return { tokens, byForm, pageStarts, pageWords };
}

function matchAt(tokens, heard, e, h) {
  if (!tokens[e] || !heard[h]) return null;
  if (tokens[e].forms.has(heard[h].norm)) return [1, 1];
  if (tokens[e + 1]) {
    for (const a of tokens[e].forms) for (const b of tokens[e + 1].forms) {
      if (a + b === heard[h].norm) return [2, 1];
    }
  }
  if (heard[h + 1] && tokens[e].forms.has(heard[h].norm + heard[h + 1].norm)) return [1, 2];
  return null;
}

// Search by a distinctive matching run. Repeated Quran phrases remain
// ambiguous until enough context is heard; current-page preference may resolve
// a tie on that page but never selects an arbitrary distant copy.
export function locateRecitation(index, transcript, { hintPage = null, minWords = 3 } = {}) {
  const heard = typeof transcript === 'string' ? tokenize(transcript) : transcript;
  const found = new Map();
  for (let h = 0; h < heard.length; h++) {
    const positions = index.byForm.get(heard[h].norm) || [];
    for (const e of positions) {
      let ei = e, hi = h, letters = 0;
      while (ei < index.tokens.length && hi < heard.length) {
        const step = matchAt(index.tokens, heard, ei, hi);
        if (!step) break;
        for (let i = 0; i < step[1]; i++) letters += heard[hi + i].norm.length;
        ei += step[0]; hi += step[1];
      }
      const length = ei - e;
      if (length < minWords || letters < (minWords === 1 ? 1 : 9)) continue;
      const invocation = 'بسماللهالرحمنالرحيم';
      const phrase = heard.slice(h, hi).map(word => word.norm).join('');
      if (invocation.includes(phrase)) continue;
      // Only Al-Fatihah's basmala is an ayah in this index. The same invocation
      // is read before every surah, so it cannot identify page 1 on its own.
      if (hintPage !== 1 && index.tokens[e].surah === 1 && index.tokens[e].ayah === 1 && index.tokens[ei - 1].ayah === 1) continue;
      const candidate = { start: e, heard: h, length, end: ei, heardEnd: hi, page: index.tokens[e].page };
      const key = e - h;
      if (!found.has(key) || found.get(key).length < length) found.set(key, candidate);
    }
  }
  if (!found.size) return null;
  const ranked = [...found.values()].sort((a, b) => a.heard - b.heard || b.length - a.length);
  for (const h of [...new Set(ranked.map(c => c.heard))]) {
    const group = ranked.filter(c => c.heard === h);
    const ties = group.filter(c => c.length === group[0].length);
    if (ties.length === 1) return ties[0];
    const local = ties.filter(c => c.page === hintPage);
    if (local.length === 1) return local[0];
  }
  return null;
}

// Semiglobal alignment records only exact/orthographic matches. Unmatched
// expected words are holes, never inferred correct words. Later exact matches
// can still be rendered so one ASR spelling error cannot freeze an entire page.
function align(index, start, heard) {
  const expected = index.tokens;
  const length = Math.min(expected.length - start, heard.length * 2 + 16);
  const width = heard.length + 1;
  const cost = new Float32Array((length + 1) * width).fill(Infinity);
  const move = new Uint8Array(cost.length);
  const at = (e, h) => e * width + h;
  cost[0] = 0;
  const relax = (e, h, score, op) => { const p = at(e, h); if (score < cost[p]) { cost[p] = score; move[p] = op; } };
  for (let e = 0; e <= length; e++) for (let h = 0; h <= heard.length; h++) {
    const score = cost[at(e, h)];
    if (!Number.isFinite(score)) continue;
    if (e < length && h < heard.length) {
      const same = matchAt(expected, heard, start + e, h);
      if (same && e + same[0] <= length) relax(e + same[0], h + same[1], score, same[0] === 2 ? 4 : same[1] === 2 ? 5 : 1);
    }
    if (h < heard.length) relax(e, h + 1, score + 1.1, 2);
    if (e < length) relax(e + 1, h, score + 1.2, 3);
  }
  let e = 0, h = heard.length;
  for (let i = 1; i <= length; i++) if (cost[at(i, h)] < cost[at(e, h)]) e = i;
  const matches = [];
  while (e || h) {
    const op = move[at(e, h)];
    if (op === 1) { matches.push({ token: start + e - 1, heard: h - 1 }); e--; h--; }
    else if (op === 4) { matches.push({ token: start + e - 1, heard: h - 1 }, { token: start + e - 2, heard: h - 1 }); e -= 2; h--; }
    else if (op === 5) { matches.push({ token: start + e - 1, heard: h - 1 }); e--; h -= 2; }
    else if (op === 2) h--;
    else if (op === 3) e--;
    else break;
  }
  matches.sort((a, b) => a.token - b.token);
  return matches;
}

export function createQuranFollower(index, { page = 1, startGlyph = null } = {}) {
  let origin = null, heardBase = 0, cursor = null, displayPage = page;
  let segmentNumber = 0;
  const matched = new Set(), uncertain = new Set();
  // Resume is only a hint. Every new microphone press can locate a different
  // passage; it is not pinned forever to the previous page's next word.
  const resume = startGlyph === null ? null : index.tokens.findIndex(t => t.page === page && t.glyph === startGlyph);
  function render(matches, final, waitingForStart = false) {
    const matchedNow = new Set(matches.map(m => m.token));
    const last = matches.at(-1);
    if (last) {
      const first = matches[0].token;
      for (let p = first; p <= last.token; p++) {
        if (matchedNow.has(p)) { matched.add(p); uncertain.delete(p); }
        else if (!matched.has(p)) uncertain.add(p);
      }
      cursor = Math.max(cursor ?? 0, last.token + 1);
      displayPage = index.tokens[last.token].page;
    }
    const glyphTokens = new Map();
    for (const p of matched) {
      const t = index.tokens[p];
      if (t.page !== displayPage) continue;
      if (!glyphTokens.has(t.glyph)) glyphTokens.set(t.glyph, []);
      glyphTokens.get(t.glyph).push(p);
    }
    const matchedGlyphs = [];
    for (const [glyph, positions] of glyphTokens) {
      const whole = positions.length === index.tokens[positions[0]].parts;
      if (whole) matchedGlyphs.push(glyph);
    }
    const uncertainGlyphs = [...new Set([...uncertain].filter(p => index.tokens[p].page === displayPage).map(p => index.tokens[p].glyph))].filter(g => !matchedGlyphs.includes(g));
    return { page: displayPage, progress: {
      matchedGlyphs, uncertainGlyphs, confirmedGlyphs: matchedGlyphs.length ? Math.max(...matchedGlyphs) + 1 : 0,
      confirmed: matchedGlyphs.length, revealedFrom: 0, total: index.pageWords.get(displayPage),
      waitingForStart, blocked: final && uncertainGlyphs.length > 0,
    } };
  }
  return {
    nextSegment() { origin = cursor; heardBase = 0; segmentNumber++; },
    update(transcript, { final = false } = {}) {
      const heard = tokenize(transcript);
      if (!heard.length) return render([], final, true);
      if (origin === null) {
        let location = locateRecitation(index, heard, { hintPage: displayPage });
        if (!location) {
          // Fast feedback for the selected page while global identification
          // waits for a distinctive phrase. Never change page on one word.
          const candidates = [resume, index.pageStarts.get(displayPage)].filter(p => p !== null && p !== undefined && p >= 0);
          const local = candidates.find(p => matchAt(index.tokens, heard, p, 0));
          if (local !== undefined) {
            const partial = align(index, local, heard);
            return render(partial, final, false);
          }
          const localAyah = locateRecitation(index, heard, { hintPage: displayPage, minWords: 2 });
          if (localAyah?.page === displayPage) {
            return render(align(index, localAyah.start, heard.slice(localAyah.heard)), final);
          }
          return render([], final, true);
        }
        origin = location.start; heardBase = location.heard; cursor = origin;
      }
      let matches = align(index, origin, heard.slice(heardBase));
      // New speech far beyond the reached text may be a deliberate move to
      // another surah. Require a unique phrase after the last matched speech;
      // a single wrong word cannot trigger a jump to another page.
      const lastHeard = matches.reduce((max, m) => Math.max(max, m.heard + heardBase), heardBase - 1);
      if (heard.length - lastHeard > 3) {
        const suffixStart = Math.max(heardBase, lastHeard + 1);
        const location = locateRecitation(index, heard.slice(suffixStart));
        if (location && (location.start < origin || location.start > (cursor ?? origin) + 40)) {
          origin = location.start; heardBase = suffixStart + location.heard; cursor = origin;
          matches = align(index, origin, heard.slice(heardBase));
        }
      }
      return { ...render(matches, final), segment: segmentNumber };
    },
  };
}
