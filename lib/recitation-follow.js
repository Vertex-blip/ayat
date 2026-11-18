import { tokenize, withoutOpeningInvocation } from './align.js?v=f01423c02eba';
import { spokenForms, matchSpokenWords } from './live-progress.js?v=f01423c02eba';

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
        // The opening initials يٓسٓ are also transcribed as the spoken names يا سين.
        if (surah === 36 && ayah === 1 && token.norm === 'يس') forms.add('ياسين');
        // Modern Arabic writes the Quran's name with alif madda: قرءان → قرآن.
        const modern = token.norm.replace(/قرءان([اه]?)$/, 'قران$1');
        if (modern !== token.norm) forms.add(modern);
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
  const recitation = withoutOpeningInvocation(heard);
  const found = locateHeard(index, recitation, { hintPage, minWords });
  if (!found) return null;
  const openingLength = heard.length - recitation.length;
  return { ...found, heard: found.heard + openingLength, heardEnd: found.heardEnd + openingLength };
}

function locateHeard(index, heard, { hintPage, minWords }) {
  const found = new Map();
  let invocationEnd = 0;
  for (let h = 0; h < heard.length; h++) {
    if (h < invocationEnd) continue;
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
      const words = heard.slice(h, hi);
      const phrase = words.map(word => word.norm).join('');
      if ('بسماللهالرحمنالرحيم'.includes(phrase)) continue;
      const recitation = withoutOpeningInvocation(words);
      if (recitation !== words) {
        // An unrecognized opener can leave a recognizable suffix in the
        // transcript. Later search offsets still belong to that invocation.
        invocationEnd = Math.max(invocationEnd, hi - recitation.length);
        continue;
      }
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

function exactRun(tokens, heard, start, heardStart) {
  let end = start, heardEnd = heardStart, letters = 0;
  const surah = tokens[start]?.surah;
  while (end < tokens.length && tokens[end].surah === surah && heardEnd < heard.length) {
    const step = matchAt(tokens, heard, end, heardEnd);
    if (!step || tokens[end + step[0] - 1].surah !== surah) break;
    for (let i = 0; i < step[1]; i++) letters += heard[heardEnd + i].norm.length;
    end += step[0]; heardEnd += step[1];
  }
  return { start, end, heardEnd, length: end - start, letters };
}

function findReread(tokens, heard, next, h, passageStart) {
  const previousSurah = tokens[Math.max(passageStart, next - 1)]?.surah;
  let best = null, tied = false;
  for (let start = Math.max(0, next - 16); start < next; start++) {
    if (tokens[start].surah !== previousSurah) continue;
    const run = exactRun(tokens, heard, start, h);
    const beforeStart = start < passageStart;
    const previousAyah = beforeStart && tokens[start].ayah !== tokens[passageStart].ayah;
    if (run.length < (previousAyah ? 3 : 2) || run.letters < (previousAyah ? 9 : beforeStart ? 6 : 4)) continue;
    if (!best || run.length > best.length) { best = run; tied = false; }
    else if (run.length === best.length) tied = true;
  }
  return tied ? null : best;
}

function findContinuation(tokens, heard, next, h, { partial = false } = {}) {
  const surah = tokens[next]?.surah;
  if (!surah || tokens[next + 1]?.surah !== surah) return null;
  for (let offset = h; offset <= h + 1 && offset < heard.length; offset++) {
    const run = exactRun(tokens, heard, next + 1, offset);
    if (partial) {
      if (run.length && run.length <= 2 && run.heardEnd === heard.length) return run;
    } else if (run.length >= 2 && run.letters >= 6) return { offset, skip: 1, length: run.length };
    else if (run.length && tokens[run.end + 1]?.surah === surah) {
      // Keep a short exact word between two unclear words if the phrase
      // following it confirms both recovery points.
      const after = strongRun(tokens, heard, run.end + 1, run.heardEnd, 1);
      if (after) return { offset, skip: 1, length: run.length + after.length };
    }
  }
  if (partial || tokens[next + 2]?.surah !== surah) return null;
  const after = strongRun(tokens, heard, next + 2, h, 2);
  return after && { ...after, skip: 2 };
}

function strongRun(tokens, heard, start, first, maxUnmatched) {
  let best = null, tied = false;
  for (let offset = first; offset <= first + maxUnmatched && offset < heard.length; offset++) {
    const run = exactRun(tokens, heard, start, offset);
    if (run.length < 3 || run.letters < 10) continue;
    if (!best || run.length > best.length) { best = { offset, length: run.length }; tied = false; }
    else if (run.length === best.length) tied = true;
  }
  return tied ? null : best;
}

// Track the location of the speech separately from the furthest reached word.
// A nearby gap can be passed if an exact following phrase establishes where
// the reader is. Its word stays unconfirmed until it is heard on a reread.
function followFrom(index, start, heard, passageStart = start, segmentNext = start) {
  const tokens = index.tokens;
  let end = start, next = segmentNext, h = 0, tracking = null, mismatch = null;
  const matches = new Set(), gaps = new Map();
  while (h < heard.length) {
    const token = tokens[next];
    if (token && next > 0 && token.surah !== tokens[next - 1].surah && token.surah !== 9) {
      const invocation = 'بسماللهالرحمنالرحيم';
      let phrase = '', offset = h;
      while (offset < heard.length && invocation.startsWith(phrase + heard[offset].norm)) { phrase += heard[offset].norm; offset++; }
      if (phrase === invocation || (phrase && offset === heard.length)) { h = offset; continue; }
    }
    const step = matchAt(tokens, heard, next, h);
    if (step) {
      for (let i = 0; i < step[0]; i++) { matches.add(next + i); gaps.delete(next + i); }
      next += step[0]; h += step[1]; end = Math.max(end, next); tracking = next - 1; mismatch = null;
      continue;
    }
    const reread = findReread(tokens, heard, next, h, passageStart);
    const continuation = findContinuation(tokens, heard, next, h);
    if (reread && (!continuation || reread.length > continuation.length)) {
      next = reread.start;
      continue;
    }
    if (continuation && (!reread || continuation.length > reread.length)) {
      const first = mismatch?.heard ?? h;
      const missing = first === continuation.offset;
      const difference = heard.slice(first, missing ? undefined : continuation.offset).map(word => word.display).join(' ');
      for (let i = 0; i < continuation.skip; i++) gaps.set(next + i, { kind: missing ? 'missing' : 'unclear', heard: difference });
      next += continuation.skip;
      h = continuation.offset;
      continue;
    }
    if (token && !mismatch) mismatch = { heard: h };
    h++;
  }
  return { matches, gaps, end, next, tracking, blocked: Boolean(mismatch), mismatch };
}

export function createQuranFollower(index, { page = 1, startGlyph = null } = {}) {
  let origin = null, passageStart = null, heardBase = 0, cursor = null, displayPage = page;
  let continuesPassage = false, carry = [], recoveryTail = [], unlocatedFinal = [], finalState = null;
  let openingPrefix = [], unlocatedOpening = [], openingOnly = false;
  let segmentNumber = 0, blocked = false, issue = null, pending = false, pendingKey = null, pendingPasses = 0;
  let tracking = null, next = null;
  let segmentEntry = { page, blocked: false, issue: null, tracking, next };
  const matched = new Set();
  const committedGaps = new Map();
  let segmentMatches = new Set(), gapIssues = new Map(), settledGaps = new Map();
  // Resume is only a hint. Every new microphone press can locate a different
  // passage; it is not pinned forever to the previous page's next word.
  const resume = startGlyph === null ? null : index.tokens.findIndex(t => t.page === page && t.glyph === startGlyph);
  const localStarts = [resume, index.pageStarts.get(page)].filter(p => p !== null && p !== undefined && p >= 0);

  function findStart(heard, minWords = 3) {
    return locateHeard(index, heard, { hintPage: page, minWords });
  }

  function locateStart(heard) {
    const location = findStart(heard);
    if (location && location.heard > 0) {
      // A distinctive suffix cannot hide a mismatch after a supported start
      // at the selected page or saved position.
      const prefix = findStart(heard, 2);
      if (prefix && prefix.heard < location.heard && localStarts.includes(prefix.start)) return prefix;
    }
    return location;
  }

  function render(previewMatches = new Set(), { waitingForStart = false } = {}) {
    const visible = new Set([...matched, ...segmentMatches, ...previewMatches]);
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
    matchedGlyphs.sort((a, b) => a - b);
    const expected = index.tokens[next];
    const pendingGlyph = (blocked || pending) && expected?.page === displayPage ? expected.glyph : null;
    const last = index.tokens[Array.from(previewMatches).at(-1) ?? tracking];
    const trackingGlyph = last?.page === displayPage ? last.glyph : null;
    const uncertainGlyphs = new Set();
    if (blocked && pendingGlyph !== null) uncertainGlyphs.add(pendingGlyph);
    for (const item of gapIssues.values()) {
      if (item.page === displayPage) uncertainGlyphs.add(item.glyph);
    }
    const issues = [...new Map([...gapIssues.values(), ...(issue ? [issue] : [])].map(item => [item.id, item])).values()];
    const first = index.tokens[passageStart ?? previewMatches.values().next().value];
    return { page: displayPage, progress: {
      matchedGlyphs,
      uncertainGlyphs: [...uncertainGlyphs].sort((a, b) => a - b),
      confirmedGlyphs: matchedGlyphs.length ? matchedGlyphs.at(-1) + 1 : 0,
      confirmed: matchedGlyphs.length, revealedFrom: 0, total: index.pageWords.get(displayPage),
      waitingForStart, openingOnly: origin === null && openingOnly, blocked,
      prefillBeforeGlyph: first?.page === displayPage ? first.glyph : 0,
      pending, issue: issue ?? issues.at(-1) ?? null, issues, pendingGlyph, trackingGlyph,
      lastMatchedGlyph: matchedGlyphs.at(-1) ?? null,
      currentGlyph: pendingGlyph ?? trackingGlyph,
      blockedAt: blocked && expected ? { surah: expected.surah, ayah: expected.ayah } : null,
    } };
  }

  function heardOffset(heard) {
    if (continuesPassage || matchAt(index.tokens, heard, origin, heardBase)) return heardBase;
    return heard.findIndex((_, h) => matchAt(index.tokens, heard, origin, h));
  }

  function openingLength(heard, offset) {
    let e = origin, h = offset;
    while (e - origin < 3) {
      const match = matchAt(index.tokens, heard, e, h);
      if (!match) break;
      e += match[0]; h += match[1];
    }
    return e - origin;
  }

  function reviseStart(heard) {
    if (continuesPassage) return;
    const offset = heardOffset(heard);
    let other;
    if (offset !== -1) {
      heardBase = offset;
    }
    if (finalState) return;
    if (offset !== -1) {
      const opening = openingLength(heard, offset);
      if (opening >= 3) return;
      other = locateStart(heard);
      if (!other || other.start === origin || (other.heard > offset && opening >= 2)) return;
    }
    origin = null; passageStart = null; cursor = null; displayPage = segmentEntry.page;
    tracking = segmentEntry.tracking; next = segmentEntry.next; segmentMatches = new Set(); gapIssues = new Map(committedGaps);
    recoveryTail = [];
    settledGaps = new Map();
    blocked = segmentEntry.blocked; issue = segmentEntry.issue;
    pending = false; pendingKey = null; pendingPasses = 0;
    return other;
  }

  function transcriptIssue(result, heard) {
    if (result.next === segmentEntry.next && segmentEntry.issue) return segmentEntry.issue;
    const start = result.mismatch.heard;
    const omission = exactRun(index.tokens, heard, result.next + 1, start);
    return makeIssue(result.next, {
      kind: omission.length >= 2 ? 'missing' : 'unclear',
      heard: heard.slice(start).map(word => word.display).join(' '),
    });
  }

  function makeIssue(position, { kind, heard }, alertable = false) {
    const token = index.tokens[position];
    return {
      id: `${token.page}:${token.glyph}`, kind, evidence: 'transcript', alertable,
      expected: token.text, heard,
      page: token.page, glyph: token.glyph, surah: token.surah, ayah: token.ayah,
    };
  }

  function audioOverlapLength(heard, expectedStart) {
    // A hard audio cut can replay the end of the previous clip. Only consume
    // an exact leading suffix ending before the next unread word.
    if (matchAt(index.tokens, heard, expectedStart, 0)) return 0;
    for (let start = Math.max(0, expectedStart - 4); start < expectedStart; start++) {
      let e = start, h = 0;
      while (e < expectedStart && h < heard.length) {
        const match = matchAt(index.tokens, heard, e, h);
        if (!match || e + match[0] > expectedStart) break;
        if (index.tokens.slice(e, e + match[0]).some((_, i) => !matched.has(e + i))) break;
        e += match[0]; h += match[1];
      }
      if (e === expectedStart) return h;
    }
    return 0;
  }

  function trimAudioOverlap(heard, expectedStart) {
    const confirmed = audioOverlapLength(heard, expectedStart);
    if (!carry.length) return confirmed;
    const partial = findContinuation(index.tokens, carry, expectedStart, 0, { partial: true });
    if (!partial || matchAt(index.tokens, heard, partial.end, confirmed)) return confirmed;
    // Only remove an unrecognized overlap word when two exact new words
    // bridge the previously heard tail to this audio segment.
    const after = exactRun(index.tokens, heard, partial.end, confirmed + 1);
    return after.length >= 2 && after.letters >= 6 ? confirmed + 1 : confirmed;
  }

  function update(transcript, { final = false, settled = false, overlap = false } = {}) {
    const incoming = tokenize(transcript);
    const raw = [...openingPrefix, ...carry, ...incoming];
    const heard = continuesPassage ? raw : withoutOpeningInvocation(raw);
    openingOnly = raw.length > 0 && !heard.length;
    if (!heard.length && !final) return render([], { waitingForStart: origin === null });
    const revisedStart = final && origin !== null ? reviseStart(heard) : undefined;
    if (origin === null) {
      if (final) {
        unlocatedFinal = heard.slice(-8);
        // Remember a split opening only for detecting the rest of the formula.
        // It does not enter the unlocated Quran words used for passage matching.
        unlocatedOpening = openingOnly ? raw.slice(-8) : [];
      }
      const location = revisedStart ?? locateStart(heard);
      if (!location) {
        // Show the selected page while enough speech arrives to fix the start.
        const local = localStarts.find(p => matchAt(index.tokens, heard, p, 0));
        if (local !== undefined) {
          const partial = followFrom(index, local, heard);
          if (!partial.blocked || partial.end - local >= 2) return render(partial.matches);
        }
        const localAyah = findStart(heard, 2);
        if (localAyah?.page === page) return render(followFrom(index, localAyah.start, heard.slice(localAyah.heard)).matches);
        return render([], { waitingForStart: true });
      }
      origin = location.start; passageStart = origin; heardBase = location.heard; cursor = origin;
    }
    const expectedStart = segmentEntry.next ?? origin;
    const segmentHeard = overlap && continuesPassage
      ? [...carry, ...incoming.slice(trimAudioOverlap(incoming, expectedStart))]
      : heard.slice(heardBase);
    const result = followFrom(index, origin, segmentHeard, passageStart, expectedStart);
    if (final && result.end === origin && !result.matches.size && finalState) {
      // A completely unrelated final hypothesis cannot replace the earlier
      // verified start or preserve a more recent interim tail.
      ({ cursor, displayPage, blocked, issue, tracking, next, segmentMatches, gapIssues, recoveryTail } = finalState);
      pending = false; pendingKey = null; pendingPasses = 0;
      return { ...render(), segment: segmentNumber };
    }
    // Only the current segment can be revised. The provider's final text
    // replaces partial hypotheses, including any words added prematurely.
    if (final || result.end >= cursor) {
      if (result.next !== next) {
        blocked = segmentEntry.blocked && result.next === expectedStart && result.tracking === null;
        issue = blocked ? segmentEntry.issue : null;
        pendingKey = null; pendingPasses = 0;
      }
      pending = result.blocked;
      if (settled && result.blocked) {
        const key = `${result.next}:${segmentHeard[result.mismatch.heard]?.norm}`;
        pendingPasses = key === pendingKey ? pendingPasses + 1 : 1;
        pendingKey = key;
      } else if (!result.blocked) { pendingKey = null; pendingPasses = 0; }
      const incomplete = result.blocked && findContinuation(index.tokens, segmentHeard, result.next, result.mismatch.heard, { partial: true });
      recoveryTail = incomplete ? segmentHeard.slice(result.mismatch.heard) : [];
      // Whisper batches are complete hypotheses, but one batch can still
      // hallucinate. Require the same stopped word in two independent checks.
      if (result.blocked && (final || (settled && pendingPasses >= 2)) && index.tokens[result.next]) {
        blocked = true;
        issue = transcriptIssue(result, segmentHeard);
      } else if (!result.blocked && result.tracking !== null) { blocked = false; issue = null; }
      const latestGaps = new Map();
      segmentMatches = result.matches;
      gapIssues = new Map(committedGaps);
      for (const position of segmentMatches) gapIssues.delete(position);
      for (const [position, gap] of result.gaps) {
        const key = gap.kind === 'missing' ? gap.kind : tokenize(gap.heard).map(word => word.norm).join(' ');
        const count = settledGaps.get(position)?.key === key ? settledGaps.get(position).count + 1 : 1;
        if (settled) latestGaps.set(position, { key, count });
        const old = committedGaps.get(position) ?? finalState?.gapIssues.get(position);
        gapIssues.set(position, old?.alertable ? old : makeIssue(position, gap, final || (settled && count >= 2)));
      }
      settledGaps = latestGaps;
      cursor = result.end;
      next = result.next;
      tracking = result.tracking ?? segmentEntry.tracking;
      displayPage = index.tokens[tracking]?.page ?? segmentEntry.page;
      if (final) finalState = { cursor, displayPage, blocked, issue, tracking, next, segmentMatches, gapIssues, recoveryTail };
    }
    return { ...render(), segment: segmentNumber };
  }

  return {
    // Evaluate only alternatives actually supplied by the speech service.
    // This never invents expected words or changes the saved position.
    selectTranscript(candidates) {
      let best = candidates[0], bestScore = -Infinity;
      for (const candidate of candidates) {
        const raw = [...openingPrefix, ...carry, ...tokenize(candidate)];
        const heard = continuesPassage ? raw : withoutOpeningInvocation(raw);
        const location = origin === null ? locateStart(heard) : null;
        const start = origin ?? location?.start;
        if (start === undefined || start === null) continue;
        const offset = location?.heard ?? heardOffset(heard);
        if (offset < 0) continue;
        const result = followFrom(index, start, heard.slice(offset), passageStart ?? start, segmentEntry.next ?? start);
        let forwardMatches = 0;
        for (const position of result.matches) if (position >= start) forwardMatches++;
        const score = forwardMatches * 10 + (result.matches.size - forwardMatches) - result.gaps.size * 2 - (result.blocked ? 1 : 0);
        if (score > bestScore) { bestScore = score; best = candidate; }
      }
      return best;
    },
    nextSegment({ finalTranscript } = {}) {
      // Native speech services can end with an unconfirmed interim tail.
      const result = finalTranscript === undefined ? null : update(finalTranscript, { final: true });
      if (origin !== null) {
        for (const position of segmentMatches) matched.add(position);
        committedGaps.clear();
        for (const [position, gap] of gapIssues) committedGaps.set(position, gap);
        origin = cursor;
        continuesPassage = true;
        openingPrefix = [];
        carry = recoveryTail;
      } else {
        openingPrefix = unlocatedOpening;
        carry = unlocatedFinal;
      }
      unlocatedOpening = []; unlocatedFinal = []; recoveryTail = []; finalState = null;
      heardBase = 0; segmentNumber++; pending = false; pendingKey = null; pendingPasses = 0;
      segmentMatches = new Set(); settledGaps = new Map();
      segmentEntry = { page: displayPage, blocked, issue, tracking, next };
      return { ...(origin === null && result ? result : render([], { waitingForStart: origin === null })), segment: segmentNumber };
    },
    update,
  };
}
