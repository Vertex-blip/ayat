import { browserMode, getQuran, getPage, pageFont, getModelStatus, prepareModel, analyzeAudio, getRecitationIndex } from './runtime.js?v=8e86ad911261';
import { voicePolicy, createNativeRecitation } from './lib/native-recitation.js?v=8e86ad911261';
const voice = browserMode ? voicePolicy(window, navigator) : { mode: 'model' };
const $ = (id) => document.getElementById(id);
const savedTheme = localStorage.getItem('quran-theme');
const state = {
  chapters: [], structure: [], page: Math.min(604, Math.max(1, Number(new URLSearchParams(location.search).get('page')) || Number(localStorage.getItem('quran-page')) || 1)),
  pageData: null, words: [], hide: localStorage.getItem('quran-hide') === 'true',
  confirmed: 0, revealedWords: new Set(), uncertainWords: new Set(), revealedPages: new Map(), readingVersion: 0, queuedResult: null, applyingResult: false,
  blocked: false, modelReady: false, recording: false, chunks: [], sampleCount: 0,
  stream: null, context: null, source: null, processor: null, timer: null, started: 0, inflight: null, lastCheck: 0,
  loadedFonts: new Map(), nativeSession: null, nativeError: false,
  pageRequest: 0,
  modelFollower: null,
  recordMode: 'page', advancedVerse: null, finishing: false,
  navTab: 'surah',
  bookmarks: JSON.parse(localStorage.getItem('quran-bookmarks') || '[]'),
  recent: JSON.parse(localStorage.getItem('quran-recent') || '[]'),
};
if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;

function savePreference(name, value) { try { localStorage.setItem(name, String(value)); } catch {} }
function closeNavigation() {
  $('navigationPanel').classList.add('hidden');
  $('menuToggle').setAttribute('aria-expanded', 'false');
}
function updateBookmark() {
  const marked = state.bookmarks.includes(state.page);
  $('bookmarkToggle').classList.toggle('marked', marked);
  $('bookmarkToggle').setAttribute('aria-pressed', String(marked));
  $('bookmarkToggle').title = marked ? 'Бет белгісін алып тастау' : 'Осы бетті белгілеу';
  $('bookmarkToggle').setAttribute('aria-label', $('bookmarkToggle').title);
}
function renderNavigation() {
  const query = $('navSearch').value.trim().toLocaleLowerCase();
  const recent = $('navRecent');
  recent.replaceChildren();
  const recentLabel = document.createElement('span'); recentLabel.textContent = 'Соңғы беттер'; recent.append(recentLabel);
  for (const n of state.recent.slice(0, 4)) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = `${n}`;
    button.addEventListener('click', () => { closeNavigation(); void loadPage(n).catch(showError); });
    recent.append(button);
  }
  $('navigationPanel').querySelectorAll('.nav-tabs button').forEach((button) => button.classList.toggle('selected', button.dataset.tab === state.navTab));
  const items = state.navTab === 'surah'
    ? state.chapters.map((chapter) => ({ number: chapter.id, surah: chapter.id, title: chapter.name, detail: chapter.transliteration, page: chapter.start_page }))
    : state.navTab === 'juz'
      ? [...new Set(state.structure.map((entry) => entry.juz))].map((juz) => ({ number: juz, title: `${juz}-жүз`, detail: 'Құран бөлімі', page: state.structure.find((entry) => entry.juz === juz).page }))
      : state.bookmarks.map((page) => ({ number: page, title: `${page}-бет`, detail: 'Сақталған белгі', page }));
  const shown = items.filter((item) => !query || `${item.number} ${item.title} ${item.detail} ${item.page}`.toLocaleLowerCase().includes(query));
  const list = $('navList'); list.replaceChildren();
  const directPage = Number(query);
  if (query && Number.isInteger(directPage) && directPage >= 1 && directPage <= 604 && !shown.some((item) => item.page === directPage)) {
    const button = document.createElement('button'); button.className = 'nav-item'; button.type = 'button';
    button.textContent = `${directPage}-бетке өту`;
    button.addEventListener('click', () => { closeNavigation(); void loadPage(directPage).catch(showError); });
    list.append(button);
  }
  if (!shown.length && !list.children.length) { const empty = document.createElement('p'); empty.className = 'nav-empty'; empty.textContent = 'Ештеңе табылмады'; list.append(empty); }
  for (const item of shown) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'nav-item';
    const number = document.createElement('span'); number.className = 'nav-index'; number.textContent = item.number;
    const names = document.createElement('span'); names.className = 'nav-names';
    const title = document.createElement('strong'); title.textContent = item.title;
    if (item.surah) {
      title.className = 'nav-surah-name'; title.lang = 'ar';
      title.setAttribute('aria-label', item.title);
      setSurahName(title, item.surah);
    }
    const detail = document.createElement('small'); detail.textContent = item.detail;
    const page = document.createElement('span'); page.className = 'nav-page'; page.textContent = `${item.page}-бет`;
    names.append(title, detail); button.append(number, names, page);
    button.addEventListener('click', () => { closeNavigation(); void loadPage(item.page).catch(showError); });
    list.append(button);
  }
}
function setReadStatus(text, type = '') { $('recordingStatus').textContent = text; $('recordingStatus').className = `read-status ${type}`; }
function showVoiceNotice(text) { $('voiceNoticeText').textContent = text; $('voiceNotice').classList.remove('hidden'); }
function arabicNumber(n) { return Number(n).toLocaleString('ar-EG'); }
function verseKey(s, a) { return `${s}:${a}`; }
function hasArabicLetters(text) { return /[\u0621-\u064A]/.test(text); }
function displayGroups(text) {
  const groups = [];
  let leading = '';
  for (const part of text.split(/\s+/)) {
    if (hasArabicLetters(part)) { groups.push(leading + part); leading = ''; }
    else if (groups.length) groups[groups.length - 1] += ` ${part}`;
    else leading += `${part} `;
  }
  return groups;
}

