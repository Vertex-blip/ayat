export function decodeFloat32(buffer, sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error('Invalid sample rate');
  }
  if (buffer.byteLength < sampleRate * 4 / 2 || buffer.byteLength > 192000 * 4 * 181 || buffer.byteLength % 4) {
    throw new Error('Audio must be 0.5–180 seconds of Float32 samples');
  }
  const source = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const targetRate = 16000;
  const targetLength = Math.round(source.length * targetRate / sampleRate);
  const target = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i += 1) {
    const start = i * sampleRate / targetRate;
    const left = Math.floor(start);
    const fraction = start - left;
    const a = Number.isFinite(source[left]) ? source[left] : 0;
    const b = Number.isFinite(source[Math.min(left + 1, source.length - 1)]) ? source[Math.min(left + 1, source.length - 1)] : 0;
    target[i] = Math.max(-1, Math.min(1, a + (b - a) * fraction));
  }
  return target;
}

export function audioRms(audio) {
  let energy = 0;
  for (const sample of audio) energy += sample * sample;
  return Math.sqrt(energy / audio.length);
}
