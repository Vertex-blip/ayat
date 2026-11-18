import { browserMode, getQuran, getPage, pageFont, getModelStatus, prepareModel, analyzeAudio, getRecitationIndex } from './runtime.js?v=f01423c02eba';
import { voicePolicy, createNativeRecitation } from './lib/native-recitation.js?v=f01423c02eba';
import { createRecitationAlerts, describeIssue, describePhoneticIssue } from './lib/recitation-feedback.js?v=f01423c02eba';
import { initPwa, rememberOfflinePage } from './pwa.js?v=f01423c02eba';
import { createAudioSegments } from './lib/live-audio.js?v=f01423c02eba';
import { createLiveProgress } from './lib/live-progress.js?v=f01423c02eba';
const voice = browserMode ? voicePolicy(window, navigator) : { mode: 'model' };
const ToneContext = window.AudioContext || window.webkitAudioContext;
const $ = (id) => document.getElementById(id);
const savedTheme = localStorage.getItem('quran-theme');
const state = {
  chapters: [], structure: [], page: Math.min(604, Math.max(1, Number(new URLSearchParams(location.search).get('page')) || Number(localStorage.getItem('quran-page')) || 1)),
  pageData: null, words: [], hide: localStorage.getItem('quran-hide') === 'true',
  confirmed: 0, revealedWords: new Set(), uncertainWords: new Set(), revealedPages: new Map(), readingVersion: 0, queuedResult: null, applyingResult: null,
  prefillBeforeGlyph: 0,
  blocked: false, currentGlyph: null, pending: false, issue: null, issues: [],
  soundAlerts: localStorage.getItem('quran-sound-alerts') !== 'false', haptics: localStorage.getItem('quran-haptics') !== 'false',
  modelReady: false, recording: false, chunks: [], sampleCount: 0,
  stream: null, context: null, source: null, processor: null, timer: null, started: 0, inflight: null, screenLock: null,
  loadedFonts: new Map(), nativeSession: null, nativeError: false, pendingGlyph: null,
  pageRequest: 0,
  modelFollower: null,
  audioSegments: null, modelSegment: null, analysisError: null,
  recordMode: 'page', advancedVerse: null, starting: false, finishing: false,
  resumePage: null, resumeWords: new Set(), resumePrefillBeforeGlyph: 0,
  navTab: 'surah',
  bookmarks: JSON.parse(localStorage.getItem('quran-bookmarks') || '[]'),
  recent: JSON.parse(localStorage.getItem('quran-recent') || '[]'),
};
let toneContext;
const alerts = createRecitationAlerts({ playTone: playRecitationTone, vibrate: pattern => navigator.vibrate?.(pattern) });
if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;

function savePreference(name, value) { try { localStorage.setItem(name, String(value)); } catch {} }

function enableRecitationTone() {
  if (!state.soundAlerts || !ToneContext) return;
  try {
    toneContext ||= new ToneContext();
    if (toneContext.state !== 'running') void toneContext.resume().catch(() => {});
  } catch {}
}

function playRecitationTone() {
  if (toneContext?.state !== 'running') return;
  const start = toneContext.currentTime;
  const oscillator = toneContext.createOscillator();
  const volume = toneContext.createGain();
  oscillator.frequency.value = 650;
  volume.gain.setValueAtTime(0, start);
  volume.gain.linearRampToValueAtTime(0.16, start + 0.012);
  volume.gain.linearRampToValueAtTime(0, start + 0.11);
  oscillator.connect(volume);
  volume.connect(toneContext.destination);
  oscillator.onended = () => { oscillator.disconnect(); volume.disconnect(); };
  oscillator.start(start);
  oscillator.stop(start + 0.11);
}