function fitLines() {
  if (state.pageData?.lines.some((line) => line.type === 'ayah')) {
    const container = $('mushafLines');
    const base = Math.min(46, Math.max(28, window.innerWidth * .060));
    container.style.fontSize = `${base}px`;
    const rows = [...container.querySelectorAll('.mushaf-line.ayah')];
    let ratio = 1;
    for (const row of rows) {
      const textWidth = [...row.children].reduce((total, span) => total + span.getBoundingClientRect().width, 0);
      ratio = Math.min(ratio, row.clientWidth / Math.max(row.scrollWidth, textWidth, 1));
    }
    if (ratio < 1) container.style.fontSize = `${Math.max(12, base * ratio * .975)}px`;
    for (const row of rows) {
      const spans = [...row.children];
      const contentWidth = spans.reduce((total, span) => total + span.getBoundingClientRect().width, 0);
      const gap = spans.length > 1 ? (row.clientWidth - contentWidth) / (spans.length - 1) : 0;
      row.classList.toggle('short-line', !row.classList.contains('centered') && gap > parseFloat(getComputedStyle(container).fontSize));
    }
    return;
  }
  for (const line of document.querySelectorAll('.mushaf-line.ayah-line')) {
    line.style.fontSize = '';
    const ratio = line.clientWidth / Math.max(line.scrollWidth, 1);
    if (ratio < 0.99) line.style.fontSize = `${Math.max(.58, ratio * .97)}em`;
  }
}

function updateReveal() {
  $('mushafLines').classList.toggle('hidden-verses', state.hide);
  $('hideToggle').classList.toggle('active', state.hide);
  $('hideToggle').title = state.hide ? 'Аяттарды көрсету' : 'Аяттарды жасыру';
  $('hideToggle').setAttribute('aria-label', $('hideToggle').title);
  $('hideToggle').setAttribute('aria-pressed', String(state.hide));
  document.querySelectorAll('.qword').forEach((el) => {
    const index = Number(el.dataset.index);
    el.classList.toggle('revealed', state.revealedWords.has(index));
    el.classList.toggle('blocked', state.hide && state.blocked && index === state.confirmed);
    el.classList.toggle('uncertain', state.uncertainWords.has(index) && !state.revealedWords.has(index));
  });
}

function updateAdvancedVerses(page) {
  const verses = page.fullVerses || [];
  $('advancedAyah').replaceChildren(...verses.map(({ surah, ayah }) => {
    const option = document.createElement('option');
    option.value = `${surah}:${ayah}`;
    option.textContent = `${state.chapters[surah - 1]?.name || surah} · ${ayah}-аят`;
    return option;
  }));
  $('advancedToggle').disabled = (!browserMode && !verses.length) || state.recording;
  $('advancedPanel').classList.add('hidden');
}

function setSurahName(element, surah) {
  element.dir = 'ltr';
  const label = document.createElement('span'); label.className = 'surah-prefix'; label.textContent = '\uE000';
  const name = document.createElement('span'); name.className = 'surah-name'; name.textContent = String.fromCodePoint(0xE000 + surah);
  element.replaceChildren(label, name);
}

