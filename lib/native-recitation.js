import { alignWords } from './align.js';
import { createLiveProgress } from './live-progress.js?v=dbd036aa100e';

export function voicePolicy(browser, navigatorInfo) {
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigatorInfo.userAgent) ||
    (navigatorInfo.platform === 'MacIntel' && navigatorInfo.maxTouchPoints > 1);
  const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  return { mobile, Recognition, mode: mobile ? (Recognition ? 'native' : 'unavailable') : 'model' };
}

export function createNativeRecitation({ Recognition, page, startGlyph = null, onResult, onStatus, onError, onEnd }) {
  const words = page.lines.flatMap((line) => line.type === 'ayah' ? line.words.filter((word) => !word.marker) : []);
  const expected = words.map((word) => word.text).join(' ');
  const allowBasmala = page.lines.some((line) => line.type === 'basmallah');
  const tracker = createLiveProgress(words, { startGlyph, allowBasmala });
  let recognition;
  let ended = false;
  let stopping = false;
  let stopTimer;
  let restartTimer;
  let restartsWithoutResult = 0;
  let hasResult = false;
  let lastTranscript = '';
  let completedTranscript = '';
  let lastProgress;
  const finish = () => { if (ended) return; ended = true; clearTimeout(stopTimer); clearTimeout(restartTimer); onEnd(); };
  const errors = {
    'not-allowed': 'Микрофон мен дауысты тануға рұқсат беріңіз.',
    'service-not-allowed': 'Дауыс қызметі өшірулі. iPhone баптауынан Siri-ді қосып, Safari-де ашыңыз.',
    'network': 'Дауыс қызметіне қосылмады. Интернетті тексеріп, қайта басыңыз.',
    'audio-capture': 'Микрофон үзіліп қалды. Экран/аудио жазып тұрған басқа қолданбаны тоқтатып, микрофонды қайта басыңыз.',
    'language-not-supported': 'Бұл құрылғыда арабша дауысты тану қолжетімсіз.',
    'no-speech': 'Дауыс естілмеді. Микрофонды қайта басып оқыңыз.',
  };
  function capture() {
    if (ended || stopping) return;
    const active = new Recognition(); recognition = active;
    active.lang = 'ar-SA'; active.continuous = true;
    active.interimResults = true; active.maxAlternatives = 1;
    active.onstart = () => { if (!ended && active === recognition) onStatus('Тыңдап тұрмын…'); };
    active.onresult = (event) => {
      if (ended || active !== recognition || !event.results?.length) return;
      // Recognition results include earlier final segments. Rebuild the complete
      // transcript so interim revisions never get appended a second time.
      const transcript = Array.from(event.results, (result) => result[0]?.transcript || '').join(' ').trim();
      const final = Array.from(event.results).every((result) => result.isFinal);
      if (!transcript) return;
      hasResult = true; restartsWithoutResult = 0; lastTranscript = transcript;
      const progress = tracker.update(transcript, { final }); lastProgress = progress;
      const allTranscript = [completedTranscript, transcript].filter(Boolean).join(' ');
      onResult({ transcript: allTranscript, quiet: false, progress, ...alignWords(expected, allTranscript, { final: false }) });
    };
    active.onerror = (event) => {
      if (ended || active !== recognition) return;
      if (event.error !== 'aborted' || !stopping) onError(new Error(errors[event.error] || `Дауыс қызметі қолжетімсіз (${event.error}). Safari-де ашып көріңіз.`));
      finish();
      try { active.abort?.(); } catch {}
    };
    active.onend = () => {
      if (ended || active !== recognition) return;
      if (stopping || lastProgress?.confirmedGlyphs === words.length) { finish(); return; }
      if (restartsWithoutResult >= 1) {
        if (!hasResult) onError(new Error('Дауыс естілмеді. Микрофонды қайта басып оқыңыз.'));
        finish(); return;
      }
      restartsWithoutResult++;
      completedTranscript = [completedTranscript, lastTranscript].filter(Boolean).join(' ');
      lastTranscript = ''; tracker.nextSegment();
      onStatus('Тыңдау жалғасуда…');
      restartTimer = setTimeout(() => { try { capture(); } catch (error) { onError(error); finish(); } }, 250);
    };
    active.start();
  }
  return {
    start() { capture(); },
    stop() {
      if (ended || stopping) return;
      stopping = true;
      clearTimeout(restartTimer);
      try { recognition?.stop(); } catch { finish(); }
      if (!ended) stopTimer = setTimeout(() => { finish(); try { recognition.abort?.(); } catch {} }, 2500);
    },
  };
}
