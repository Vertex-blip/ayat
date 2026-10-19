import { alignWords } from './align.js';
import { createLiveProgress } from './live-progress.js?v=45f7fe74bbef';

export function voicePolicy(browser, navigatorInfo) {
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigatorInfo.userAgent) ||
    (navigatorInfo.platform === 'MacIntel' && navigatorInfo.maxTouchPoints > 1);
  const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  return { mobile, Recognition, mode: mobile ? (Recognition ? 'native' : 'unavailable') : 'model' };
}

export function createNativeRecitation({ Recognition, page, startGlyph = null, createFollower, onResult, onStatus, onError, onEnd }) {
  const words = page.lines.flatMap((line) => line.type === 'ayah' ? line.words.filter((word) => !word.marker) : []);
  const expected = words.map((word) => word.text).join(' ');
  const allowBasmala = page.lines.some((line) => line.type === 'basmallah');
  const tracker = createLiveProgress(words, { startGlyph, allowBasmala });
  let follower, followerFailed = false;
  const completedSegments = [];
  let latestCandidates = [];
  let latestFinal = false;
  const publish = () => {
    if (ended || !lastTranscript) return;
    if (createFollower && !follower && !followerFailed) { onStatus('Құраннан ізделуде…'); return; }
    if (follower && latestCandidates.length) lastTranscript = follower.selectTranscript?.(latestCandidates) || lastTranscript;
    const allTranscript = [completedTranscript, lastTranscript].filter(Boolean).join(' ');
    if (follower) {
      const followed = follower.update(lastTranscript, { final: latestFinal });
      lastProgress = followed.progress;
      onResult({ ...followed, transcript: allTranscript, quiet: false });
    } else {
      const progress = tracker.update(lastTranscript, { final: (!createFollower || followerFailed) && latestFinal }); lastProgress = progress;
      onResult({ transcript: allTranscript, quiet: false, progress, ...alignWords(expected, allTranscript, { final: false }) });
    }
  };
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
    active.interimResults = true; active.maxAlternatives = 5;
    active.onstart = () => { if (!ended && active === recognition) onStatus('Тыңдап тұрмын…'); };
    active.onresult = (event) => {
      if (ended || active !== recognition || !event.results?.length) return;
      // Recognition results include earlier final segments. Rebuild the complete
      // transcript so interim revisions never get appended a second time.
      // Keep a small beam of real recognition alternatives, including alternate
      // words inside earlier result segments. The locked follower ranks them.
      let candidates = [''];
      for (const result of Array.from(event.results)) {
        const alternatives = Array.from(result).slice(0, 5).map(item => item.transcript || '');
        candidates = [...new Set(candidates.flatMap(prefix => alternatives.map(text => `${prefix} ${text}`.trim())))].slice(0, 24);
      }
      latestCandidates = candidates;
      const transcript = candidates[0] || '';
      const final = Array.from(event.results).every((result) => result.isFinal);
      if (!transcript) return;
      hasResult = true; restartsWithoutResult = 0; lastTranscript = transcript;
      latestFinal = final; publish();
    };
    active.onerror = (event) => {
      if (ended || active !== recognition) return;
      if (event.error !== 'aborted' || !stopping) onError(new Error(errors[event.error] || `Дауыс қызметі қолжетімсіз (${event.error}). Safari-де ашып көріңіз.`));
      finish();
      try { active.abort?.(); } catch {}
    };
    active.onend = () => {
      if (ended || active !== recognition) return;
      if (stopping || (!createFollower && lastProgress?.confirmedGlyphs === words.length)) { finish(); return; }
      if (restartsWithoutResult >= 1) {
        if (!hasResult) onError(new Error('Дауыс естілмеді. Микрофонды қайта басып оқыңыз.'));
        finish(); return;
      }
      restartsWithoutResult++;
      completedTranscript = [completedTranscript, lastTranscript].filter(Boolean).join(' ');
      completedSegments.push(lastTranscript);
      lastTranscript = ''; latestCandidates = []; tracker.nextSegment(); follower?.nextSegment();
      onStatus('Тыңдау жалғасуда…');
      restartTimer = setTimeout(() => { try { capture(); } catch (error) { onError(error); finish(); } }, 250);
    };
    active.start();
  }
  return {
    start() {
      capture();
      if (createFollower) Promise.resolve().then(createFollower).then(value => {
        if (ended) return;
        follower = value;
        for (const transcript of completedSegments) { follower.update(transcript, { final: true }); follower.nextSegment(); }
        publish();
      }).catch(error => { if (!ended) { followerFailed = true; onStatus(`Іздеу ашылмады: ${error.message}`); publish(); } });
    },
    stop() {
      if (ended || stopping) return;
      stopping = true;
      clearTimeout(restartTimer);
      try { recognition?.stop(); } catch { finish(); }
      if (!ended) stopTimer = setTimeout(() => { finish(); try { recognition.abort?.(); } catch {} }, 2500);
    },
  };
}
