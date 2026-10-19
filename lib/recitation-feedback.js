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

export function describePhoneticIssue(item) {
  const rules = (item.rules || []).join(' ');
  // A madd label must come from the acoustic checker, never from ASR spelling.
  if (item.type === 'tajweed' && /madd|mad[ _-]|lengthen|elongat|مد/i.test(rules)) {
    const hasLengths = Number.isFinite(item.expectedLength) && Number.isFinite(item.heardLength);
    const direction = hasLengths && item.heardLength < item.expectedLength ? 'қысқа' : hasLengths && item.heardLength > item.expectedLength ? 'ұзақ' : null;
    return {
      title: direction ? `Мәд ${direction} танылды` : 'Мәд: созылуын тексеріңіз',
      detail: hasLengths ? `Таңдалған оқу үлгісі: ${item.expectedLength} харакат. Модель танығаны: ${item.heardLength}. Созылуын қайта тексеріңіз.` : 'Дыбыстық модель созылыңқы дыбыста айырмашылық байқады. Аятты қайта тыңдап, созылуын тексеріңіз.',
    };
  }
  if (item.type === 'tashkeel') return { title: 'Харакатты тексеріңіз', detail: 'Қысқа дауысты дыбыс басқаша танылды.' };
  if (item.type === 'tajweed') return { title: 'Тәжуидті тексеріңіз', detail: 'Дыбыстық модель тәжуидке қатысты ықтимал айырмашылық байқады.' };
  return { title: 'Әріптің дыбысын тексеріңіз', detail: 'Дыбыстық модель әріп не дыбыста ықтимал айырмашылық байқады.' };
}
