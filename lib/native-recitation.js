import { alignWords } from './align.js?v=f01423c02eba';
import { createLiveProgress } from './live-progress.js?v=f01423c02eba';

export function voicePolicy(browser, navigatorInfo) {
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigatorInfo.userAgent) ||
    (navigatorInfo.platform === 'MacIntel' && navigatorInfo.maxTouchPoints > 1);
  const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  return { mobile, Recognition, mode: mobile ? (Recognition ? 'native' : 'unavailable') : 'model' };
}

function recognitionCandidates(results) {
  let candidates = [{ transcript: '', finalTranscript: '', rank: 0 }];
  for (const result of results) {
    const alternatives = Array.from(result).slice(0, 5);
    if (!alternatives.length) continue;
    const combined = candidates.flatMap(candidate => alternatives.map((item, rank) => {
      const transcript = `${candidate.transcript} ${item.transcript || ''}`.trim();
      return { transcript, finalTranscript: result.isFinal ? transcript : candidate.finalTranscript, rank: candidate.rank + rank };
    })).sort((first, second) => first.rank - second.rank);
    const seen = new Set();
    candidates = [];
    for (const candidate of combined) {
      if (seen.has(candidate.transcript)) continue;
      seen.add(candidate.transcript); candidates.push(candidate);
      if (candidates.length === 24) break;
    }
  }
  return candidates.filter(candidate => candidate.transcript);
}

