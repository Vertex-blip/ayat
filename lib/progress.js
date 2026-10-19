import { tokenize } from './align.js';

// Only a consecutive reading may reveal text. A mismatched word keeps the
// cursor at the same Quran word until that word is heard again.
export function sequentialProgress(expectedText, heardText, { allowBasmala = false } = {}) {
  const expected = tokenize(expectedText);
  const heard = tokenize(heardText);
  const basmala = tokenize('بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ');
  let confirmed = 0;
  let blocked = false;
  let heardAtBlock = '';
  for (let j = 0; j < heard.length; j += 1) {
    if (allowBasmala && basmala.every((word, i) => heard[j + i]?.norm === word.norm)) {
      j += basmala.length - 1;
      continue;
    }
    const word = heard[j];
    if (confirmed >= expected.length) break;
    if (word.norm === expected[confirmed].norm) {
      confirmed += 1;
      blocked = false;
      heardAtBlock = '';
    } else {
      blocked = true;
      heardAtBlock = word.display;
    }
  }
  return { confirmed, blocked, heardAtBlock, total: expected.length };
}

// QPC occasionally prints two spoken words as one glyph. Reveal a glyph only
// after every spoken word represented by that glyph has been confirmed.
export function glyphsConfirmed(words, confirmedTokens) {
  let spoken = 0;
  let glyphs = 0;
  for (const word of words) {
    spoken += tokenize(word.text).length;
    if (spoken > confirmedTokens) break;
    glyphs += 1;
  }
  return glyphs;
}
