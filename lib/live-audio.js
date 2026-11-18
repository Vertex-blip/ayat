// Keep inference tied to short utterances. A breath ends one transcript so a
// correction is checked from fresh audio instead of decoding the whole session.
export function createAudioSegments(sampleRate, { minimum = 0.8, interval = 0.6, silence = 0.6, maximum = 16, threshold = 0.004 } = {}) {
  let frames = [], samples = 0, quietSamples = 0, voiced = false, segment = 0, lastPreview = 0;
  let voicedSamples = 0, veryQuietSamples = 0, peakLevel = 0, heardVoice = false;
  let leading = new Float32Array();
  const completed = [];
  function snapshot(final) {
    const output = new Float32Array(leading.length + samples);
    output.set(leading);
    let offset = leading.length;
    for (const frame of frames) { output.set(frame, offset); offset += frame.length; }
    return { audio: output, sampleRate, segment, final, overlap: leading.length > 0 };
  }
  function seal(hardCut = false) {
    if (voiced && samples >= sampleRate / 2) {
      const result = snapshot(true);
      completed.push(result);
      // A time limit can fall in the middle of a word. Give the next
      // inference the preceding sound as context across that cut.
      leading = hardCut ? result.audio.slice(-Math.round(sampleRate * 1.25)) : new Float32Array();
    } else leading = new Float32Array();
    frames = []; samples = 0; quietSamples = 0; voiced = false; lastPreview = 0; segment++;
    voicedSamples = 0; veryQuietSamples = 0; peakLevel = 0;
  }
  return {
    get heardVoice() { return heardVoice; },
    push(frame) {
      if (!frame.length) return;
      let energy = 0;
      for (const value of frame) energy += value * value;
      const level = Math.sqrt(energy / frame.length);
      // A pause usually contains a breath or room noise. Measure it relative
      // to the spoken audio, with a cap so quieter words can still come through.
      const voice = level >= Math.max(threshold, Math.min(0.012, peakLevel * 0.08));
      veryQuietSamples = level < threshold / 2 ? veryQuietSamples + frame.length : 0;
      frames.push(frame); samples += frame.length;
      if (voice) {
        voicedSamples += frame.length;
        quietSamples = 0;
        if (voicedSamples >= sampleRate * 0.12) {
          voiced = true; heardVoice = true;
          peakLevel = Math.max(level, peakLevel * 0.98);
        }
      } else {
        voicedSamples = 0;
        quietSamples += frame.length;
      }
      if (!voiced) {
        if (leading.length && quietSamples >= sampleRate * silence) leading = new Float32Array();
        // Retain a little leading audio so soft word beginnings are not cut off.
        while (frames.length > 1 && samples - frames[0].length >= sampleRate * 0.25) samples -= frames.shift().length;
      } else if (quietSamples >= sampleRate * silence ||
        (samples >= sampleRate * maximum && veryQuietSamples >= sampleRate * 0.12)) seal();
      else if (leading.length + samples >= sampleRate * 25) seal(true);
    },
    take() {
      if (completed.length) return completed.shift();
      if (!voiced || samples < sampleRate * minimum || samples - lastPreview < sampleRate * interval) return null;
      lastPreview = samples;
      return snapshot(false);
    },
    finish() { seal(); },
  };
}
