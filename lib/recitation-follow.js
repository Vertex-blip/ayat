import { tokenize } from './align.js';
import { spokenForms, matchSpokenWords } from './live-progress.js?v=308ab7492b7e';

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
        tokens.push({ page, glyph, surah, ayah, text: token.display, forms, parts: parts.length });
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
  const match = matchSpokenWords(tokens, heard, e, h);
  return match ? [match.expected, match.heard] : null;
}

// Search by a distinctive matching run. Repeated Quran phrases remain
// ambiguous until enough context is heard; current-page preference may resolve
// a tie on that page but never selects an arbitrary distant copy.
export function locateRecitation(index, transcript, { hintPage = null, minWords = 3 } = {}) {
  const heard = typeof transcript === 'string' ? tokenize(transcript) : transcript;
  const found = new Map();
  for (let h = 0; h < heard.length; h++) {
    const positions = new Set(index.byForm.get(heard[h].norm) || []);
    // A speech service may join the very first words too; they must still be
    // usable as a search seed instead of locating only a later phrase.
    for (let split = 1; split < heard[h].norm.length; split++) {
      for (const p of index.byForm.get(heard[h].norm.slice(0, split)) || []) positions.add(p);
    }
    let joined = heard[h].norm;
    for (let count = 2; count <= 3 && heard[h + count - 1]; count++) {
      joined += heard[h + count - 1].norm;
      for (const p of index.byForm.get(joined) || []) positions.add(p);
    }
    for (const e of positions) {
      let ei = e, hi = h, letters = 0;
      while (ei < index.tokens.length && hi < heard.length) {
        const step = matchAt(index.tokens, heard, ei, hi);
        if (!step) break;
        for (let i = 0; i < step[1]; i++) letters += heard[hi + i].norm.length;
        ei += step[0]; hi += step[1];
      }
      const length = ei - e;
      const minLetters = minWords === 1 ? 1 : minWords === 2 ? 6 : 9;
      if (length < minWords || letters < minLetters) continue;
      const invocation = 'بسماللهالرحمنالرحيم';
      const phrase = heard.slice(h, hi).map(word => word.norm).join('');
      if (invocation.includes(phrase)) continue;
      // Only Al-Fatihah's basmala is an ayah in this index. The same invocation
      // is read before every surah, so it cannot identify page 1 on its own.
      if (hintPage !== 1 && index.tokens[e].surah === 1 && index.tokens[e].ayah === 1 && index.tokens[ei - 1].ayah === 1) continue;
      const candidate = { start: e, heard: h, length, end: ei, heardEnd: hi, page: index.tokens[e].page };
      const key = e - h;
      const previous = found.get(key);
      if (!previous || h < previous.heard || (h === previous.heard && previous.length < length)) found.set(key, candidate);
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

// Once located, consume expected words strictly in order. Extra speech can be
// followed by a correction, but it can never skip an unread Quran word.
function followFrom(index, start, heard, repeatFrom = start) {
  let e = start, h = 0, blocked = false, mismatch = null;
  const matches = [];
  while (h < heard.length) {
    const token = index.tokens[e];
    if (token && e > 0 && token.surah !== index.tokens[e - 1].surah && token.surah !== 9) {
      const invocation = 'بسماللهالرحمنالرحيم';
      let phrase = '', end = h;
      while (end < heard.length && invocation.startsWith(phrase + heard[end].norm)) { phrase += heard[end].norm; end++; }
      if (phrase === invocation || (phrase && end === heard.length)) { h = end; continue; }
    }
    const step = matchAt(index.tokens, heard, e, h);
    if (step) {
      for (let i = 0; i < step[0]; i++) matches.push({ token: e + i });
      e += step[0]; h += step[1]; blocked = false; mismatch = null;
    } else {
      // An exact rereading of already reached words is not an error. It must
      // finish before the next unread word, so it cannot advance the cursor.
      let repeatEnd = h;
      for (let from = repeatFrom; from < e; from++) {
        if (from !== repeatFrom && index.tokens[from - 1].ayah === index.tokens[from].ayah && index.tokens[from - 1].surah === index.tokens[from].surah) continue;
        let re = from, rh = h;
        while (re < e && rh < heard.length) {
          const repeat = matchAt(index.tokens, heard, re, rh);
          if (!repeat || re + repeat[0] > e) break;
          re += repeat[0]; rh += repeat[1];
        }
        if (re - from >= 2) repeatEnd = Math.max(repeatEnd, rh);
      }
      if (repeatEnd > h) { h = repeatEnd; continue; }
      if (!mismatch) mismatch = { expected: e, heard: h };
      blocked = true; h++;
    }
  }
  return { matches, end: e, blocked, mismatch };
}

export function createQuranFollower(index, { page = 1, startGlyph = null } = {}) {
  let origin = null, passageStart = null, heardBase = 0, cursor = null, displayPage = page;
  let segmentNumber = 0, blocked = false, issue = null, pending = false, pendingKey = null, pendingPasses = 0;
  const matched = new Set();
  // Resume is only a hint. Every new microphone press can locate a different
  // passage; it is not pinned forever to the previous page's next word.
  const resume = startGlyph === null ? null : index.tokens.findIndex(t => t.page === page && t.glyph === startGlyph);
  function render(matches = [], { waitingForStart = false, preview = false } = {}) {
    const visible = preview ? new Set(matched) : matched;
    const last = matches.at(-1);
    if (last) {
      for (const { token } of matches) visible.add(token);
      if (!preview && last.token + 1 >= (cursor ?? 0)) {
        cursor = last.token + 1;
        displayPage = index.tokens[last.token].page;
      }
    }
    const glyphTokens = new Map();
    for (const p of visible) {
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
    const next = index.tokens[cursor];
    const uncertainGlyphs = blocked && next?.page === displayPage ? [next.glyph] : [];
    const active = blocked || pending ? next : index.tokens[(preview ? last?.token + 1 : cursor) - 1];
    return { page: displayPage, progress: {
      matchedGlyphs, uncertainGlyphs, confirmedGlyphs: matchedGlyphs.length ? Math.max(...matchedGlyphs) + 1 : 0,
      confirmed: matchedGlyphs.length, revealedFrom: 0, total: index.pageWords.get(displayPage),
      waitingForStart, blocked,
      pending, issue,
      // Keep the last positively matched word separate from the word waiting
      // for clarification. An ASR mismatch must not erase the blue position.
      lastMatchedGlyph: matchedGlyphs.length ? Math.max(...matchedGlyphs) : null,
      currentGlyph: active?.page === displayPage ? active.glyph : null,
      blockedAt: blocked && next ? { surah: next.surah, ayah: next.ayah } : null,
    } };
  }
  return {
    // Evaluate only alternatives actually supplied by the speech service.
    // This never invents expected words or changes the saved position.
    selectTranscript(candidates) {
      let best = candidates[0], bestScore = -Infinity;
      for (const candidate of candidates) {
        const heard = tokenize(candidate);
        const location = origin === null ? locateRecitation(index, heard, { hintPage: displayPage }) : null;
        const start = origin ?? location?.start;
        if (start === undefined || start === null) continue;
        const result = followFrom(index, start, heard.slice(origin === null ? location.heard : heardBase), passageStart ?? start);
        const score = (result.end - start) * 10 - (result.blocked ? 1 : 0);
        if (score > bestScore) { bestScore = score; best = candidate; }
      }
      return best;
    },
    nextSegment() { if (origin !== null) origin = cursor; heardBase = 0; segmentNumber++; pendingKey = null; pendingPasses = 0; },
    update(transcript, { final = false, settled = false } = {}) {
      const heard = tokenize(transcript);
      if (!heard.length) return render([], { waitingForStart: origin === null });
      if (origin === null) {
        let location = locateRecitation(index, heard, { hintPage: displayPage });
        if (!location) {
          // Fast feedback for the selected page while global identification
          // waits for a distinctive phrase. Never change page on one word.
          const candidates = [resume, index.pageStarts.get(displayPage)].filter(p => p !== null && p !== undefined && p >= 0);
          const local = candidates.find(p => matchAt(index.tokens, heard, p, 0));
          if (local !== undefined) {
            const partial = followFrom(index, local, heard);
            return render(partial.matches, { preview: true });
          }
          const localAyah = locateRecitation(index, heard, { hintPage: displayPage, minWords: 2 });
          if (localAyah?.page === displayPage) {
            return render(followFrom(index, localAyah.start, heard.slice(localAyah.heard)).matches, { preview: true });
          }
          return render([], { waitingForStart: true });
        }
        origin = location.start; passageStart = origin; heardBase = location.heard; cursor = origin;
      }
      const result = followFrom(index, origin, heard.slice(heardBase), passageStart);
      // Shorter interim revisions do not undo progress or clear an existing
      // error. A correction must actually reach the stopped word.
      if (result.end >= cursor) {
        pending = result.blocked;
        if (settled && result.blocked) {
          const key = `${result.end}:${heard[heardBase + result.mismatch.heard]?.norm}`;
          pendingPasses = key === pendingKey ? pendingPasses + 1 : 1;
          pendingKey = key;
        } else if (!result.blocked) { pendingKey = null; pendingPasses = 0; }
        // Whisper batches are complete hypotheses, but one batch can still
        // hallucinate. Require the same stopped word in two independent checks.
        if (result.blocked && (final || (settled && pendingPasses >= 2)) && index.tokens[result.end]) {
          blocked = true;
          const token = index.tokens[result.end];
          const mismatch = result.mismatch;
          let missing = false;
          if (mismatch) {
            let e = result.end + 1, h = heardBase + mismatch.heard;
            while (e < index.tokens.length && h < heard.length) {
              const step = matchAt(index.tokens, heard, e, h);
              if (!step) break;
              e += step[0]; h += step[1];
            }
            missing = e - result.end - 1 >= 2;
          }
          issue = {
            id: `${segmentNumber}:${result.end}`, kind: missing ? 'missing' : 'unclear', evidence: 'transcript',
            expected: token.text, heard: heard.slice(heardBase + (mismatch?.heard ?? 0)).map(word => word.display).join(' '),
            page: token.page, glyph: token.glyph, surah: token.surah, ayah: token.ayah,
          };
        } else if (!result.blocked && (result.end > cursor || final)) { blocked = false; issue = null; }
      }
      return { ...render(result.matches), segment: segmentNumber };
    },
  };
}