function updateRecitationAlerts() {
  alerts.update(state.issues, {
    active: state.recording && !state.finishing && !document.hidden,
    sound: state.soundAlerts && Boolean(ToneContext),
    vibration: state.haptics && typeof navigator.vibrate === 'function',
  });
}

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
async function keepReadingScreenOn() {
  if (!navigator.wakeLock || state.screenLock || !state.recording || document.hidden) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!state.recording || document.hidden) { await lock.release(); return; }
    state.screenLock = lock;
    lock.addEventListener('release', () => { if (state.screenLock === lock) state.screenLock = null; }, { once: true });
  } catch {}
}
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
    const matched = state.revealedWords.has(index);
    const uncertain = !matched && state.uncertainWords.has(index);
    el.classList.toggle('revealed', matched || (!uncertain && index < state.prefillBeforeGlyph));
    el.classList.remove('blocked');
    el.classList.toggle('uncertain', uncertain);
    const current = state.recording && index === state.currentGlyph;
    el.classList.toggle('reading-current', current);
    el.classList.toggle('reading-pending', state.recording && index === state.pendingGlyph);
    if (current) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
  });
  document.querySelectorAll('.mushaf-line').forEach(line => line.classList.toggle('reading-line', Boolean(line.querySelector('.reading-current'))));
}

function updateReadingFeedback() {
  const feedback = describeIssue(state.issue);
  $('readingFeedback').classList.toggle('hidden', !feedback || !state.recording);
  if (feedback) {
    for (const [id, text] of [
      ['feedbackTitle', feedback.title], ['feedbackLocation', feedback.location],
      ['feedbackExpected', feedback.expected], ['feedbackHeard', feedback.heard || '—'],
      ['feedbackDetail', feedback.detail],
    ]) {
      const field = $(id);
      if (field.textContent !== text) field.textContent = text;
    }
    const word = document.querySelector(`.qword[data-index="${state.currentGlyph}"]`);
    $('readingFeedback').classList.toggle('above', Boolean(word && word.getBoundingClientRect().bottom > window.innerHeight - 235));
  }
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
  if ((!following && (state.starting || state.recording || state.finishing)) || !Number.isInteger(n) || n < 1 || n > 604) return;
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
  const previous = following ? state.revealedPages.get(n) : null;
  state.revealedWords = new Set(previous?.words);
  state.prefillBeforeGlyph = previous?.prefillBeforeGlyph ?? 0;
  state.uncertainWords.clear();
  $('voiceNotice').classList.add('hidden');
  state.blocked = false;
  state.currentGlyph = null; state.pendingGlyph = null; state.pending = false; state.issue = null; updateReadingFeedback();
  $('errorCount').textContent = '0';
  $('errorCount').classList.add('hidden');
  $('errorLabel').textContent = 'Тексеру';
  $('errorMessage').textContent = 'Оқуды бастағанда танылған мәтін осында шығады.';
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
  if (browserMode) rememberOfflinePage(n);
  if (!$('navigationPanel').classList.contains('hidden')) renderNavigation();
}

function queueNativeResult(result, version) {
  if (version !== state.readingVersion) return;
  state.queuedResult = { result, version };
  state.applyingResult ||= Promise.resolve().then(applyQueuedResults);
  return state.applyingResult;
}

async function applyQueuedResults() {
  try {
    while (state.queuedResult) {
      const item = state.queuedResult; state.queuedResult = null;
      if (item.version !== state.readingVersion) continue;
      if (item.result.page && item.result.page !== state.page) {
        if (state.recording && !state.nativeError) setReadStatus('Оқылған бет ашылуда…', 'active');
        await loadPage(item.result.page, { following: true, readingVersion: item.version });
      }
      if (item.version === state.readingVersion && (!item.result.page || item.result.page === state.page)) applyResult(item.result);
    }
  } catch (error) { showVoiceNotice(`Бет ашылмады: ${error.message}`); }
  finally { state.applyingResult = null; }
}

