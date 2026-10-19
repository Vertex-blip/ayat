export function describeIssue(issue) {
  if (!issue) return null;
  return {
    title: 'Дауыс анық танылмады',
    detail: 'Бұл оқу қатесі деп есептелмейді. Асты сызылған сөзден қайта оқыңыз — тыңдау жалғасып тұр.',
    expected: issue.expected || '', heard: (issue.heard || '').split(/\s+/).slice(0, 8).join(' '),
    location: `${issue.surah}:${issue.ayah}`,
  };
}

// Transcription differences cannot establish a pronunciation error. Only an
// acoustic check may request error haptics, once per stopped word.
export function createRecitationHaptics({ vibrate, schedule = setTimeout, cancel = clearTimeout, delay = 700 }) {
  let timer = null, current = null, notified = null;
  return {
    update(issue, { enabled = true, active = true } = {}) {
      const key = enabled && active && issue?.evidence === 'acoustic' ? `${issue.page}:${issue.glyph}:${issue.surah}:${issue.ayah}` : null;
      if (key === current) return;
      if (timer !== null) cancel(timer);
      timer = null; current = key;
      if (!key) { notified = null; return; }
      if (key === notified) return;
      timer = schedule(() => {
        timer = null;
        if (current !== key) return;
        notified = key;
        try { vibrate?.([90, 70, 90]); } catch {}
      }, delay);
    },
  };
}

const maddRules = [
  [/mottasel.*pause|muttasil.*pause|متصل.*وقف/i, 'Мәд муттасыл (тоқтағанда)'],
  [/mottasel|muttas[ei]l|muttasil|متصل/i, 'Мәд муттасыл'],
  [/monfasel|munfas[ei]l|munfasil|منفصل/i, 'Мәд мунфасыл'],
  [/laz[ei]m|لازم/i, 'Мәд ләәзим'],
  [/aared|aarid|arid|عارض/i, 'Мәд аарид'],
  [/leen|linmadd|لين/i, 'Мәд лин'],
  [/normalmadd|normal madd|tab[ie]|طبيعي/i, 'Табиғи мәд'],
];
const vowelNames = new Map([['َ', 'фәтха («а»)'], ['ِ', 'кәсра («и»)'], ['ُ', 'дамма («у»)']]);
const lastVowel = text => vowelNames.get(String(text || '').at(-1));
const consonants = text => String(text || '').replace(/[^\u0621-\u064a\u0671]/g, '');

function phoneticObservation(item) {
  if (item.speechType === 'delete' || (!item.heard && item.expected)) return `Дыбыстық модель күтілген «${item.expected}» дыбысын танымады.`;
  if (item.speechType === 'insert' && !item.expected) return `Дыбыстық модель қосымша «${item.heard}» дыбысын таныды.`;
  if (item.expected && item.heard) return `Дыбыстық модель күтілген «${item.expected}» орнына «${item.heard}» нұсқасын таныды.`;
  return 'Дыбыстық модель оқу үлгісінен айырмашылық байқады; оның түрін нақты ажырата алмады.';
}

function explanation(title, observation, expected, correction) {
  return { title, observation, expected, correction, detail: `${observation} ${expected} ${correction}`.trim() };
}