function surahBanner(surah) {
  const banner = document.createElement('div');
  banner.className = 'mushaf-line qpc-surah surah-banner';
  banner.dataset.surah = String(surah);
  banner.setAttribute('aria-label', `سُورَةُ ${state.chapters[surah - 1]?.name || ''}`);
  const name = document.createElement('span');
  name.className = 'surah-banner-name';
  setSurahName(name, surah);
  const frame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  frame.setAttribute('viewBox', '0 0 720 50'); frame.setAttribute('preserveAspectRatio', 'none');
  frame.setAttribute('aria-hidden', 'true'); frame.classList.add('surah-banner-frame');
  frame.innerHTML = '<rect x="2" y="2" width="716" height="46"/><rect x="6" y="6" width="708" height="38"/><path d="M120 6C111 15 111 35 120 44M600 6C609 15 609 35 600 44"/><g id="flourish"><path d="M12 25C28 5 45 5 61 25C45 45 28 45 12 25ZM21 25C35 13 45 14 51 25C41 35 31 35 21 25ZM65 6C43 8 49 22 67 25C49 28 43 42 65 44M67 25C90 6 107 13 99 25C107 37 90 44 67 25ZM72 25C85 15 93 18 89 25C93 32 85 35 72 25Z"/></g><g transform="translate(720 0) scale(-1 1)"><path d="M12 25C28 5 45 5 61 25C45 45 28 45 12 25ZM21 25C35 13 45 14 51 25C41 35 31 35 21 25ZM65 6C43 8 49 22 67 25C49 28 43 42 65 44M67 25C90 6 107 13 99 25C107 37 90 44 67 25ZM72 25C85 15 93 18 89 25C93 32 85 35 72 25Z"/></g>';
  banner.append(frame, name);
  return banner;
}

function renderPage() {
  const page = state.pageData;
  if (!page) return;
  if (page.lines.some((line) => line.type === 'ayah')) { renderQpcPage(page); return; }
  const verseMap = new Map(page.verses.map((v) => [verseKey(v.surah_number, v.ayah_number), v]));
  const lines = $('mushafLines');
  lines.replaceChildren();
  state.words = [];
  for (const [lineIndex, line] of page.lines.entries()) {
    const div = document.createElement('div');
    div.className = `mushaf-line ${line.type}`;
    if (line.type === 'surah-header') {
      const nextAyah = page.lines.slice(lineIndex + 1).find((candidate) => candidate.type === 'ayah-line');
      const surahNumber = nextAyah?.tokens?.[0]?.s;
      if (lineIndex !== 0) { div.textContent = line.text || ''; lines.append(div); }
      if (surahNumber && surahNumber !== 1 && surahNumber !== 9) {
        const basmala = document.createElement('div');
        basmala.className = 'mushaf-line basmala';
        basmala.textContent = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';
        lines.append(basmala);
      }
      continue;
    }
    if (line.type === 'ayah-line') {
      if (state.page === 1) div.classList.add('centered');
      for (const token of line.tokens) {
        const verse = verseMap.get(verseKey(token.s, token.a));
        const word = verse?.words.find((w) => w.word_index === token.w);
        if (!word) continue;
        for (const group of displayGroups(word.text)) {
          const span = document.createElement('span');
          span.className = 'qword';
          span.textContent = group;
          span.dataset.index = String(state.words.length);
          state.words.push({ text: group, surah: token.s, ayah: token.a });
          div.append(span, document.createTextNode(' '));
        }
        if (token.w === verse.words.at(-1)?.word_index) {
          const marker = document.createElement('span');
          marker.className = 'ayah-marker';
          marker.textContent = arabicNumber(token.a);
          marker.setAttribute('aria-label', `${token.a}-аят`);
          div.append(marker);
        }
      }
    } else if (line.type === 'surah-header') {
      div.textContent = line.text || '';
    } else if (line.type === 'basmala') {
      div.textContent = line.text || '﷽';
    }
    lines.append(div);
  }
  const firstVerse = page.verses[0];
  document.querySelector('.mushaf-head').classList.toggle('hidden', page.lines[0]?.type !== 'surah-header');
  const surah = state.chapters[firstVerse?.surah_number - 1];
  $('headerSurah').textContent = `سُورَةُ ${surah?.name || ''}`;
  $('footSurah').textContent = surah?.name || '';
  $('footPage').textContent = arabicNumber(state.page);
  $('pageNumber').textContent = String(state.page);
  $('pageJump').value = String(state.page);
  const division = state.structure[state.page - 1];
  $('pageMeta').textContent = ` · ${division?.juz || 1} жүз · ${division?.hizb || 1} хизб`;
  $('surah').value = String(firstVerse?.surah_number || 1);
  $('prev').disabled = state.page <= 1 || state.recording;
  $('next').disabled = state.page >= 604 || state.recording;
  updateAdvancedVerses(page);
  updateReveal();
  requestAnimationFrame(fitLines);
}

