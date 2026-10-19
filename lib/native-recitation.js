import { alignWords } from './align.js';
import { sequentialProgress, glyphsConfirmed } from './progress.js';

export function voicePolicy(browser, navigatorInfo) {
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigatorInfo.userAgent) ||
    (navigatorInfo.platform === 'MacIntel' && navigatorInfo.maxTouchPoints > 1);
  const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  return { mobile, Recognition, mode: mobile ? (Recognition ? 'native' : 'unavailable') : 'model' };
}

export function createNativeRecitation({ Recognition, page, onResult, onStatus, onError, onEnd }) {
  const recognition = new Recognition();
  recognition.lang = 'ar-SA';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  const words = page.lines.flatMap((line) => line.type === 'ayah' ? line.words.filter((word) => !word.marker) : []);
  const expected = words.map((word) => word.text).join(' ');
  const allowBasmala = page.lines.some((line) => line.type === 'basmallah');
  let ended = false;
  let stopping = false;
  let stopTimer;
  const finish = () => { if (ended) return; ended = true; clearTimeout(stopTimer); onEnd(); };
  const errors = {
    'not-allowed': 'Микрофон мен дауысты тануға рұқсат беріңіз.',
    'service-not-allowed': 'Дауыс қызметі өшірулі. iPhone баптауынан Siri-ді қосып, Safari-де ашыңыз.',
    'network': 'Дауыс қызметіне қосылмады. Интернетті тексеріп, қайта басыңыз.',
    'audio-capture': 'Микрофон ашылмады. Басқа қолданбадағы жазбаны тоқтатыңыз.',
    'language-not-supported': 'Бұл құрылғыда арабша дауысты тану қолжетімсіз.',
    'no-speech': 'Дауыс естілмеді. Микрофонды қайта басып оқыңыз.',
  };
  recognition.onstart = () => { if (!ended) onStatus('Тыңдап тұрмын…'); };
  recognition.onresult = (event) => {
    if (ended) return;
    // Recognition results include earlier final segments. Rebuild the complete
    // transcript so interim revisions never get appended a second time.
    const transcript = Array.from(event.results, (result) => result[0]?.transcript || '').join(' ').trim();
    const final = Array.from(event.results).every((result) => result.isFinal);
    const progress = sequentialProgress(expected, transcript, { allowBasmala });
    progress.confirmedGlyphs = glyphsConfirmed(words, progress.confirmed);
    if (!final) progress.blocked = false;
    onResult({ transcript, quiet: false, progress, ...alignWords(expected, transcript, { final: false }) });
  };
  recognition.onerror = (event) => {
    if (ended) return;
    if (event.error !== 'aborted' || !stopping) onError(new Error(errors[event.error] || `Дауыс қызметі қолжетімсіз (${event.error}). Safari-де ашып көріңіз.`));
    finish();
    try { recognition.abort?.(); } catch {}
  };
  recognition.onend = finish;
  return {
    start() { recognition.start(); },
    stop() {
      if (ended || stopping) return;
      stopping = true;
      try { recognition.stop(); } catch { finish(); }
      if (!ended) stopTimer = setTimeout(() => { finish(); try { recognition.abort?.(); } catch {} }, 2500);
    },
  };
}
