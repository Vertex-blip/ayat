import { normalizeWord, tokenize } from './align.js';
import { glyphsConfirmed } from './progress.js';

export function spokenForms(text) {
  return new Set([normalizeWord(text), normalizeWord(text.replace(/\u0670/g, 'ا'))]);
}

// Compare written forms only. In Uthmani text a dagger alif can be written as
// a full alif by a general speech service (مَٰلِكِ → مالك, ٱلۡعَٰلَمِينَ → العالمين).
// This does not evaluate pronunciation, vowels, or tajweed.
function tokenMatch(expected, heard) { return expected?.forms.has(heard?.norm); }
function step(expected, heard, e, h) {
  if (tokenMatch(expected[e], heard[h])) return { expected: 1, heard: 1 };
  if (expected[e + 1] && heard[h]) {
    for (const a of expected[e].forms) for (const b of expected[e + 1].forms) {
      if (a + b === heard[h].norm) return { expected: 2, heard: 1 };
    }
  }
  if (heard[h + 1] && expected[e]?.forms.has(heard[h].norm + heard[h + 1].norm)) return { expected: 1, heard: 2 };
  return null;
}

export function createLiveProgress(words, { startGlyph = null, allowBasmala = false } = {}) {
  const expected = [];
  const ayahStarts = [];
  const glyphStarts = [];
  let previousVerse;
  for (const [glyph, word] of words.entries()) {
    glyphStarts.push(expected.length);
    const verse = `${word.surah}:${word.ayah}`;
    if (glyph === 0 || verse !== previousVerse) ayahStarts.push(expected.length);
    previousVerse = verse;
    for (const token of tokenize(word.text)) expected.push({ ...token, forms: spokenForms(token.display) });
  }
  glyphStarts.push(expected.length);
  let segmentStart = startGlyph === null ? null : glyphStarts[startGlyph];
  let heardStart = 0;
  let cursor = segmentStart ?? 0;
  let located = segmentStart !== null;

  function locate(heard) {
    // Starting at the page's first word needs no look-ahead. Other starts must
    // match two consecutive words at one unambiguous ayah boundary.
    if (tokenMatch(expected[0], heard[0])) return { expected: 0, heard: 0 };
    const candidates = [];
    for (let h = 0; h < Math.min(heard.length, 12); h++) {
      for (const e of ayahStarts) {
        let ei = e, hi = h;
        while (ei < expected.length && hi < heard.length && ei - e < 4) {
          const match = step(expected, heard, ei, hi);
          if (!match) break;
          ei += match.expected; hi += match.heard;
        }
        if (ei - e >= 2) candidates.push({ expected: e, heard: h, matched: ei - e });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.matched - a.matched || a.heard - b.heard);
    const best = candidates[0];
    if (candidates.some(c => c.expected !== best.expected && c.matched === best.matched && c.heard === best.heard)) return null;
    return best;
  }

  return {
    // A restarted recognition service starts a new transcript. Continue at the
    // word already reached rather than trying to rematch missing earlier audio.
    nextSegment() { segmentStart = located ? cursor : null; heardStart = 0; },
    update(transcript, { final = false } = {}) {
      const heard = tokenize(transcript);
      if (segmentStart === null) {
        const found = locate(heard);
        if (!found) return { confirmed: cursor, confirmedGlyphs: glyphsConfirmed(words, cursor), revealedFrom: 0, blocked: false, waitingForStart: true, total: expected.length };
        segmentStart = found.expected; heardStart = found.heard; cursor = segmentStart; located = true;
      }
      let e = segmentStart, h = heardStart;
      let blocked = false, heardAtBlock = '';
      const basmala = ['بسم', 'الله', 'الرحمن', 'الرحيم'];
      while (e < expected.length && h < heard.length) {
        // Separate printed basmalas do not consume ayah word positions.
        if (allowBasmala && basmala.every((word, i) => heard[h + i]?.norm === word)) { h += 4; continue; }
        const match = step(expected, heard, e, h);
        if (match) { e += match.expected; h += match.heard; blocked = false; heardAtBlock = ''; }
        else {
          // Rereading an already reached ayah is allowed, but it never moves
          // the cursor past the next unread word.
          let repeatEnd = h;
          for (const start of ayahStarts.filter(start => start >= segmentStart && start < e)) {
            let re = start, rh = h;
            while (re < e && rh < heard.length) {
              const repeated = step(expected, heard, re, rh);
              if (!repeated || re + repeated.expected > e) break;
              re += repeated.expected; rh += repeated.heard;
            }
            if (re - start >= 2) repeatEnd = Math.max(repeatEnd, rh);
          }
          if (repeatEnd > h) { h = repeatEnd; blocked = false; heardAtBlock = ''; }
          else { blocked = true; heardAtBlock = heard[h].display; h++; }
        }
      }
      // Interim text can be revised backwards by Safari. Keep the last reached
      // position, and never jump over an expected word to match a later ayah.
      const olderRevision = e < cursor;
      cursor = Math.max(cursor, e);
      return {
        confirmed: cursor, confirmedGlyphs: glyphsConfirmed(words, cursor),
        revealedFrom: glyphsConfirmed(words, segmentStart),
        blocked: final && !olderRevision && blocked && cursor < expected.length,
        heardAtBlock, waitingForStart: false, total: expected.length,
      };
    },
  };
}