export function describePhoneticIssue(item) {
  // Never infer a tajweed diagnosis from a phone's spelling or from the
  // presence of a written rule alone. These messages accompany acoustic data.
  if (item.evidence === 'transcript') return explanation('Дауыс анық танылмады', 'Сөз тану нәтижесінен тәжуид қатесін анықтау мүмкін емес.', '', 'Асты сызылған сөзді қайта оқыңыз.');
  const rules = [...(item.rules || []), ...(item.ruleDetails || []).flatMap(r => [r.id, r.name, r.arabic, r.tag])].filter(Boolean).join(' ');
  const observation = phoneticObservation(item);
  const hasLengths = Number.isFinite(item.expectedLength) && item.expectedLength > 0 && Number.isFinite(item.heardLength) && item.heardLength >= 0;
  const direction = hasLengths && item.heardLength < item.expectedLength ? 'қысқа' : hasLengths && item.heardLength > item.expectedLength ? 'ұзақ' : null;
  const nasalShort = !hasLengths && item.expected && item.heard && item.expected[0] === item.heard[0] && item.heard.length < item.expected.length;
  if (item.type === 'tajweed' && /madd|mad[ _-]|lengthen|elongat|مد/i.test(rules)) {
    const name = maddRules.find(([pattern]) => pattern.test(rules))?.[1] || 'Мәд';
    return explanation(
      direction ? `${name}: ${direction} танылды` : `${name}: созылуын тексеріңіз`,
      hasLengths ? `Дыбыстық модель ${item.heardLength} харакатқа сәйкес созылу таныды.` : observation,
      hasLengths ? `Таңдалған оқу үлгісі: ${item.expectedLength} харакат.` : 'Осы жердегі мәдтің созылуын сақтап оқу керек.',
      hasLengths ? `Осы дыбысты ${item.expectedLength} харакатқа созып, аятты қайта оқыңыз.` : 'Осы жерді ұстаздың оқуымен салыстырып, қайта оқыңыз.',
    );
  }
  // The library may label a shortened doubled consonant as tashkeel because
  // its group ends in a vowel. Equal final vowels are not a vowel mistake.
  if (item.type === 'tashkeel' && (lastVowel(item.expected) !== lastVowel(item.heard) || (!item.expected && !item.heard))) {
    const expected = lastVowel(item.expected), heard = lastVowel(item.heard);
    return explanation(
      expected && heard && expected !== heard ? 'Харакат: дауысты дыбыс ауысқан болуы мүмкін' : 'Харакатты тексеріңіз',
      expected && heard && expected !== heard ? `Дыбыстық модель ${expected} орнына ${heard} таныды.` : observation,
      expected ? `Осы жерде ${expected} дыбысы күтіледі.` : 'Мәтіндегі қысқа дауысты дыбыс сақталуы керек.',
      'Сөздің харакатын сақтап, осы жерден қайта оқыңыз.',
    );
  }
  const context = item.context;
  if (context && /^idgham_(no_ghunnah|ghunnah)$/.test(context.kind)) {
    const ghunnah = context.kind === 'idgham_ghunnah';
    const name = ghunnah ? 'Ғұннамен идғам' : 'Ғұннасыз идғам';
    const expected = `${context.source} келесі «${context.target}» әрпіне қосылып${ghunnah ? ', ғұннамен' : ', ғұннасыз'} оқылады.`;
    const e = consonants(item.expected), h = consonants(item.heard);
    const separateNoon = context.source === 'нун' && h.includes('ن') && !e.includes('ن') && context.target !== 'ن';
    const shortened = e.length > h.length && e.length > 1 && new Set(e).size === 1 && h && new Set(h).size === 1 && h[0] === e[0];
    return explanation(
      `${name}: ${separateNoon ? 'нун бөлек танылды' : shortened ? 'қосарланған дыбыс қысқа танылды' : 'қосылуын тексеріңіз'}`,
      separateNoon ? 'Дыбыстық модель қосылып оқылатын нунды жеке дыбыс ретінде таныды.' : observation,
      expected,
      `«${context.text}» тіркесін ${ghunnah ? 'ғұннаны сақтап' : 'ғұнна қоспай'}, қосып қайта оқыңыз.`,
    );
  }
  if (/iqlab|إقلاب/i.test(rules)) {
    return explanation('Иқлаб: мұрыннан шығатын мимді тексеріңіз', observation,
      'Нун немесе тануин «ب» алдында мұрыннан шығатын мим дыбысына ауысып оқылады.',
      'Осы жерді мимге ауыстырып, ғұннасын сақтап қайта оқыңыз.');
  }
  if (/ikhfaa|ikhfa|إخفاء/i.test(rules)) {
    const meem = /meem/i.test(rules);
    return explanation(meem ? 'Ихфа шәфәуи: мимнің жасырын айтылуын тексеріңіз' : 'Ихфа: нунның жасырын айтылуын тексеріңіз', observation,
      meem ? 'Мим «ب» алдында жасырын айтылып, ғұнна сақталады.' : 'Осы жерде нун немесе тануин жасырын айтылып, ғұнна сақталады.',
      meem ? 'Мимді «ب» алдында жасырып, ғұннасын сақтап қайта оқыңыз.' : 'Дыбысты жеке анық нун етіп шығармай, келесі әріпке ғұннамен жалғап қайта оқыңыз.');
  }
  if (/ghonn|ghunn|غنة|modgham.*noon/i.test(rules)) {
    const lengthDirection = direction || (nasalShort ? 'қысқа' : null);
    return explanation(lengthDirection ? `Ғұнна: ${lengthDirection} танылды` : 'Ғұннаны тексеріңіз',
      direction ? `Модель мұрыннан шығатын дыбыстың оқу үлгісінен ${direction} нұсқасын таныды.` : observation,
      'Осы жерде ғұннаның дыбысы мен созылуы сақталуы керек.',
      'Мұрыннан шығатын дыбысты сақтап, осы сөзді қайта оқыңыз.');
  }
  if (item.type === 'tajweed' && /qalq|قلق/i.test(rules)) {
    return explanation('Қалқала: серпілісті тексеріңіз', observation,
      'Сукунды қалқала әрпінің серпілісі сақталуы керек.',
      'Әріпті серпілтіп, соңынан артық «а», «и», «у» дауыстысын қоспай қайта оқыңыз.');
  }
  if (item.type === 'tajweed' && /idgh|idgha|full merging|إدغام/i.test(rules)) {
    return explanation('Идғам: дыбыстардың қосылуын тексеріңіз', observation,
      'Осы жердегі дыбыстар идғам ережесіне сай қосылып оқылады.',
      'Осы тіркесті қосып қайта оқыңыз. Модель идғамның нақты түрін ажыратпады.');
  }
  if (item.type === 'tajweed') return explanation('Тәжуидтегі дыбыстық айырмашылық', observation,
    'Таңдалған оқу үлгісіндегі дыбысталу сақталуы керек.',
    'Модель қатенің нақты ережесін ажыратпады. Осы жерді қайта тыңдап тексеріңіз.');
  const title = item.speechType === 'delete' ? 'Күтілген дыбыс танылмады' : item.speechType === 'insert' && !item.expected ? 'Қосымша дыбыс танылды' : 'Әріптің дыбысын тексеріңіз';
  return explanation(title, observation, item.expected ? `Күтілген дыбыс: «${item.expected}».` : '', 'Мәтіндегі әріптерді сақтап, осы сөзді қайта оқыңыз.');
}
