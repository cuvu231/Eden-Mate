let context;
let source;
let gain;
let tinglongBuffer;
function stop() {
  const oldSource = source;
  const oldGain = gain;
  source = undefined;
  gain = undefined;
  if (!oldSource) { oldGain?.disconnect(); return; }
  const now = context?.currentTime || 0;
  try {
    oldGain?.gain.cancelScheduledValues(now);
    oldGain?.gain.setValueAtTime(Math.max(0.0001, oldGain.gain.value), now);
    oldGain?.gain.linearRampToValueAtTime(0.0001, now + 0.055);
    oldSource.onended = () => { oldSource.disconnect(); oldGain?.disconnect(); };
    oldSource.stop(now + 0.06);
  } catch (_) {
    try { oldSource.disconnect(); } catch (_) {}
    oldGain?.disconnect();
  }
}
async function getAudioContext() {
  context ||= new (window.AudioContext || window.webkitAudioContext)();
  if (context.state === 'suspended') await context.resume();
  return context;
}
async function getTinglongBuffer(audio) {
  if (!tinglongBuffer) {
    const response = await fetch(chrome.runtime.getURL('sounds/tinglong.wav'));
    tinglongBuffer = await audio.decodeAudioData(await response.arrayBuffer());
  }
  return tinglongBuffer;
}
async function playOnce(volume, soundType = 'classic') {
  const audio = await getAudioContext();
  if (soundType === 'tinglong') {
    const sample = await getTinglongBuffer(audio);
    const sampleSource = audio.createBufferSource();
    const sampleGain = audio.createGain();
    sampleSource.buffer = sample;
    sampleGain.gain.value = volume;
    sampleSource.connect(sampleGain); sampleGain.connect(audio.destination);
    sampleSource.start();
    return;
  }
  const now = audio.currentTime;
  const peak = 0.12 + volume * 0.68;
  const notes = [[880, 0, 0.45], [659, 0.38, 0.55]];
  notes.forEach(([frequency, offset, duration]) => {
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    envelope.gain.setValueAtTime(0.0001, now + offset);
    envelope.gain.exponentialRampToValueAtTime(peak, now + offset + 0.03);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration);
    oscillator.connect(envelope); envelope.connect(audio.destination);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    oscillator.start(now + offset); oscillator.stop(now + offset + duration + 0.05);
  });
}
async function buildLoop(volume, soundType = 'classic') {
  const audio = await getAudioContext();
  stop();
  const sampleRate = audio.sampleRate;
  const duration = 2.4;
  if (soundType === 'tinglong') {
    const sample = await getTinglongBuffer(audio);
    const buffer = audio.createBuffer(1, Math.ceil(sampleRate * duration), sampleRate);
    buffer.getChannelData(0).set(sample.getChannelData(0));
    source = audio.createBufferSource();
    gain = audio.createGain();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.value = volume;
    source.connect(gain); gain.connect(audio.destination); source.start();
    return;
  }
  const peak = 0.12 + volume * 0.68;
  const buffer = audio.createBuffer(1, Math.ceil(sampleRate * duration), sampleRate);
  const data = buffer.getChannelData(0);
  const notes = [[880, 0, 0.45], [659, 0.38, 0.55]];
  notes.forEach(([frequency, start, toneDuration]) => {
    const begin = Math.floor(start * sampleRate);
    const length = Math.floor(toneDuration * sampleRate);
    for (let i = 0; i < length && begin + i < data.length; i++) {
      const t = i / sampleRate;
      const envelope = Math.min(1, t / 0.025) * Math.exp(-Math.max(0, t - 0.025) * 17);
      data[begin + i] += Math.sin(2 * Math.PI * frequency * t) * envelope * peak;
    }
  });
  source = audio.createBufferSource();
  gain = audio.createGain();
  source.buffer = buffer;
  source.loop = true;
  gain.gain.value = 1;
  source.connect(gain); gain.connect(audio.destination); source.start();
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'eden-offscreen') return;
  if (message.type === 'ping') { sendResponse({ ready: true }); return; }
  const volume = Math.max(0, Math.min(1, Number(message.volume) || 0));
  const soundType = message.soundType === 'tinglong' ? 'tinglong' : 'classic';
  if (message.type === 'play-once') {
    playOnce(volume, soundType).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'start-repeat') {
    buildLoop(volume, soundType).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'set-volume' && source) buildLoop(volume, soundType).catch(() => {});
  if (message.type === 'stop-repeat') stop();
  sendResponse({ ok: true });
});