function applyResult(result) {
  if (result.quiet) return;
  const progress = result.progress;
  const previous = state.confirmed;
  const end = progress.confirmedGlyphs ?? progress.confirmed;
  if (progress.matchedGlyphs) {
    const resumeWords = state.resumePage === state.page ? state.resumeWords : [];
    state.revealedWords = new Set([...resumeWords, ...progress.matchedGlyphs]);
    state.uncertainWords = new Set((progress.uncertainGlyphs || []).filter(i => !state.revealedWords.has(i)));
    state.confirmed = Math.max(end, ...Array.from(resumeWords, i => i + 1));
    state.blocked = Boolean(progress.blocked);
  } else {
    if (!progress.waitingForStart) for (let i = progress.revealedFrom ?? 0; i < end; i++) state.revealedWords.add(i);
    state.confirmed = Math.max(previous, end);
    state.blocked = end >= previous && progress.blocked;
  }
  state.pending = Boolean(progress.pending);
  state.currentGlyph = Object.hasOwn(progress, 'trackingGlyph')
    ? progress.trackingGlyph : progress.lastMatchedGlyph ?? (end > 0 ? end - 1 : null);
  state.pendingGlyph = Object.hasOwn(progress, 'pendingGlyph')
    ? progress.pendingGlyph : (state.blocked || state.pending) ? (progress.currentGlyph ?? end) : null;
  state.issue = progress.issue || null;
  state.issues = progress.issues ?? (state.issue ? [state.issue] : []);
  const resumePrefill = state.resumePage === state.page ? state.resumePrefillBeforeGlyph : 0;
  state.prefillBeforeGlyph = Math.max(resumePrefill, progress.prefillBeforeGlyph ?? 0);
  state.revealedPages.set(state.page, { words: new Set(state.revealedWords), prefillBeforeGlyph: state.prefillBeforeGlyph });
  // A transcript difference is uncertainty, never a verified reading error.
  $('errorLabel').textContent = 'Тексеру';
  $('errorCount').textContent = '0';
  $('errorCount').classList.add('hidden');
  const feedback = describeIssue(state.issue);
  const listeningStatus = progress.openingOnly ? 'Аятты оқуды бастаңыз…'
    : progress.waitingForStart ? 'Құраннан ізделуде…' : `${state.revealedWords.size} сөз танылды`;
  $('errorMessage').textContent = feedback ? `${feedback.title} · ${feedback.location}. Күтілгені: ${feedback.expected}. Танылғаны: ${feedback.heard || '—'}. ${feedback.detail}` : state.uncertainWords.size
    ? 'Асты сызылған сөздерді қайта тексеруге болады.' : listeningStatus;
  $('transcript').textContent = result.transcript || '';
  $('phoneticFindings').classList.add('hidden');
  $('transcript').classList.remove('hidden');
  if (state.recording && !state.nativeError) setReadStatus(state.blocked || state.pending ? 'Сөз нақтылануда…' : listeningStatus, 'active');
  updateReadingFeedback();
  updateRecitationAlerts();
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
  $('errorLabel').textContent = 'Қателер';
  $('errorCount').classList.remove('hidden');
  $('errorCount').textContent = String(result.errors.length);
  $('errorMessage').textContent = result.errors.length
    ? `${surah}:${ayah} аятында ${result.errors.length} ықтимал дыбыстық айырмашылық табылды.`
    : `${surah}:${ayah} аятында модель ықтимал қате таппады.`;
  $('transcript').classList.add('hidden');
  $('phoneticFindings').replaceChildren(...result.errors.map((item) => {
    const row = document.createElement('div'); row.className = 'phonetic-finding';
    const explanation = describePhoneticIssue(item);
    const heading = document.createElement('strong'); heading.textContent = explanation.title;
    const text = document.createElement('span'); text.lang = 'ar'; text.dir = 'rtl'; text.textContent = item.text || result.reference;
    row.append(heading, text);
    for (const [label, content] of [['Модель байқағаны', explanation.observation], ['Күтілгені', explanation.expected], ['Қалай қайта оқу керек', explanation.correction]]) {
      if (!content) continue;
      const detail = document.createElement('p'); detail.className = 'finding-explanation';
      const caption = document.createElement('b'); caption.textContent = `${label}: `;
      detail.append(caption, document.createTextNode(content)); row.append(detail);
    }
    return row;
  }));
  $('phoneticFindings').classList.remove('hidden');
  if (result.errors.length) {
    if (state.soundAlerts) { try { playRecitationTone(); } catch {} }
    if (state.haptics) { try { navigator.vibrate?.([90, 70, 90]); } catch {} }
  }
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

async function analyzeSegment(snapshot) {
  const version = state.readingVersion;
  const result = await analyzeAudio({ page: state.pageData, ...snapshot });
  if (version !== state.readingVersion || (result.quiet && !snapshot.final)) return;
  const follower = await state.modelFollower;
  if (version !== state.readingVersion) return;
  if (follower) {
    if (state.modelSegment !== null && state.modelSegment !== snapshot.segment) follower.nextSegment();
    state.modelSegment = snapshot.segment;
    const followed = follower.update(result.transcript || '', { final: snapshot.final, settled: true, overlap: snapshot.overlap });
    await queueNativeResult({ ...result, ...followed, quiet: false }, version);
  } else if (!result.quiet) applyResult(result);
}

async function makeFollower(page, startGlyph = null) {
  const index = await getRecitationIndex();
  const { createQuranFollower } = await import(`./lib/recitation-follow.js?v=${window.QURAN_CONFIG?.version || 'local'}`);
  return createQuranFollower(index, { page, startGlyph });
}

async function startRecording(mode = 'page') {
  if (state.starting || state.recording || state.finishing || !state.pageData) return;
  if (voice.mode === 'unavailable' && mode === 'page') return;
  if (voice.mode === 'native' && mode === 'page') { startNativeRecording(); return; }
  if (!state.modelReady && mode === 'page') {
    state.starting = true;
    $('start').disabled = true;
    setReadStatus('Құран моделі дайындалуда…');
    try {
      const preparation = prepareModel();
      if (browserMode) void checkModel();
      await preparation;
      if (browserMode) {
        state.modelReady = true;
        setReadStatus('Дайын · микрофонды басыңыз');
      } else await checkModel();
    }
    catch (error) {
      $('start').disabled = false;
      showError(error);
      showVoiceNotice(error.message);
    }
    finally {
      state.starting = false;
      if (browserMode || state.modelReady) $('start').disabled = false;
    }
    return;
  }
  state.starting = true;
  enableRecitationTone();
  state.pageRequest++;
  $('start').disabled = true;
  $('startAdvanced').disabled = true;
  $('voiceNotice').classList.add('hidden');
  setReadStatus('Микрофонға рұқсат беріңіз…', 'active');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Микрофонды қолдану үшін сайтты HTTPS арқылы немесе осы компьютерде ашыңыз.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    state.stream = stream;
    state.context = new AudioContext(mode === 'phonetics' ? { sampleRate: 16000 } : undefined);
    await state.context.resume();
    state.source = state.context.createMediaStreamSource(state.stream);
    state.processor = state.context.createScriptProcessor(4096, 1, 1);
    state.processor.onaudioprocess = (event) => {
      event.outputBuffer.getChannelData(0).fill(0);
      if (!state.recording) return;
      const copy = new Float32Array(event.inputBuffer.getChannelData(0));
      if (mode === 'page') state.audioSegments.push(copy); else state.chunks.push(copy);
      state.sampleCount += copy.length;
    };
    state.source.connect(state.processor); state.processor.connect(state.context.destination);
    state.chunks = []; state.sampleCount = 0; state.confirmed = 0; state.blocked = false;
    state.audioSegments = mode === 'page' ? createAudioSegments(state.context.sampleRate) : null;
    state.modelSegment = null; state.analysisError = null; state.nativeError = false;
    state.resumePage = null; state.resumeWords.clear(); state.resumePrefillBeforeGlyph = 0;
    state.prefillBeforeGlyph = 0; state.revealedPages.clear();
    state.currentGlyph = null; state.pendingGlyph = null; state.issue = null; state.issues = []; state.pending = false;
    alerts.reset(); updateReadingFeedback();
    state.revealedWords.clear();
    state.uncertainWords.clear();
    state.readingVersion++;
    if (mode === 'page') {
      const words = state.words;
      const allowBasmala = state.pageData.lines.some(line => line.type === 'basmallah' || line.type === 'basmala') ||
        (state.pageData.lines.some(line => line.type === 'surah-header') && words[0]?.surah !== 1 && words[0]?.surah !== 9);
      const page = state.page;
      state.modelFollower = makeFollower(page).catch(() => {
        const tracker = createLiveProgress(words, { allowBasmala, page });
        return {
          nextSegment: () => tracker.nextSegment(),
          update: (transcript, options) => ({ progress: tracker.update(transcript, options) }),
        };
      });
    }
    state.recording = true; state.recordMode = mode; state.started = Date.now();
    void keepReadingScreenOn();
    $('start').classList.add('hidden'); $('stop').classList.remove('hidden'); $('surah').disabled = true;
    $('advancedPanel').classList.add('hidden'); $('errorsPanel').classList.add('hidden');
    renderPage(); setReadStatus(mode === 'phonetics' ? 'Таңдалған аятты оқыңыз…' : 'Тыңдап тұрмын…', 'active');
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
      if (state.stream !== stream || !state.recording) return;
      state.analysisError = new Error('Микрофон ажыратылды. Қайта қосып, оқуды жалғастырыңыз.');
      void stopRecording();
    }, { once: true }));
    state.timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - state.started) / 1000);
      if (seconds >= (mode === 'phonetics' ? 30 : 180)) { void stopRecording(); return; }
      if (mode === 'page' && !state.inflight) {
        const snapshot = state.audioSegments.take();
        if (snapshot) {
          state.inflight = analyzeSegment(snapshot)
            .catch(error => { state.analysisError = error; })
            .finally(() => {
              state.inflight = null;
              if (state.analysisError && state.recording) void stopRecording();
            });
        } else if (!state.audioSegments.heardVoice && seconds === 5) {
          setReadStatus('Дауыс естілмеді · микрофонды тексеріңіз', 'active');
        }
      }
    }, 200);
  } catch (error) {
    const message = {
      NotAllowedError: 'Браузер баптауларында микрофонға рұқсат беріңіз.',
      NotFoundError: 'Микрофон табылмады. Микрофонды қосып, қайталап көріңіз.',
      NotReadableError: 'Микрофонды ашу мүмкін болмады. Басқа қолданба қолданып тұрмағанын тексеріңіз.',
    }[error.name] || error.message;
    showError(error);
    showVoiceNotice(message);
    await cleanupMic();
  } finally {
    state.starting = false;
    $('start').disabled = false;
    $('startAdvanced').disabled = false;
  }
}

