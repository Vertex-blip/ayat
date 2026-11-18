const config = window.QURAN_CONFIG || {};
export const browserMode = config.mode === 'browser';
let worker;
let requestId = 0;
let modelStatus = { status: 'idle', progress: 0 };
const pending = new Map();
let recitationIndex;

function resetWorker(error) {
  modelStatus = { status: 'error', error: error.message };
  worker?.terminate();
  worker = null;
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(error);
  }
  pending.clear();
}

async function json(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export function getQuran() { return json(browserMode ? './data/quran.json' : '/api/quran'); }
export function getPage(n) { return json(browserMode ? `./data/pages/${n}.json` : `/api/page?n=${n}`); }
export async function getRecitationIndex() {
  if (!recitationIndex) recitationIndex = Promise.all([
    json(browserMode ? './data/recitation.json' : '/api/recitation'),
    import(`./lib/recitation-follow.js?v=${config.version || 'local'}`),
  ]).then(([corpus, { createRecitationIndex }]) => {
    if (!corpus.length) throw new Error('Толық Құранның бет дерегі орнатылмаған');
    return createRecitationIndex(corpus);
  }).catch(error => { recitationIndex = null; throw error; });
  return recitationIndex;
}
export function pageFont(n) {
  return browserMode ? `${config.fontBase}/qpcv4/p${n}.woff2` : `/qpc-fonts/p${n}.woff2`;
}

function request(type, payload = {}) {
  if (!worker) {
    const workerUrl = new URL('./voice-worker.js', import.meta.url);
    workerUrl.searchParams.set('v', config.version || 'local');
    worker = new Worker(workerUrl, { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'status') { modelStatus = data.status; return; }
      const item = pending.get(data.id);
      if (!item) return;
      pending.delete(data.id);
      clearTimeout(item.timer);
      if (data.error) item.reject(new Error(data.error)); else item.resolve(data.result);
    };
    worker.onerror = () => resetWorker(new Error('Дауыс модулі ашылмады. Бетті жаңартып, қайта қосыңыз.'));
    worker.onmessageerror = () => resetWorker(new Error('Дауыс модулінің жауабы оқылмады. Қайта қосып көріңіз.'));
  }
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = type === 'analyze' ? setTimeout(() => {
      resetWorker(new Error('Дауыс модулі уақытында жауап бермеді. Қайта қосып көріңіз.'));
    }, 90_000) : undefined;
    pending.set(id, { resolve, reject, timer });
    try { worker.postMessage({ id, type, ...payload }); }
    catch (error) { resetWorker(error); }
  });
}

export function getModelStatus() { return browserMode ? Promise.resolve(modelStatus) : json('/api/model'); }
export async function prepareModel() {
  if (!browserMode) return json('/api/prepare', { method: 'POST' });
  modelStatus = { status: 'loading', progress: 0 };
  try {
    const result = await request('prepare');
    modelStatus = { status: 'ready', progress: 100 };
    return result;
  } catch (error) {
    modelStatus = { status: 'error', error: error.message };
    throw error;
  }
}
export function analyzeAudio({ page, audio, sampleRate, final }) {
  if (browserMode) return request('analyze', { page, audio, sampleRate, final });
  return json(`/api/analyze?page=${page.page}&final=${final}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Sample-Rate': String(sampleRate) }, body: audio,
  });
}
