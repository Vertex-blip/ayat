import { normalizeWord, tokenize, withoutOpeningInvocation } from './align.js?v=f01423c02eba';

export function spokenForms(text) {
  const forms = [text, text.replace(/\u0670/g, 'ا'), text.replace(/[وي]\u0670/g, 'ا').replace(/\u0670/g, 'ا')]
    .map(normalizeWord);
  return new Set(forms.flatMap(form => [form, form.replace(/^ءا/, 'ا'), form.replace(/ة$/, 'ه')]));
}

// Compare written forms only. In Uthmani text a dagger alif can be written as
// a full alif by a general speech service (مَٰلِكِ → مالك, ٱلۡعَٰلَمِينَ → العالمين).
// This does not evaluate pronunciation, vowels, or tajweed.
function tokenMatch(expected, heard) { return expected?.forms.has(heard?.norm); }
export function matchSpokenWords(expected, heard, e, h) {
  if (!expected[e] || !heard[h]) return null;
  if (tokenMatch(expected[e], heard[h])) return { expected: 1, heard: 1 };
  let joined = new Set(['']);
  for (let count = 1; count <= 3 && expected[e + count - 1]; count++) {
    joined = new Set([...joined].flatMap(prefix => [...expected[e + count - 1].forms].map(form => prefix + form)));
    if (count > 1 && joined.has(heard[h].norm)) return { expected: count, heard: 1 };
  }
  let phrase = heard[h].norm;
  for (let count = 2; count <= 3 && heard[h + count - 1]; count++) {
    phrase += heard[h + count - 1].norm;
    if (expected[e].forms.has(phrase)) return { expected: 1, heard: count };
  }
  // Speech services can move a boundary without changing a letter:
  // دنا فتدلى → دناف تدلى. Compare short phrases, preserving every letter
  // and the word order. A changed letter still counts as a difference.
  joined = new Set(['']);
  for (let ec = 1; ec <= 3 && expected[e + ec - 1]; ec++) {
    joined = new Set([...joined].flatMap(prefix => [...expected[e + ec - 1].forms].map(form => prefix + form)));
    if (ec < 2) continue;
    let heardPhrase = heard[h].norm;
    for (let hc = 2; hc <= 3 && heard[h + hc - 1]; hc++) {
      heardPhrase += heard[h + hc - 1].norm;
      if (joined.has(heardPhrase)) return { expected: ec, heard: hc };
    }
  }
  return null;
}
const step = matchSpokenWords;

