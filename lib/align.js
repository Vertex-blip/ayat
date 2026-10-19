const MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF]/g;

export function normalizeWord(word) {
  return word
    .normalize('NFKC')
    .replace(MARKS, '')
    .replace(/\u0640/g, '')
    .replace(/[ٱآأإا]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ى/g, 'ي')
    .replace(/[^\u0621-\u064A]/g, '');
}

export function tokenize(text) {
  return String(text).split(/\s+/).map((display) => ({ display, norm: normalizeWord(display) })).filter((word) => word.norm);
}

// Standard edit-distance alignment, with a preference for matches when paths tie.
// The displayed Quran text is never changed; only normalized copies are scored.
export function alignWords(expectedText, heardText, { final = true } = {}) {
  const expected = tokenize(expectedText);
  const heard = tokenize(heardText);
  const rows = expected.length + 1;
  const cols = heard.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  const move = Array.from({ length: rows }, () => Array(cols).fill(''));
  for (let i = 1; i < rows; i += 1) { dp[i][0] = i; move[i][0] = 'missing'; }
  for (let j = 1; j < cols; j += 1) { dp[0][j] = j; move[0][j] = 'extra'; }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const same = expected[i - 1].norm === heard[j - 1].norm;
      const candidates = [
        { cost: dp[i - 1][j - 1] + (same ? 0 : 1), type: same ? 'correct' : 'wrong' },
        { cost: dp[i - 1][j] + 1, type: 'missing' },
        { cost: dp[i][j - 1] + 1, type: 'extra' },
      ];
      const best = candidates.reduce((a, b) => b.cost < a.cost ? b : a);
      dp[i][j] = best.cost;
      move[i][j] = best.type;
    }
  }

  // During recording, do not report words that may simply not have been read yet.
  // Find the target prefix best supported by the observed transcript.
  let end = final ? expected.length : 0;
  if (!final) {
    let score = Infinity;
    for (let i = 0; i <= expected.length; i += 1) {
      if (dp[i][heard.length] < score || (dp[i][heard.length] === score && i > end)) {
        score = dp[i][heard.length];
        end = i;
      }
    }
  }

  const words = expected.map((word, index) => ({ ...word, index, state: index < end ? 'missing' : 'pending', heard: '' }));
  const extras = [];
  let i = end;
  let j = heard.length;
  while (i > 0 || j > 0) {
    const type = move[i][j];
    if (type === 'correct' || type === 'wrong') {
      words[i - 1].state = type;
      words[i - 1].heard = heard[j - 1].display;
      i -= 1;
      j -= 1;
    } else if (type === 'missing') {
      i -= 1;
    } else {
      extras.unshift({ after: i - 1, text: heard[j - 1].display });
      j -= 1;
    }
  }
  return {
    words,
    extras,
    summary: {
      correct: words.filter((word) => word.state === 'correct').length,
      wrong: words.filter((word) => word.state === 'wrong').length,
      missing: words.filter((word) => word.state === 'missing').length,
      extra: extras.length,
    },
  };
}