function renderQpcPage(page) {
  const lines = $('mushafLines');
  lines.replaceChildren(); lines.classList.add('qpc-lines');
  state.words = [];
  const firstWord = page.lines.find((line) => line.type === 'ayah')?.words.find((word) => !word.marker);
  let headerSurah = firstWord?.surah || 1;
  for (const line of page.lines) {
    if (line.type === 'surah_name') {
      const surah = line.surah || headerSurah;
      lines.append(surahBanner(surah)); continue;
    }
    if (line.type === 'basmallah') {
      const div = document.createElement('div'); div.className = 'mushaf-line qpc-basmala';
      const glyph = document.createElement('span'); glyph.className = 'basmala-glyph'; glyph.textContent = '\uF8DD';
      div.append(glyph); lines.append(div); continue;
    }
    const div = document.createElement('div');
    div.className = `mushaf-line ayah qpc-line${line.centered ? ' centered' : ''}`;
    div.style.fontFamily = `QPC${page.page}`;
    for (const word of line.words) {
      const span = document.createElement('span');
      span.className = word.marker ? 'qpc-marker' : 'qword';
      span.textContent = word.glyph;
      span.title = word.text;
      span.setAttribute('aria-label', word.text);
      if (!word.marker) {
        span.dataset.index = String(state.words.length);
        state.words.push({ text: word.text, surah: word.surah, ayah: word.ayah });
      }
      div.append(span);
    }
    lines.append(div);
  }
  const surah = state.chapters[headerSurah - 1];
  $('headerSurah').textContent = String.fromCodePoint(0xE000, 0xE000 + headerSurah);
  $('headerSurah').classList.add('qpc-header-title');
  document.querySelector('.mushaf-head').classList.add('hidden');
  $('footSurah').textContent = surah?.name || '';
  $('pageNumber').textContent = String(state.page);
  $('pageJump').value = String(state.page);
  const division = state.structure[state.page - 1];
  $('pageMeta').textContent = ` · ${division?.juz || 1} жүз · ${division?.hizb || 1} хизб`;
  $('surah').value = String(headerSurah);
  $('prev').disabled = state.page <= 1 || state.recording;
  $('next').disabled = state.page >= 604 || state.recording;
  updateAdvancedVerses(page);
  updateReveal();
  requestAnimationFrame(() => { document.fonts.load(`40px QPC${page.page}`).then(fitLines); });
}

async function loadPage(n, { following = false, readingVersion = null } = {}) {
  if ((!following && (state.recording || state.finishing)) || !Number.isInteger(n) || n < 1 || n > 604) return;
  if (!following) state.readingVersion++;
  const requestId = ++state.pageRequest;
  const pageData = await getPage(n);
  if (pageData.lines.some((line) => line.type === 'ayah')) {
    const family = `QPC${n}`;
    if (!state.loadedFonts.has(n)) {
      const font = new FontFace(family, `url('${pageFont(n)}')`, { display: 'swap' });
      await font.load(); document.fonts.add(font); state.loadedFonts.set(n, font);
      while (state.loadedFonts.size > 8) {
        const oldest = state.loadedFonts.keys().next().value;
        document.fonts.delete(state.loadedFonts.get(oldest)); state.loadedFonts.delete(oldest);
      }
    }
  }
  if (requestId !== state.pageRequest) return;
  if (following && readingVersion !== state.readingVersion) return;
  state.pageData = pageData;
  state.page = n;
  state.confirmed = 0;
  state.revealedWords = following ? new Set(state.revealedPages.get(n) || []) : new Set();
  state.uncertainWords.clear();
  $('voiceNotice').classList.add('hidden');
  state.blocked = false;
  $('errorCount').textContent = '0';
  $('errorMessage').textContent = 'Оқуды бастағанда ықтимал қателер осында шығады.';
  $('transcript').textContent = '';
  $('phoneticFindings').replaceChildren();
  $('phoneticFindings').classList.add('hidden');
  $('transcript').classList.remove('hidden');
  document.querySelector('.panel-note').textContent = voice.mode === 'native'
    ? 'Телефонның дауыс қызметі аудионы сыртқы серверде өңдеуі мүмкін. Бұл режим сөздерді салыстырады; харакат пен тәжуидті бағаламайды.'
    : 'Дауысты тану қателесуі мүмкін. Харакат пен тәжуид бұл режимде дәл тексерілмейді.';
  savePreference('quran-page', n);
  state.recent = [n, ...state.recent.filter((page) => page !== n)].slice(0, 8);
  savePreference('quran-recent', JSON.stringify(state.recent));
  renderPage();
  updateBookmark();
  if (!$('navigationPanel').classList.contains('hidden')) renderNavigation();
}