export function createLiveProgress(words, { page = null, startGlyph = null, allowBasmala = false } = {}) {
  const expected = [];
  const ayahStarts = new Set();
  const glyphStarts = [];
  let previousVerse;
  for (const [glyph, word] of words.entries()) {
    glyphStarts.push(expected.length);
    const verse = `${word.surah}:${word.ayah}`;
    if (glyph === 0 || verse !== previousVerse) ayahStarts.add(expected.length);
    previousVerse = verse;
    for (const token of tokenize(word.text)) {
      expected.push({ ...token, glyph, surah: word.surah, ayah: word.ayah, forms: spokenForms(token.display) });
    }
  }
  glyphStarts.push(expected.length);
  let segmentStart = glyphStarts[startGlyph] ?? null;
  let heardStart = 0;
  let committed = { matched: new Set(), issues: new Map(), end: segmentStart ?? 0, next: segmentStart, tracking: null, pending: null };
  let current = committed, finalized = null, settledGaps = new Set(), overlapTail = null;

  function matchRun(heard, from, at, until, surah) {
    let e = from, h = at, letters = 0;
    while (e < until && expected[e]?.surah === surah && heard[h]) {
      const match = step(expected, heard, e, h);
      if (!match || e + match.expected > until || expected[e + match.expected - 1].surah !== surah) break;
      for (let i = 0; i < match.expected; i++) letters += expected[e + i].norm.length;
      e += match.expected; h += match.heard;
    }
    return { e, h, letters };
  }

  function truncatedRun(position, heard) {
    if (heard.length < 1 || heard.length > 5) return null;
    const from = position + 1;
    for (let i = 0; i < 2; i++) {
      const run = matchRun(heard, from, i, from + 2, expected[position].surah);
      if (run.e > from && run.h === heard.length) return { heard, next: run.e };
    }
    return null;
  }

  function withOverlapTail(heard) {
    if (!overlapTail || !heard.length || step(expected, heard, segmentStart, 0)) return heard;
    const { next } = overlapTail;
    if (step(expected, heard, next, 0)) return [...overlapTail.heard, ...heard];
    const run = matchRun(heard, next, 1, next + 4, expected[segmentStart]?.surah);
    return run.e - next >= 2 && run.letters >= 6 ? [...overlapTail.heard, ...heard.slice(1)] : heard;
  }

  function locate(heard) {
    // Starting at the page's first word needs no look-ahead. Other starts must
    // match an unambiguous run, with more context inside an ayah.
    if (!heard.length) return null;
    if (step(expected, heard, 0, 0)) return { expected: 0, heard: 0 };
    const candidates = [];
    for (let h = 0; h < Math.min(heard.length, 12); h++) {
      const remaining = heard.slice(h);
      if (withoutOpeningInvocation(remaining) !== remaining) continue;
      for (let e = 0; e < expected.length; e++) {
        const run = matchRun(heard, e, h, Math.min(expected.length, e + 4), expected[e].surah);
        const matched = run.e - e;
        if (matched >= (ayahStarts.has(e) ? 2 : 3)) candidates.push({ expected: e, heard: h, matched });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.matched - a.matched || a.heard - b.heard);
    const best = candidates[0];
    if (candidates.some(c => c.expected !== best.expected && c.matched === best.matched && c.heard === best.heard)) return null;
    return best;
  }

  function rewind(heard, e, h) {
    const surah = expected[e - 1]?.surah;
    let best = null, tied = false;
    for (let from = e - 2; from >= Math.max(0, e - 16); from--) {
      if (expected[from].surah !== surah) continue;
      const run = matchRun(heard, from, h, e, surah);
      const length = run.e - from;
      if (length < 2 || run.letters < 4) continue;
      if (!best || length > best.length) { best = { ...run, from, length }; tied = false; }
      else if (length === best.length) tied = true;
    }
    return tied ? null : best;
  }

  function finding(token, text, alertable) {
    const { glyph, surah, ayah } = expected[token];
    return { id: `${page}:${glyph}`, evidence: 'transcript', kind: text ? 'unclear' : 'missing',
      expected: words[glyph].text, heard: text, page, glyph, surah, ayah, alertable };
  }

  function follow(heard, start, heardAt, { final = false, settled = false } = {}) {
    const matched = new Set(committed.matched), issues = new Map(committed.issues);
    const gaps = new Set();
    let e = start, h = heardAt, end = Math.max(start, committed.end), tracking = committed.tracking, pending = null;
    const basmala = ['بسم', 'الله', 'الرحمن', 'الرحيم'];
    function addMatches(from, to) {
      for (let token = from; token < to; token++) {
        matched.add(token);
        issues.delete(token);
      }
      tracking = to - 1;
      end = Math.max(end, to);
      pending = null;
    }
    while (h < heard.length) {
      if (allowBasmala && basmala.every((word, i) => heard[h + i]?.norm === word)) { h += 4; continue; }
      const match = step(expected, heard, e, h);
      if (match) {
        addMatches(e, e + match.expected);
        e += match.expected; h += match.heard;
        continue;
      }
      const repeated = rewind(heard, e, h);
      if (repeated) {
        addMatches(repeated.from, repeated.e);
        e = repeated.e; h = repeated.h;
        continue;
      }
      if (e >= expected.length) break;
      if (step(expected, heard, e, h + 1)) { h++; continue; }
      const surah = expected[e].surah;
      let gap = null;
      for (let next = h; next <= h + 1; next++) {
        const run = matchRun(heard, e + 1, next, Math.min(expected.length, e + 5), surah);
        if (run.e - e >= 3 && run.letters >= 6) { gap = { ...run, next }; break; }
      }
      if (gap) {
        const text = gap.next === h ? '' : heard[h].display;
        const key = `${e}:${normalizeWord(text)}`;
        gaps.add(key);
        const sameFinalGap = finalized?.result.gaps.has(key) && finalized.result.issues.get(e)?.alertable;
        issues.set(e, finding(e, text, Boolean(final || sameFinalGap || (settled && settledGaps.has(key)))));
        addMatches(e + 1, gap.e);
        e = gap.e; h = gap.h;
      } else {
        pending ??= { token: e, heard: heard[h].display, final, tail: final && heard.length - h <= 5 ? heard.slice(h) : [] };
        h++;
      }
    }
    return { matched, issues, end, next: e, tracking, pending, gaps };
  }

  function render(result) {
    const matchedGlyphs = [];
    for (let glyph = 0; glyph < words.length; glyph++) {
      const end = glyphStarts[glyph + 1];
      let token = glyphStarts[glyph];
      if (token === end) continue;
      while (token < end && result.matched.has(token)) token++;
      if (token === end) matchedGlyphs.push(glyph);
    }
    const issues = [...result.issues.values()];
    const pendingGlyph = result.pending ? expected[result.pending.token].glyph : null;
    const blocked = Boolean(result.pending?.final);
    const trackingGlyph = expected[result.tracking]?.glyph ?? null;
    const prefillBeforeGlyph = expected[result.matched.values().next().value]?.glyph ?? 0;
    let confirmedGlyphs = 0;
    while (confirmedGlyphs < words.length && glyphStarts[confirmedGlyphs + 1] <= result.end) confirmedGlyphs++;
    return {
      confirmed: result.end, confirmedGlyphs,
      revealedFrom: expected[segmentStart]?.glyph ?? confirmedGlyphs,
      total: expected.length, waitingForStart: segmentStart === null, openingOnly: false, prefillBeforeGlyph,
      matchedGlyphs, uncertainGlyphs: [...new Set(issues.map(issue => issue.glyph))],
      trackingGlyph, lastMatchedGlyph: matchedGlyphs.at(-1) ?? null, pendingGlyph, blocked,
      pending: Boolean(result.pending), heardAtBlock: result.pending?.heard ?? '',
      blockedAt: blocked ? expected[result.pending.token] : null,
      issues, issue: blocked ? finding(result.pending.token, result.pending.heard, false) : issues.at(-1) ?? null,
    };
  }

  function stripOpening(heard) {
    return committed.matched.size ? heard : withoutOpeningInvocation(heard);
  }

  function update(transcript, options = {}) {
    const raw = tokenize(transcript);
    let heard = stripOpening(raw);
    if (raw.length && !heard.length) {
      segmentStart = glyphStarts[startGlyph] ?? null; heardStart = 0;
      current = committed;
      if (options.final) finalized = { transcript, result: current };
      return { ...render(current), openingOnly: true };
    }
    if (segmentStart === null) {
      const found = locate(heard);
      if (!found) return render(committed);
      segmentStart = found.expected; heardStart = found.heard;
    }
    if (options.overlap) heard = withOverlapTail(heard);
    current = follow(heard, segmentStart, heardStart, options);
    if (options.final) finalized = { transcript, result: current };
    if (options.settled) settledGaps = current.gaps;
    return render(current);
  }

  return {
    update,
    selectTranscript(candidates) {
      let best = candidates[0], bestScore = -Infinity;
      for (const candidate of candidates) {
        const heard = stripOpening(tokenize(candidate));
        if (!heard.length) continue;
        const start = segmentStart === null ? locate(heard) : { expected: segmentStart, heard: heardStart };
        if (!start) continue;
        const result = follow(heard, start.expected, start.heard);
        const score = result.matched.size * 10 - result.issues.size * 2 - Boolean(result.pending);
        if (score > bestScore) { bestScore = score; best = candidate; }
      }
      return best;
    },
    nextSegment({ finalTranscript, recoverInterim = false } = {}) {
      if (finalTranscript && finalized?.transcript !== finalTranscript) update(finalTranscript, { final: true });
      // An interrupted provider can leave a recognizable phrase unfinished.
      // Keep a run of exact matches on automatic restart without promoting a gap.
      const retainedInterim = recoverInterim && !finalTranscript && current.gaps?.size === 0 &&
        !current.pending && current.matched.size >= committed.matched.size + 2;
      const result = finalTranscript === '' && !retainedInterim ? committed : finalized?.result ?? current;
      const located = startGlyph !== null || result.matched.size > 0;
      overlapTail = result.pending?.final ? truncatedRun(result.pending.token, result.pending.tail) : null;
      committed = { ...result, pending: null };
      segmentStart = located ? committed.next ?? committed.end : null;
      current = committed; finalized = null; heardStart = 0; settledGaps = new Set();
      return { ...render(committed), retainedInterim };
    },
  };
}