export function createNativeRecitation({ Recognition, page, startGlyph = null, createFollower, onResult, onStatus, onError, onEnd,
  document: pageDocument = globalThis.document, wakeLock = globalThis.navigator?.wakeLock }) {
  const words = page.lines.flatMap((line) => line.type === 'ayah' ? line.words.filter((word) => !word.marker) : []);
  const expected = words.map((word) => word.text).join(' ');
  const allowBasmala = page.lines.some((line) => line.type === 'basmallah');
  const tracker = createLiveProgress(words, { page: page.page, startGlyph, allowBasmala });
  let follower, awaitingFollower = Boolean(createFollower);
  const bufferedSegments = [];
  let latestCandidates = [];
  let latestSelection;
  let appliedFinalTranscript = '';
  let recognition;
  let started = false;
  let serviceStarted = false;
  let ended = false;
  let stopping = false;
  let paused = false;
  let stopTimer;
  let restartTimer;
  let watchdogTimer;
  let wakeSentinel;
  let requestingWakeLock = false;
  let restartsWithoutResult = 0;
  let completedTranscript = '';
  let lastProgress;
  const hidden = () => pageDocument?.visibilityState === 'hidden';
  function releaseScreen() {
    const held = wakeSentinel; wakeSentinel = null;
    if (held) void Promise.resolve(held.release()).catch(() => {});
  }
  async function keepScreenOn() {
    if (!wakeLock || wakeSentinel || requestingWakeLock || ended || stopping || hidden()) return;
    requestingWakeLock = true;
    try {
      const held = await wakeLock.request('screen');
      if (ended || stopping || hidden()) { await held.release(); return; }
      wakeSentinel = held;
      held.addEventListener?.('release', () => { if (wakeSentinel === held) wakeSentinel = null; }, { once: true });
    } catch { /* Screen locking is optional; recognition still works without it. */ }
    finally { requestingWakeLock = false; }
  }
  function evaluate(candidates) {
    const activeTracker = follower || tracker;
    const selection = activeTracker.selectTranscript?.(candidates.map(candidate => candidate.transcript));
    const selected = candidates.find(candidate => candidate.transcript === selection) || candidates[0];
    const { transcript, finalTranscript } = selected;
    const allTranscript = [completedTranscript, transcript].filter(Boolean).join(' ');
    const final = transcript === finalTranscript;
    if (!final && finalTranscript && finalTranscript !== appliedFinalTranscript) {
      // One native result event can finalize an earlier clause and still carry
      // a provisional next clause. Do not make the earlier decision provisional.
      activeTracker.update(finalTranscript, { final: true });
    }
    if (finalTranscript) appliedFinalTranscript = finalTranscript;
    const matched = follower ? follower.update(transcript, { final }) : {
      progress: tracker.update(transcript, { final }),
      ...alignWords(expected, allTranscript, { final: false }),
    };
    lastProgress = matched.progress;
    return { selected, result: { ...matched, transcript: allTranscript, quiet: false } };
  }
  function publish() {
    if (!latestCandidates.length) return;
    if (awaitingFollower) { onStatus('Құран мәтіні дайындалуда…'); return; }
    const { selected, result } = evaluate(latestCandidates);
    latestSelection = selected;
    onResult(result);
  }
  function advanceSegment(selected, recoverInterim = false) {
    const { transcript, finalTranscript } = selected;
    appliedFinalTranscript = '';
    const followed = follower ? follower.nextSegment({ finalTranscript }) : { progress: tracker.nextSegment({ finalTranscript, recoverInterim }) };
    if (!followed) return null;
    const completed = followed.progress.retainedInterim ? transcript : finalTranscript;
    completedTranscript = [completedTranscript, completed].filter(Boolean).join(' ');
    lastProgress = followed.progress;
    return { ...followed, transcript: completedTranscript, quiet: false };
  }
  function replayBuffered() {
    let lastResult;
    for (const candidates of bufferedSegments) {
      const { selected, result } = evaluate(candidates);
      const advanced = advanceSegment(selected);
      lastResult = selected.transcript === selected.finalTranscript ? result : advanced || result;
    }
    bufferedSegments.length = 0;
    if (latestCandidates.length) publish();
    else if (lastResult) onResult(lastResult);
  }
  function finish(error) {
    if (ended) return;
    ended = true;
    clearTimeout(stopTimer); clearTimeout(restartTimer); clearTimeout(watchdogTimer);
    pageDocument?.removeEventListener('visibilitychange', visibilityChanged);
    const active = recognition; recognition = null;
    try { active?.abort?.(); } catch {}
    releaseScreen();
    try {
      if (awaitingFollower) { awaitingFollower = false; replayBuffered(); }
      else if (latestSelection && latestSelection.transcript !== latestSelection.finalTranscript) nextSegment();
    } finally {
      try { if (error) onError(error); } finally { onEnd(); }
    }
  }
  const errors = {
    'not-allowed': 'Микрофон мен дауысты тануға рұқсат беріңіз.',
    'service-not-allowed': 'Дауыс қызметі өшірулі. iPhone баптауынан Siri-ді қосып, Safari-де ашыңыз.',
    'network': 'Дауыс қызметіне қосылмады. Интернетті тексеріп, қайта басыңыз.',
    'audio-capture': 'Микрофон үзіліп қалды. Экран/аудио жазып тұрған басқа қолданбаны тоқтатып, микрофонды қайта басыңыз.',
    'language-not-supported': 'Бұл құрылғыда арабша дауысты тану қолжетімсіз.',
    'no-speech': 'Дауыс естілмеді. Микрофонды қайта басып оқыңыз.',
    'timeout': 'Дауыс қызметі жауап бермеді. Микрофонды қайта басыңыз немесе Safari-де ашып көріңіз.',
    'aborted': 'Дауыс қызметі үзіліп қалды. Микрофонды қайта басыңыз.',
    'busy': 'Дауыс қызметі босамады. Басқа аудио қолданбаны тоқтатып, қайта басыңыз.',
  };
  function nextSegment(recoverInterim = false) {
    if (awaitingFollower && latestCandidates.length) bufferedSegments.push(latestCandidates);
    else if (latestSelection) {
      const result = advanceSegment(latestSelection, recoverInterim);
      if (result && latestSelection.transcript !== latestSelection.finalTranscript) onResult(result);
    }
    latestCandidates = []; latestSelection = undefined;
  }
  function retire() {
    clearTimeout(watchdogTimer);
    const active = recognition; recognition = null;
    nextSegment(true);
    // Safari may send a delayed end/error after abort. Ignore the retired
    // recognizer before aborting so only one replacement can be scheduled.
    try { active?.abort?.(); } catch {}
  }
  function retry(reason = 'no-speech') {
    if (ended || stopping) return;
    retire(); clearTimeout(restartTimer);
    if (hidden()) { paused = true; onStatus('Оқу кідіртілді · қолданбаға оралыңыз'); return; }
    restartsWithoutResult++;
    const limit = reason === 'network' || reason === 'audio-capture' ? 3 : 6;
    if (restartsWithoutResult > limit) { finish(new Error(errors[reason] || errors.timeout)); return; }
    onStatus(reason === 'network' ? 'Дауыс қызметіне қайта қосылуда…' : 'Тыңдау қайта қосылуда…');
    const delay = Math.min(4000, 250 * 2 ** (restartsWithoutResult - 1));
    restartTimer = setTimeout(capture, delay);
  }
  function watch(active) {
    clearTimeout(watchdogTimer);
    // Some iOS failures produce neither error nor end. Recycle a silent
    // service, but never time out the initial microphone permission prompt.
    watchdogTimer = setTimeout(() => {
      if (!ended && !stopping && recognition === active) retry('timeout');
    }, 30000);
  }
  function visibilityChanged() {
    if (ended || stopping) return;
    if (hidden()) {
      paused = true; clearTimeout(restartTimer); retire(); releaseScreen();
      onStatus('Оқу кідіртілді · қолданбаға оралыңыз');
    } else {
      void keepScreenOn();
      if (paused) {
        paused = false; onStatus('Тыңдау жалғасуда…');
        clearTimeout(restartTimer); restartTimer = setTimeout(capture, 250);
      }
    }
  }
  function capture() {
    if (ended || stopping || paused || hidden()) return;
    let active;
    try { active = new Recognition(); } catch (error) { finish(error); return; }
    recognition = active;
    active.lang = 'ar-SA'; active.continuous = true;
    active.interimResults = true; active.maxAlternatives = 5;
    active.onstart = () => {
      if (!ended && active === recognition) { serviceStarted = true; watch(active); onStatus('Тыңдап тұрмын…'); }
    };
    active.onspeechstart = () => { if (!ended && active === recognition) watch(active); };
    active.onresult = (event) => {
      if (ended || active !== recognition || !event.results) return;
      // Recognition results include earlier final segments. Rebuild the complete
      // transcript so interim revisions never get appended a second time.
      latestCandidates = recognitionCandidates(Array.from(event.results));
      const previous = latestSelection;
      latestSelection = undefined;
      if (!latestCandidates.length) {
        // A provider may remove interim results without replacing them.
        if (previous && !previous.finalTranscript) {
          const followed = follower ? follower.update('', { final: true }) : { progress: tracker.update('', { final: true }) };
          lastProgress = followed.progress;
          onResult({ ...followed, transcript: completedTranscript, quiet: false });
        }
        return;
      }
      restartsWithoutResult = 0;
      watch(active);
      publish();
    };
    active.onerror = (event) => {
      if (ended || active !== recognition) return;
      if (stopping) { finish(); return; }
      if (['no-speech', 'network', 'aborted', 'audio-capture'].includes(event.error)) { retry(event.error); return; }
      finish(new Error(errors[event.error] || `Дауыс қызметі қолжетімсіз (${event.error}). Safari-де ашып көріңіз.`));
    };
    active.onend = () => {
      if (ended || active !== recognition) return;
      if (stopping || (!createFollower && lastProgress?.confirmedGlyphs === words.length)) { finish(); return; }
      retry();
    };
    if (serviceStarted) watch(active);
    try { active.start(); }
    catch (error) {
      if (error.name === 'InvalidStateError') retry('busy'); else finish(error);
    }
  }
  return {
    start() {
      if (started || ended) return;
      started = true;
      pageDocument?.addEventListener('visibilitychange', visibilityChanged);
      void keepScreenOn();
      if (hidden()) visibilityChanged(); else capture();
      if (createFollower) Promise.resolve().then(createFollower).then(value => {
        if (ended) return;
        if (!value) throw new Error('Бет дерегі табылмады');
        follower = value;
        awaitingFollower = false;
        replayBuffered();
      }).catch(error => {
        if (ended) return;
        follower = undefined;
        awaitingFollower = false;
        onStatus(`Іздеу ашылмады: ${error.message}`);
        replayBuffered();
      });
    },
    stop() {
      if (ended || stopping) return;
      stopping = true;
      clearTimeout(restartTimer); clearTimeout(watchdogTimer);
      if (!recognition) { finish(); return; }
      try { recognition?.stop(); } catch { finish(); }
      if (!ended) stopTimer = setTimeout(finish, 2500);
    },
  };
}