function startNativeRecording() {
  if (state.recording || state.finishing || !state.pageData) return;
  enableRecitationTone();
  if (state.confirmed === state.words.length) {
    state.confirmed = 0; state.revealedWords.clear(); state.prefillBeforeGlyph = 0;
  }
  state.blocked = false; state.nativeError = false;
  state.currentGlyph = null; state.pendingGlyph = null; state.issue = null; state.issues = []; state.pending = false;
  alerts.reset(); updateReadingFeedback();
  state.readingVersion++;
  const version = state.readingVersion;
  const sourcePage = state.page;
  const sourceGlyph = state.confirmed > 0 ? state.confirmed : null;
  state.pageRequest++;
  state.resumePage = sourcePage;
  state.resumeWords = new Set(state.revealedWords);
  state.resumePrefillBeforeGlyph = state.prefillBeforeGlyph;
  state.revealedPages.clear();
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
        state.finishing = true;
        void Promise.resolve(state.applyingResult).then(cleanupMic).then(() => {
          $('stop').disabled = false;
          if (!state.nativeError) showReadingSummary();
        });
      },
    });
    state.nativeSession = session; state.recordMode = 'native'; state.recording = true;
    $('start').classList.add('hidden'); $('stop').classList.remove('hidden'); $('surah').disabled = true;
    $('errorsPanel').classList.add('hidden'); $('advancedPanel').classList.add('hidden');
    renderPage(); setReadStatus('Микрофонға рұқсат беріңіз…', 'active');
    $('modelStatus').textContent = 'Телефонның дауыс қызметі · аудио серверде өңделуі мүмкін';
    session.start();
  } catch (error) {
    state.nativeError = true; showError(error); state.nativeSession = null;
    $('errorMessage').textContent = 'Дауыс қызметі ашылмады. Safari-де ашып, Siri мен микрофон/дауысты тану рұқсаттарын тексеріңіз.';
    showVoiceNotice($('errorMessage').textContent); void cleanupMic();
  }
}