async function queueNativeResult(result, version) {
  if (version !== state.readingVersion) return;
  state.queuedResult = { result, version };
  if (state.applyingResult) return;
  state.applyingResult = true;
  try {
    while (state.queuedResult) {
      const item = state.queuedResult; state.queuedResult = null;
      if (item.version !== state.readingVersion) continue;
      if (item.result.page && item.result.page !== state.page && !item.result.progress.waitingForStart) {
        state.revealedPages.set(state.page, new Set(state.revealedWords));
        setReadStatus('Оқылған бет ашылуда…', 'active');
        await loadPage(item.result.page, { following: true, readingVersion: item.version });
      }
      if (item.version === state.readingVersion && (!item.result.page || item.result.page === state.page)) applyResult(item.result);
    }
  } catch (error) { showVoiceNotice(`Бет ашылмады: ${error.message}`); }
  finally { state.applyingResult = false; }
}

function applyResult(result) {
  if (result.quiet) return;
  const progress = result.progress;
  const previous = state.confirmed;
  const end = progress.confirmedGlyphs ?? progress.confirmed;
  if (progress.matchedGlyphs) {
    for (const i of progress.matchedGlyphs) state.revealedWords.add(i);
    state.uncertainWords = new Set((progress.uncertainGlyphs || []).filter(i => !state.revealedWords.has(i)));
  } else if (!progress.waitingForStart) for (let i = progress.revealedFrom ?? 0; i < end; i++) state.revealedWords.add(i);
  state.confirmed = Math.max(state.confirmed, progress.confirmedGlyphs ?? progress.confirmed);
  state.blocked = state.confirmed < state.words.length && (progress.confirmedGlyphs ?? progress.confirmed) >= previous && progress.blocked;
  state.revealedPages.set(state.page, new Set(state.revealedWords));
  $('errorCount').textContent = state.uncertainWords.size ? String(state.uncertainWords.size) : state.blocked ? '1' : '0';
  $('errorMessage').textContent = state.uncertainWords.size
    ? `${state.revealedWords.size} сөз танылды. ${state.uncertainWords.size} сөз анық танылмады — белгіленген жерді қайта оқыңыз.`
    : state.blocked
    ? `Осы жерде тоқтады: ${state.words[state.confirmed]?.surah}:${state.words[state.confirmed]?.ayah}. Қате болуы мүмкін; осы сөзді қайта оқыңыз.`
    : progress.waitingForStart ? 'Оқи беріңіз: басталған аят анықталуда.' : `${state.revealedWords.size} сөз танылды. ${state.words.length - state.revealedWords.size} сөз қалды.`;
  $('transcript').textContent = result.transcript || '';
  $('phoneticFindings').classList.add('hidden');
  $('transcript').classList.remove('hidden');
  if (state.recording) setReadStatus(progress.waitingForStart ? 'Құраннан ізделуде…' : `${state.revealedWords.size} сөз ашылды`, 'active');
  updateReveal();
}

