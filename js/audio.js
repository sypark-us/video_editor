// Audio engine: live playback graph (per-clip gain), offline mix rendering for export, waveform peaks.
import { audioTracks, trackById, getProp, clipEnd, mediaById } from './model.js';
import { clamp } from './util.js';

// Effective linear gain of an audio clip at timeline time t (keyframes, fades, track mute/solo).
export function clipGain(p, c, t) {
  if (c.enabled === false || c.muted) return 0;
  const track = trackById(p, c.trackId);
  if (!track || track.muted) return 0;
  const anySolo = audioTracks(p).some((tr) => tr.solo);
  if (anySolo && !track.solo) return 0;
  const lt = t - c.start;
  let g = Math.max(0, getProp(c, 'volume', lt)) * (track.volume ?? 1);
  if (c.fadeIn > 0 && lt < c.fadeIn) g *= clamp(lt / c.fadeIn, 0, 1);
  const rem = c.duration - lt;
  if (c.fadeOut > 0 && rem < c.fadeOut) g *= clamp(rem / c.fadeOut, 0, 1);
  return g;
}

export class AudioEngine {
  constructor() { this.ctx = null; this.master = null; this.analyser = null; this.buffers = new Map(); this.sources = new WeakMap(); this.streamDest = null; }
  ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ sampleRate: 48000 });
    this.master = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 1024;
    this.master.connect(this.analyser); this.analyser.connect(this.ctx.destination);
    return this.ctx;
  }
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }
  get currentTime() { return this.ctx ? this.ctx.currentTime : performance.now() / 1000; }

  // Connect a media element through a fresh gain node (one source per element is allowed).
  connect(el) {
    this.ensure();
    let rec = this.sources.get(el);
    if (rec) return rec.gain;
    const src = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain(); gain.gain.value = 0;
    src.connect(gain); gain.connect(this.master);
    rec = { src, gain }; this.sources.set(el, rec);
    return gain;
  }
  setGain(el, g) {
    const rec = this.sources.get(el); if (!rec) return;
    rec.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
  }
  level() { // peak level 0..1 of the master bus
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize); this.analyser.getFloatTimeDomainData(buf);
    let m = 0; for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
    return m;
  }
  captureStream() { this.ensure(); if (!this.streamDest) { this.streamDest = this.ctx.createMediaStreamDestination(); this.master.connect(this.streamDest); } return this.streamDest.stream; }

  // Decode a media file's audio to an AudioBuffer (cached). Returns null when there is no decodable audio.
  async decode(media) {
    if (this.buffers.has(media.id)) return this.buffers.get(media.id);
    const task = (async () => {
      try {
        const ab = media.file ? await media.file.arrayBuffer() : await (await fetch(media.url)).arrayBuffer();
        const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const octx = new AC(2, 48000, 48000);
        return await octx.decodeAudioData(ab);
      } catch { return null; }
    })();
    this.buffers.set(media.id, task);
    const buf = await task; this.buffers.set(media.id, buf); return buf;
  }

  // Waveform peaks: Float32Array with `perSec` values per second (max abs over the window).
  async peaks(media, perSec = 50) {
    const buf = await this.decode(media);
    if (!buf) return null;
    const n = Math.ceil(buf.duration * perSec), out = new Float32Array(n);
    const win = Math.floor(buf.sampleRate / perSec);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        let m = 0; const s0 = i * win, s1 = Math.min(d.length, s0 + win);
        for (let s = s0; s < s1; s += 4) { const v = Math.abs(d[s]); if (v > m) m = v; }
        if (m > out[i]) out[i] = m;
      }
    }
    return out;
  }

  // Offline render of all audio clips in [t0, t1) to a stereo AudioBuffer.
  async renderMix(p, t0, t1, sampleRate = 48000, onProgress = null) {
    const len = Math.max(1, Math.ceil((t1 - t0) * sampleRate));
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const octx = new AC(2, len, sampleRate);
    const clips = p.clips.filter((c) => c.kind === 'audio' && c.mediaId && c.start < t1 && clipEnd(c) > t0);
    let i = 0;
    for (const c of clips) {
      const media = mediaById(p, c.mediaId);
      const buf = media ? await this.decode(media) : null;
      if (onProgress) onProgress(++i / Math.max(1, clips.length));
      if (!buf) continue;
      const src = octx.createBufferSource(); src.buffer = buf; src.playbackRate.value = c.speed || 1;
      const gain = octx.createGain();
      src.connect(gain); gain.connect(octx.destination);
      const cs = Math.max(c.start, t0), ce = Math.min(clipEnd(c), t1);
      // Gain envelope sampled at 100 Hz.
      const steps = Math.max(2, Math.ceil((ce - cs) * 100));
      const curve = new Float32Array(steps);
      for (let k = 0; k < steps; k++) curve[k] = clipGain(p, c, cs + ((ce - cs) * k) / (steps - 1));
      try { gain.gain.setValueCurveAtTime(curve, Math.max(0, cs - t0), Math.max(0.001, ce - cs)); } catch { gain.gain.value = curve[0]; }
      const offset = c.inPoint + (cs - c.start) * (c.speed || 1);
      if (offset < buf.duration) src.start(Math.max(0, cs - t0), Math.max(0, offset), Math.max(0, (ce - cs) * (c.speed || 1)));
    }
    return octx.startRendering();
  }
}