async function cleanupMic() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null; state.recording = false;
  const screenLock = state.screenLock; state.screenLock = null;
  if (screenLock) void screenLock.release().catch(() => {});
  updateReadingFeedback();
  updateRecitationAlerts();
  disconnectMic();
  state.audioSegments = null; state.modelSegment = null;
  const context = state.context; state.context = null;
  if (context && context.state !== 'closed') await context.close().catch(() => {});
  state.chunks = []; state.modelFollower = null; state.finishing = false;
  $('start').classList.remove('hidden'); $('stop').classList.add('hidden'); $('surah').disabled = false;
  state.recordMode = 'page';
  renderPage();
}

function disconnectMic() {
  if (state.processor) {
    state.processor.onaudioprocess = null;
    state.processor.disconnect();
  }
  state.source?.disconnect();
  state.stream?.getTracks().forEach(track => track.stop());
  state.processor = null; state.source = null; state.stream = null;
}

function showReadingSummary() {
  const words = `${state.revealedWords.size} сөз танылды`;
  setReadStatus(state.issue || state.blocked ? `${words} · белгіленген сөздер бар` : `Оқу аяқталды · ${words}`);
}

async function stopRecording() {
  if (!state.recording) return;
  if (state.recordMode === 'native') {
    state.finishing = true; $('stop').disabled = true;
    updateRecitationAlerts();
    state.nativeSession?.stop(); return;
  }
  state.recording = false; state.finishing = true;
  updateRecitationAlerts();
  clearInterval(state.timer); state.timer = null;
  disconnectMic();
  $('stop').disabled = true;
  setReadStatus('Соңғы сөздер тексерілуде…', 'active');
  try {
    if (state.inflight) await state.inflight;
    if (state.analysisError) throw state.analysisError;
    if (state.sampleCount < (state.context?.sampleRate || 16000) / 2) setReadStatus('Жазба тым қысқа');
    else if (state.recordMode === 'phonetics') await analyzePhonetics();
    else if (state.audioSegments) {
      state.audioSegments.finish();
      for (let snapshot; (snapshot = state.audioSegments.take());) await analyzeSegment(snapshot);
      if (state.audioSegments.heardVoice) showReadingSummary();
      else setReadStatus('Дауыс естілмеді · микрофонды тексеріңіз');
    }
  }
  catch (error) {
    showError(error);
    showVoiceNotice(error.message);
    if (state.recordMode === 'page') await checkModel();
  }
  finally { await cleanupMic(); $('stop').disabled = false; }
}

