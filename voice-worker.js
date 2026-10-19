import { pipeline, env } from './vendor/transformers.min.js';
import { alignWords } from './lib/align.js';
import { sequentialProgress, glyphsConfirmed } from './lib/progress.js';
import { audioRms, decodeFloat32 } from './lib/audio.js';

// GitHub Pages cannot set cross-origin isolation headers. Use a single WASM
// thread inside this worker so loading and inference do not block the reader.
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
const modelId = 'eventhorizon0/tarteel-ai-onnx-whisper-base-ar-quran';
let modelPromise;
let busy = false;
const status = (value) => self.postMessage({ type: 'status', status: value });

function prepare() {
  if (!modelPromise) {
    const files = new Map();
    modelPromise = pipeline('automatic-speech-recognition', modelId, {
      revision: '86aa2ae915f3b11c60b4c031774a7b5123477ba5',
      device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
      progress_callback: (event) => {
        if (event.status !== 'progress') return;
        files.set(event.file, { loaded: event.loaded || 0, total: event.total || 1 });
        const all = [...files.values()];
        const progress = Math.round(100 * all.reduce((n, f) => n + f.loaded, 0) / all.reduce((n, f) => n + f.total, 0));
        status({ status: 'loading', progress });
      },
    }).then((model) => { status({ status: 'ready', progress: 100 }); return model; })
      .catch((error) => { modelPromise = null; status({ status: 'error', error: error.message }); throw error; });
  }
  return modelPromise;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'prepare') { await prepare(); self.postMessage({ id: data.id, result: { ready: true } }); return; }
    if (data.type !== 'analyze') throw new Error('Белгісіз дауыс әрекеті');
    if (busy) throw new Error('Алдыңғы жазба әлі тексерілуде');
    busy = true;
    try {
      const audio = decodeFloat32(data.audio, data.sampleRate);
      if (audioRms(audio) < 0.002) { self.postMessage({ id: data.id, result: { quiet: true, transcript: '' } }); return; }
      const model = await prepare();
      const output = await model(audio, { chunk_length_s: 25, stride_length_s: 3, max_new_tokens: 160 });
      const transcript = String(output?.text || '').trim();
      const words = data.page.lines.flatMap((line) => line.type === 'ayah' ? line.words.filter((word) => !word.marker) : []);
      const expected = words.map((word) => word.text).join(' ');
      const allowBasmala = data.page.lines.some((line) => line.type === 'basmallah');
      const progress = sequentialProgress(expected, transcript, { allowBasmala });
      progress.confirmedGlyphs = glyphsConfirmed(words, progress.confirmed);
      self.postMessage({ id: data.id, result: { quiet: false, transcript, progress, ...alignWords(expected, transcript, { final: data.final }) } });
    } finally { busy = false; }
  } catch (error) { self.postMessage({ id: data.id, error: error.message || String(error) }); }
};
