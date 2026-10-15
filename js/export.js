// Export: MP4 (H.264 + AAC/Opus) through WebCodecs and our own muxer, or WebM via MediaRecorder (realtime).
import { Mp4Muxer } from './mp4mux.js';
import { sequenceDuration } from './model.js';

export const canUseWebCodecs = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

function h264Codec(w, h, fps) {
  const mb = (w * h) / 256 * fps; // macroblocks per second
  if (w * h > 1920 * 1088 || mb > 245760) return 'avc1.640033'; // High 5.1
  if (w * h > 1280 * 720 || mb > 108000) return 'avc1.640028'; // High 4.0
  return 'avc1.64001f'; // High 3.1
}

export async function pickVideoConfig(width, height, fps, bitrate) {
  const base = { width, height, framerate: fps, bitrate, latencyMode: 'quality', avc: { format: 'avc' } };
  const candidates = [h264Codec(width, height, fps), 'avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'avc1.42001f'];
  for (const codec of candidates) {
    for (const hw of ['no-preference', 'prefer-software']) {
      const cfg = { ...base, codec, hardwareAcceleration: hw };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return cfg; } catch { }
    }
  }
  return null;
}
export async function pickAudioConfig(sampleRate, channels) {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const [codec, kind] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate, numberOfChannels: channels, bitrate: 160000 };
    try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return { cfg, kind }; } catch { }
  }
  return null;
}

/**
 * Render the sequence to an MP4 blob.
 * @param {object} o { project, player, compositor, audio, width, height, fps, bitrate, t0, t1, includeAudio, onProgress, signal }
 */
export async function exportMp4(o) {
  const { project: p, player, compositor, audio } = o;
  const fps = o.fps || p.fps, width = o.width || p.width, height = o.height || p.height;
  const t0 = o.t0 ?? 0, t1 = o.t1 ?? sequenceDuration(p);
  const nFrames = Math.max(1, Math.round((t1 - t0) * fps));
  const vcfg = await pickVideoConfig(width, height, fps, o.bitrate || 8_000_000);
  if (!vcfg) throw new Error('No H.264 encoder available in this browser');
  const progress = (phase, f) => o.onProgress && o.onProgress(phase, f);
  const check = () => { if (o.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError'); };

  // Audio first (offline render is fast), so the video phase reports linear progress.
  let acfgPick = null, mix = null;
  if (o.includeAudio !== false && p.clips.some((c) => c.kind === 'audio')) {
    progress('audio', 0);
    mix = await audio.renderMix(p, t0, t1, 48000, (f) => progress('audio', f * 0.5));
    acfgPick = await pickAudioConfig(mix.sampleRate, mix.numberOfChannels);
  }
  const muxer = new Mp4Muxer({ width, height, fps, audio: acfgPick ? { codec: acfgPick.kind, sampleRate: mix.sampleRate, channels: mix.numberOfChannels } : null });

  if (acfgPick) {
    let aerr = null;
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { aerr = e; } });
    aenc.configure(acfgPick.cfg);
    const frames = 1024, total = mix.length, ch = mix.numberOfChannels;
    for (let off = 0; off < total; off += frames) {
      check();
      const n = Math.min(frames, total - off);
      const data = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) data.set(mix.getChannelData(c).subarray(off, off + n), c * n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: mix.sampleRate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((off / mix.sampleRate) * 1e6), data });
      aenc.encode(ad); ad.close();
      if (aenc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
      if (off % (frames * 64) === 0) progress('audio', 0.5 + (off / total) * 0.5);
    }
    await aenc.flush(); aenc.close();
    if (aerr) throw aerr;
  }

  // Video.
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  let verr = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { verr = e; } });
  venc.configure(vcfg);
  const wasPlaying = player.playing; if (wasPlaying) player.stop();
  const gop = Math.round(fps * 2);
  for (let i = 0; i < nFrames; i++) {
    check(); if (verr) throw verr;
    const t = t0 + i / fps;
    await player.seek(t, { preroll: false });
    compositor.render(ctx, p, t, player.getSource);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: i % gop === 0 });
    frame.close();
    while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
    if (i % 5 === 0) progress('video', i / nFrames);
  }
  await venc.flush(); venc.close();
  if (verr) throw verr;
  progress('mux', 1);
  const bytes = muxer.finalize();
  return new Blob([bytes], { type: 'video/mp4' });
}

// Realtime WebM export through MediaRecorder (fallback when WebCodecs is unavailable).
export async function exportWebm(o) {
  const { project: p, player, compositor, audio } = o;
  const fps = o.fps || p.fps, width = o.width || p.width, height = o.height || p.height;
  const t0 = o.t0 ?? 0, t1 = o.t1 ?? sequenceDuration(p);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(fps);
  if (o.includeAudio !== false) for (const tr of audio.captureStream().getAudioTracks()) stream.addTrack(tr);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: o.bitrate || 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  await player.seek(t0);
  compositor.render(ctx, p, t0, player.getSource);
  rec.start(250);
  await new Promise((resolve, reject) => {
    player.onTick = (t) => { compositor.render(ctx, p, t, player.getSource); if (o.onProgress) o.onProgress('video', (t - t0) / (t1 - t0)); if (o.signal?.aborted) { player.stop(); reject(new DOMException('Export cancelled', 'AbortError')); } };
    player.onStop = () => resolve();
    player.play(t0, { end: t1 });
  });
  rec.stop(); await done;
  return new Blob(chunks, { type: 'video/webm' });
}

export function exportFrame(project, compositor, player, t) {
  const canvas = document.createElement('canvas'); canvas.width = project.width; canvas.height = project.height;
  return player.seek(t).then(() => { compositor.render(canvas.getContext('2d'), project, t, player.getSource); return new Promise((r) => canvas.toBlob(r, 'image/png')); });
}