function showError(error) { setReadStatus(`Қате: ${error.message}`, 'blocked'); console.error(error); }

async function checkModel() {
  try {
    const status = await getModelStatus();
    if (status.status === 'ready') { state.modelReady = true; $('start').disabled = false; $('modelStatus').textContent = browserMode ? 'Дауыс осы құрылғыда өңделеді' : 'Дауыс моделі дайын · API кілті қажет емес'; return; }
    if (status.status === 'error') { state.modelReady = false; $('start').disabled = false; $('modelStatus').textContent = `Модель қатесі: ${status.error}`; return; }
    $('modelStatus').textContent = status.status === 'idle' ? 'Дауыс моделі іске қосылуда…' : `Дауыс моделі жүктелуде… ${status.progress || 0}%`;
    setTimeout(checkModel, 1500);
  } catch (error) { state.modelReady = false; $('start').disabled = false; $('modelStatus').textContent = `Модель қатесі: ${error.message}`; }
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
    const updateAlertToggles = () => {
      $('soundToggle').textContent = ToneContext ? (state.soundAlerts ? 'Дыбыс қосулы' : 'Дыбыс өшірулі') : 'Дыбыс қолжетімсіз';
      $('soundToggle').disabled = !ToneContext;
      $('soundToggle').setAttribute('aria-pressed', String(Boolean(ToneContext) && state.soundAlerts));
      const supported = typeof navigator.vibrate === 'function';
      $('hapticsToggle').textContent = supported ? (state.haptics ? 'Діріл қосулы' : 'Діріл өшірулі') : 'Бұл браузер дірілді қолдамайды';
      $('hapticsToggle').disabled = !supported;
      $('hapticsToggle').setAttribute('aria-pressed', String(supported && state.haptics));
    };
    updateAlertToggles();
    $('soundToggle').addEventListener('click', () => {
      state.soundAlerts = !state.soundAlerts;
      savePreference('quran-sound-alerts', state.soundAlerts);
      enableRecitationTone(); updateAlertToggles(); updateRecitationAlerts();
    });
    $('hapticsToggle').addEventListener('click', () => {
      state.haptics = !state.haptics;
      savePreference('quran-haptics', state.haptics);
      updateAlertToggles(); updateRecitationAlerts();
    });
    $('advancedToggle').addEventListener('click', () => { $('errorsPanel').classList.add('hidden'); $('advancedPanel').classList.toggle('hidden'); });
    $('closeAdvanced').addEventListener('click', () => $('advancedPanel').classList.add('hidden'));
    $('startAdvanced').addEventListener('click', () => {
      if (state.starting || state.recording || state.finishing) return;
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
    document.addEventListener('visibilitychange', () => {
      updateRecitationAlerts();
      if (state.recording && !document.hidden) enableRecitationTone();
      if (!state.recording || state.recordMode === 'native') return;
      if (document.hidden) {
        state.audioSegments?.finish();
        void state.context?.suspend().catch(() => {});
      } else {
        void state.context?.resume().catch(() => showVoiceNotice('Тыңдауды жалғастыру үшін микрофонды қайта қосыңыз.'));
        void keepReadingScreenOn();
      }
    });
    await loadPage(state.page);
    if (browserMode) void initPwa({ isReading: () => state.starting || state.recording || state.finishing });
    if (browserMode) {
      $('start').disabled = voice.mode === 'unavailable';
      state.modelReady = voice.mode === 'native';
      $('modelStatus').textContent = voice.mode === 'native'
        ? 'Телефонның дауыс қызметі · аудио серверде өңделуі мүмкін'
        : voice.mode === 'unavailable' ? 'Дауыс үшін сайтты Safari немесе Chrome-да ашыңыз' : 'Құран моделі · алғаш рет ≈300 МБ жүктеледі';
      $('advancedAyah').classList.add('hidden');
      document.querySelector('.advanced-label').classList.add('hidden');
      $('startAdvanced').classList.add('hidden');
      document.querySelector('.advanced-help').textContent = 'Бұл сайт оқылған сөздерді тексереді. Харакат пен тәжуидті терең тексеру компьютерге орнатылған нұсқада қолжетімді. Дауысты тану қателесуі мүмкін.';
    } else {
      try { await prepareModel(); await checkModel(); }
      catch (error) { $('start').disabled = false; throw error; }
    }
  } catch (error) { showError(error); }
}
init();