async function analyzePhonetics() {
  if (!state.context || state.sampleCount < state.context.sampleRate / 2 || !state.advancedVerse) return;
  setReadStatus('Аяттың дыбысы терең тексерілуде…', 'active');
  const audio = audioBuffer();
  const { surah, ayah } = state.advancedVerse;
  const response = await fetch(`/api/phonetics?page=${state.page}&surah=${surah}&ayah=${ayah}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Sample-Rate': String(state.context.sampleRate) }, body: audio.buffer,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  const names = { normal: 'Әріп/дыбыс', tashkeel: 'Харакат', tajweed: 'Тәжуид' };
  $('errorCount').textContent = String(result.errors.length);
  $('errorMessage').textContent = result.errors.length
    ? `${surah}:${ayah} аятында ${result.errors.length} ықтимал дыбыстық айырмашылық табылды.`
    : `${surah}:${ayah} аятында модель ықтимал қате таппады.`;
  $('transcript').classList.add('hidden');
  $('phoneticFindings').replaceChildren(...result.errors.map((item) => {
    const row = document.createElement('div'); row.className = 'phonetic-finding';
    const heading = document.createElement('strong'); heading.textContent = names[item.type] || 'Дыбыс';
    const text = document.createElement('span'); text.lang = 'ar'; text.dir = 'rtl'; text.textContent = item.text || result.reference;
    const detail = document.createElement('small'); detail.textContent = `Күтілгені: ${item.expected || '—'} · Танылғаны: ${item.heard || '—'}${item.rules?.length ? ` · ${item.rules.join(', ')}` : ''}`;
    row.append(heading, text, detail); return row;
  }));
  $('phoneticFindings').classList.remove('hidden');
  document.querySelector('.panel-note').textContent = 'Бұл модель де жаңылысуы мүмкін. Харакат пен тәжуид нәтижесін ұстазбен тексеріңіз.';
  $('errorsPanel').classList.remove('hidden');
  setReadStatus(`Терең тексеру аяқталды · ${result.errors.length} ықтимал қате`);
}

function audioBuffer() {
  const output = new Float32Array(state.sampleCount);
  let at = 0;
  for (const chunk of state.chunks) { output.set(chunk, at); at += chunk.length; }
  return output;
}

async function analyze(final = false) {
  if (!state.context || state.sampleCount < state.context.sampleRate / 2) return;
  const audio = audioBuffer();
  const result = await analyzeAudio({ page: state.pageData, audio, sampleRate: state.context.sampleRate, final });
  if (!result.quiet && state.modelFollower) {
    const follower = await state.modelFollower;
    if (follower) await queueNativeResult({ ...result, ...follower.update(result.transcript, { final }) }, state.readingVersion);
    else applyResult(result);
  } else applyResult(result);
  if (final) setReadStatus(result.quiet ? 'Дауыс анық естілмеді' : `Оқу аяқталды · ${state.confirmed} сөз`);
}

async function makeFollower(page, startGlyph = null) {
  const index = await getRecitationIndex();
  const { createQuranFollower } = await import(`./lib/recitation-follow.js?v=${window.QURAN_CONFIG?.version || 'local'}`);
  return createQuranFollower(index, { page, startGlyph });
}

async function startRecording(mode = 'page') {
  if (voice.mode === 'unavailable' && mode === 'page') return;
  if (voice.mode === 'native' && mode === 'page') { startNativeRecording(); return; }
  if (browserMode && !state.modelReady && mode === 'page') {
    $('start').disabled = true;
    const preparation = prepareModel();
    void checkModel();
    try { await preparation; state.modelReady = true; setReadStatus('Дайын · микрофонды басыңыз'); }
    catch (error) { showError(error); }
    finally { $('start').disabled = false; }
    return;
  }
  if ((mode === 'page' && !state.modelReady) || state.recording || state.finishing || !state.pageData) return;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    state.context = new AudioContext(mode === 'phonetics' ? { sampleRate: 16000 } : undefined);
    await state.context.resume();
    state.source = state.context.createMediaStreamSource(state.stream);
    state.processor = state.context.createScriptProcessor(4096, 1, 1);
    state.processor.onaudioprocess = (event) => {
      event.outputBuffer.getChannelData(0).fill(0);
      if (!state.recording) return;
      const copy = new Float32Array(event.inputBuffer.getChannelData(0));
      state.chunks.push(copy); state.sampleCount += copy.length;
    };
    state.source.connect(state.processor); state.processor.connect(state.context.destination);
    state.chunks = []; state.sampleCount = 0; state.confirmed = 0; state.blocked = false;
    state.revealedWords.clear();
    state.uncertainWords.clear();
    state.readingVersion++;
    state.modelFollower = makeFollower(state.page).catch(() => null);
    state.recording = true; state.recordMode = mode; state.started = Date.now(); state.lastCheck = 0;
    $('start').classList.add('hidden'); $('stop').classList.remove('hidden'); $('surah').disabled = true;
    $('advancedPanel').classList.add('hidden'); $('errorsPanel').classList.add('hidden');
    renderPage(); setReadStatus(mode === 'phonetics' ? 'Таңдалған аятты оқыңыз…' : 'Тыңдап тұрмын…', 'active');
    state.timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - state.started) / 1000);
      if (seconds >= (mode === 'phonetics' ? 30 : 180)) { void stopRecording(); return; }
      if (mode === 'page' && seconds >= 6 && seconds - state.lastCheck >= 8 && !state.inflight) {
        state.lastCheck = seconds;
        state.inflight = analyze(false).catch(showError).finally(() => { state.inflight = null; });
      }
    }, 1000);
  } catch (error) { showError(error); await cleanupMic(); }
}

function startNativeRecording() {
  if (state.recording || state.finishing || !state.pageData) return;
  if (state.confirmed === state.words.length) { state.confirmed = 0; state.revealedWords.clear(); }
  state.blocked = false; state.nativeError = false;
  state.readingVersion++;
  const version = state.readingVersion;
  const sourcePage = state.page;
  const sourceGlyph = state.confirmed > 0 ? state.confirmed : null;
  $('voiceNotice').classList.add('hidden');
  try {
    const session = createNativeRecitation({
      Recognition: voice.Recognition, page: state.pageData,
      startGlyph: state.confirmed > 0 ? state.confirmed : null,
      createFollower: () => makeFollower(sourcePage, sourceGlyph),
      onResult: result => { void queueNativeResult(result, version); },
      onStatus: (text) => setReadStatus(text, 'active'),
      onError: (error) => {
        state.nativeError = true; showError(error); $('modelStatus').textContent = error.message;
        $('errorMessage').textContent = error.message; showVoiceNotice(error.message);
      },
      onEnd: () => {
        state.nativeSession = null;
        void cleanupMic().then(() => {
          $('stop').disabled = false;
          if (!state.nativeError) setReadStatus(`Оқу аяқталды · ${state.revealedWords.size} сөз`);
        });
      },
    });
    state.nativeSession = session; state.recordMode = 'native'; state.recording = true;
    session.start();
    $('start').classList.add('hidden'); $('stop').classList.remove('hidden'); $('surah').disabled = true;
    $('errorsPanel').classList.add('hidden'); $('advancedPanel').classList.add('hidden');
    renderPage(); setReadStatus('Микрофонға рұқсат беріңіз…', 'active');
    $('modelStatus').textContent = 'Телефонның дауыс қызметі · аудио серверде өңделуі мүмкін';
  } catch (error) {
    state.nativeError = true; showError(error); state.nativeSession = null;
    $('errorMessage').textContent = 'Дауыс қызметі ашылмады. Safari-де ашып, Siri мен микрофон/дауысты тану рұқсаттарын тексеріңіз.';
    showVoiceNotice($('errorMessage').textContent); void cleanupMic();
  }
}

async function cleanupMic() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null; state.recording = false; state.finishing = false;
  state.processor?.disconnect(); state.source?.disconnect();
  state.stream?.getTracks().forEach((track) => track.stop());
  if (state.context && state.context.state !== 'closed') await state.context.close();
  $('start').classList.remove('hidden'); $('stop').classList.add('hidden'); $('surah').disabled = false;
  state.recordMode = 'page';
  renderPage();
}

async function stopRecording() {
  if (!state.recording) return;
  if (state.recordMode === 'native') {
    state.finishing = true; $('stop').disabled = true;
    state.nativeSession?.stop(); return;
  }
  state.recording = false; state.finishing = true;
  clearInterval(state.timer); state.timer = null;
  state.processor?.disconnect(); state.source?.disconnect();
  state.stream?.getTracks().forEach((track) => track.stop());
  $('stop').disabled = true;
  try {
    if (state.inflight) await state.inflight;
    if (state.sampleCount < (state.context?.sampleRate || 16000) / 2) setReadStatus('Жазба тым қысқа');
    else if (state.recordMode === 'phonetics') await analyzePhonetics();
    else await analyze(true);
  }
  catch (error) { showError(error); }
  finally { await cleanupMic(); $('stop').disabled = false; }
}

function showError(error) { setReadStatus(`Қате: ${error.message}`, 'blocked'); console.error(error); }

async function checkModel() {
  try {
    const status = await getModelStatus();
    if (status.status === 'ready') { state.modelReady = true; $('start').disabled = false; $('modelStatus').textContent = browserMode ? 'Дауыс осы құрылғыда өңделеді' : 'Дауыс моделі дайын · API кілті қажет емес'; return; }
    if (status.status === 'error') { $('modelStatus').textContent = `Модель қатесі: ${status.error}`; return; }
    $('modelStatus').textContent = status.status === 'idle' ? 'Дауыс моделі іске қосылуда…' : `Дауыс моделі жүктелуде… ${status.progress || 0}%`;
    setTimeout(checkModel, 1500);
  } catch (error) { $('modelStatus').textContent = `Модель қатесі: ${error.message}`; }
}

async function init() {
  try {
    document.querySelector('meta[name="theme-color"]').content = document.documentElement.dataset.theme === 'light' ? '#f5f5f5' : '#1c1c1e';
    const data = await getQuran();
    state.chapters = data.chapters; state.structure = data.structure;
    $('surah').replaceChildren(...data.chapters.map((ch) => {
      const option = document.createElement('option'); option.value = ch.id; option.textContent = `${ch.id}. ${ch.name}`; return option;
    }));
    $('surah').addEventListener('change', () => void loadPage(state.chapters[Number($('surah').value) - 1].start_page).catch(showError));
    $('prev').addEventListener('click', () => void loadPage(state.page - 1).catch(showError));
    $('next').addEventListener('click', () => void loadPage(state.page + 1).catch(showError));
    $('pageJump').addEventListener('change', () => void loadPage(Number($('pageJump').value)).catch(showError));
    $('themeToggle').addEventListener('click', () => {
      const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = theme;
      document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#1c1c1e' : '#f5f5f5';
      $('themeToggle').title = theme === 'dark' ? 'Ақ тақырыпқа ауысу' : 'Қара тақырыпқа ауысу';
      $('themeToggle').setAttribute('aria-label', $('themeToggle').title);
      savePreference('quran-theme', theme); requestAnimationFrame(fitLines);
    });
    $('themeToggle').title = document.documentElement.dataset.theme === 'dark' ? 'Ақ тақырыпқа ауысу' : 'Қара тақырыпқа ауысу';
    $('themeToggle').setAttribute('aria-label', $('themeToggle').title);
    $('menuToggle').addEventListener('click', () => {
      const opened = $('navigationPanel').classList.toggle('hidden') === false;
      $('menuToggle').setAttribute('aria-expanded', String(opened));
      if (opened) renderNavigation();
    });
    $('navClose').addEventListener('click', closeNavigation);
    $('searchToggle').addEventListener('click', () => { $('navigationPanel').classList.remove('hidden'); $('menuToggle').setAttribute('aria-expanded', 'true'); renderNavigation(); $('navSearch').focus(); });
    $('navSearch').addEventListener('input', renderNavigation);
    document.querySelectorAll('.nav-tabs button').forEach((button) => button.addEventListener('click', () => { state.navTab = button.dataset.tab; renderNavigation(); }));
    $('bookmarkToggle').addEventListener('click', () => {
      state.bookmarks = state.bookmarks.includes(state.page) ? state.bookmarks.filter((page) => page !== state.page) : [...state.bookmarks, state.page].sort((a, b) => a - b);
      savePreference('quran-bookmarks', JSON.stringify(state.bookmarks)); updateBookmark();
      if (!$('navigationPanel').classList.contains('hidden')) renderNavigation();
    });
    $('hideToggle').addEventListener('click', () => { state.hide = !state.hide; savePreference('quran-hide', state.hide); updateReveal(); });
    $('errorsToggle').addEventListener('click', () => { $('advancedPanel').classList.add('hidden'); $('errorsPanel').classList.toggle('hidden'); });
    $('closeErrors').addEventListener('click', () => $('errorsPanel').classList.add('hidden'));
    $('advancedToggle').addEventListener('click', () => { $('errorsPanel').classList.add('hidden'); $('advancedPanel').classList.toggle('hidden'); });
    $('closeAdvanced').addEventListener('click', () => $('advancedPanel').classList.add('hidden'));
    $('startAdvanced').addEventListener('click', () => {
      const [surah, ayah] = $('advancedAyah').value.split(':').map(Number);
      if (!surah || !ayah) return;
      state.advancedVerse = { surah, ayah };
      void startRecording('phonetics');
    });
    $('start').addEventListener('click', () => startRecording('page'));
    $('stop').addEventListener('click', stopRecording);
    $('closeVoiceNotice').addEventListener('click', () => $('voiceNotice').classList.add('hidden'));
    let swipeStart = null;
    document.querySelector('.mushaf').addEventListener('touchstart', (event) => {
      if (event.touches.length === 1) swipeStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }, { passive: true });
    document.querySelector('.mushaf').addEventListener('touchend', (event) => {
      if (!swipeStart || state.recording || event.changedTouches.length !== 1) { swipeStart = null; return; }
      const dx = event.changedTouches[0].clientX - swipeStart.x;
      const dy = event.changedTouches[0].clientY - swipeStart.y;
      swipeStart = null;
      if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      void loadPage(state.page + (dx > 0 ? 1 : -1)).catch(showError);
    }, { passive: true });
    window.addEventListener('resize', fitLines);
    await loadPage(state.page);
    if (browserMode) {
      $('start').disabled = voice.mode === 'unavailable';
      state.modelReady = voice.mode === 'native';
      $('modelStatus').textContent = voice.mode === 'native'
        ? 'Телефонның дауыс қызметі · аудио серверде өңделуі мүмкін'
        : voice.mode === 'unavailable' ? 'Дауыс үшін сайтты Safari немесе Chrome-да ашыңыз' : 'Микрофонды қосу · алғаш рет ≈300 МБ жүктеледі';
      $('advancedAyah').classList.add('hidden');
      document.querySelector('.advanced-label').classList.add('hidden');
      $('startAdvanced').classList.add('hidden');
      document.querySelector('.advanced-help').textContent = 'Бұл сайт оқылған сөздерді тексереді. Харакат пен тәжуидті терең тексеру компьютерге орнатылған нұсқада қолжетімді. Дауысты тану қателесуі мүмкін.';
    } else {
      await prepareModel();
      await checkModel();
    }
  } catch (error) { showError(error); }
}
init();
