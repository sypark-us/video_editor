// Media import (probing, thumbnails) and the Player that owns <video>/<audio>/<img> elements,
// seeks them for still frames and drives them during playback.
import { clipAt, transitionAt, localTime, videoTracks, audioTracks, mediaById, clipEnd, sequenceDuration, clipsOnTrack } from './model.js';
import { clipGain } from './audio.js';
import { clamp } from './util.js';

const wait = (el, ev, ms = 4000) => new Promise((res) => {
  let done = false; const fin = () => { if (!done) { done = true; el.removeEventListener(ev, fin); el.removeEventListener('error', fin); res(); } };
  el.addEventListener(ev, fin); el.addEventListener('error', fin); setTimeout(fin, ms);
});

export function mediaTypeOf(file) {
  const t = file.type || '';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('image/')) return 'image';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv', 'avi'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'oga'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image';
  return null;
}

// Probe a File into a media descriptor: {name, type, duration, width, height, hasAudio, url, file, thumb}
export async function probeFile(file) {
  const type = mediaTypeOf(file);
  if (!type) throw new Error(`Unsupported file: ${file.name}`);
  const url = URL.createObjectURL(file);
  const m = { name: file.name, type, duration: 0, width: 0, height: 0, hasAudio: type === 'audio', url, file, size: file.size, thumb: null };
  if (type === 'image') {
    const img = new Image(); img.src = url; await wait(img, 'load');
    m.width = img.naturalWidth; m.height = img.naturalHeight; m.duration = 5;
    m.thumb = thumbnail(img, m.width, m.height); m.element = img;
    return m;
  }
  const el = document.createElement(type === 'video' ? 'video' : 'audio');
  el.preload = 'metadata'; el.muted = true; el.src = url;
  await wait(el, 'loadedmetadata');
  if (!isFinite(el.duration)) { // MediaRecorder WebM files report Infinity until seeked to the end
    el.currentTime = 1e6; await wait(el, 'durationchange', 3000);
    if (!isFinite(el.duration)) await wait(el, 'seeked', 3000);
  }
  m.duration = isFinite(el.duration) ? el.duration : 0;
  if (type === 'video') {
    m.width = el.videoWidth; m.height = el.videoHeight;
    m.hasAudio = !!(el.mozHasAudio || el.webkitAudioDecodedByteCount || (el.audioTracks && el.audioTracks.length)) || true;
    try { el.currentTime = Math.min(1, m.duration * 0.1); await wait(el, 'seeked', 3000); m.thumb = thumbnail(el, m.width, m.height); } catch { }
  }
  el.removeAttribute('src'); el.load();
  return m;
}
export function thumbnail(src, w, h, tw = 160) {
  const c = document.createElement('canvas'); const s = Math.min(tw / w, 90 / h);
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  try { c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.7); } catch { return null; }
}

export class Player {
  constructor(getProject, audio) {
    this.getProject = getProject; this.audio = audio;
    this.els = new Map(); // clipId -> {el, mediaId, kind}
    this.images = new Map(); // mediaId -> Image
    this.playing = false; this.time = 0; this.rate = 1; this.loop = false;
    this.onTick = null; this.onStop = null;
    this._raf = 0; this._t0 = 0; this._c0 = 0;
  }
  // ---- element management ----
  element(c) {
    const p = this.getProject();
    const media = mediaById(p, c.mediaId); if (!media) return null;
    let rec = this.els.get(c.id);
    if (rec && rec.mediaId === media.id) return rec.el;
    if (rec) { rec.el.pause(); rec.el.removeAttribute('src'); }
    const el = document.createElement(media.type === 'audio' || c.kind === 'audio' ? 'audio' : 'video');
    el.preload = 'auto'; el.playsInline = true; el.crossOrigin = 'anonymous';
    if (c.kind === 'video') el.muted = true; // audio always comes from the linked audio clip
    el.src = media.url; el.load();
    rec = { el, mediaId: media.id, kind: c.kind };
    if (c.kind === 'audio') { try { this.audio.connect(el); } catch { } }
    this.els.set(c.id, rec);
    return el;
  }
  image(media) {
    if (media.element) return media.element;
    let img = this.images.get(media.id);
    if (!img) { img = new Image(); img.src = media.url; this.images.set(media.id, img); }
    return img;
  }
  // Drop elements of clips that no longer exist.
  gc() {
    const p = this.getProject(); const ids = new Set(p.clips.map((c) => c.id));
    for (const [id, rec] of this.els) if (!ids.has(id)) { rec.el.pause(); rec.el.removeAttribute('src'); rec.el.load(); this.els.delete(id); }
  }
  // Source for the compositor.
  getSource = (c, mt) => {
    const p = this.getProject();
    const media = mediaById(p, c.mediaId); if (!media) return null;
    if (media.type === 'image') { const img = this.image(media); return img.complete && img.naturalWidth ? { el: img, w: img.naturalWidth, h: img.naturalHeight } : null; }
    const el = this.element(c); if (!el || el.readyState < 2 || !el.videoWidth) return null;
    return { el, w: el.videoWidth, h: el.videoHeight };
  };

  // Clips that need a source at time t (including transition handles).
  activeClips(t) {
    const p = this.getProject(); const out = [];
    for (const tr of p.tracks) {
      if (tr.kind === 'video' && tr.hidden) continue;
      const trans = tr.kind === 'video' ? transitionAt(p, tr.id, t) : null;
      if (trans) { if (trans.a) out.push(trans.a); if (trans.b) out.push(trans.b); }
      else { const c = clipAt(p, tr.id, t); if (c && c.enabled !== false) out.push(c); }
    }
    return out;
  }

  // Seek every media-backed clip at t so that a still frame can be drawn; resolves when ready.
  async seek(t, { preroll = true } = {}) {
    const p = this.getProject();
    const waits = [];
    const active = this.activeClips(t);
    for (const c of active) {
      if (!c.mediaId) continue;
      const media = mediaById(p, c.mediaId);
      if (!media || media.type === 'image') { if (media) { const img = this.image(media); if (!img.complete) waits.push(wait(img, 'load', 2000)); } continue; }
      const el = this.element(c); if (!el) continue;
      if (!el.paused) el.pause();
      const mt = clamp(localTime(c, t), 0, Math.max(0, (isFinite(el.duration) ? el.duration : media.duration) - 0.001));
      if (el.readyState < 1) waits.push(wait(el, 'loadedmetadata', 4000).then(() => { el.currentTime = mt; return wait(el, 'seeked', 4000); }));
      else if (Math.abs(el.currentTime - mt) > 0.5 / p.fps || el.readyState < 2) { el.currentTime = mt; waits.push(wait(el, 'seeked', 4000)); }
    }
    // Pre-roll: warm up the next clips so cuts don't stall.
    if (preroll) for (const c of this.upcoming(t, 2)) { const el = c.mediaId && this.element(c); if (el && el.readyState < 1) { /* loading */ } }
    if (waits.length) await Promise.all(waits);
  }
  upcoming(t, horizon) {
    const p = this.getProject();
    return p.clips.filter((c) => c.mediaId && c.start > t && c.start < t + horizon);
  }

  // ---- playback ----
  play(t, { end = null, rate = 1 } = {}) {
    if (this.playing) this.stop(false);
    this.audio.ensure(); this.audio.resume();
    this.playing = true; this.rate = rate; this.time = t; this.end = end;
    this._t0 = t; this._c0 = this.audio.currentTime;
    const tick = () => {
      if (!this.playing) return;
      const now = this.audio.currentTime;
      let tt = this._t0 + (now - this._c0) * this.rate;
      const p = this.getProject();
      const limit = this.end ?? sequenceDuration(p);
      if ((this.rate > 0 && tt >= limit) || (this.rate < 0 && tt <= 0)) {
        if (this.loop && this.rate > 0) { this._t0 = this.loopStart ?? 0; this._c0 = now; tt = this._t0; }
        else { this.time = this.rate > 0 ? limit : 0; this.syncElements(this.time, false); this.stop(true); return; }
      }
      this.time = tt;
      this.syncElements(tt, true);
      if (this.onTick) this.onTick(tt);
      this._raf = requestAnimationFrame(tick);
    };
    this.syncElements(t, true);
    this._raf = requestAnimationFrame(tick);
  }
  stop(notify = true) {
    if (!this.playing) return;
    this.playing = false; cancelAnimationFrame(this._raf);
    for (const rec of this.els.values()) { if (!rec.el.paused) rec.el.pause(); this.audio.setGain(rec.el, 0); }
    if (notify && this.onStop) this.onStop(this.time);
  }
  syncElements(t, playing) {
    const p = this.getProject();
    const active = new Set();
    for (const c of this.activeClips(t)) {
      if (!c.mediaId) continue;
      const media = mediaById(p, c.mediaId); if (!media || media.type === 'image') continue;
      const el = this.element(c); if (!el) continue;
      active.add(el);
      const mt = localTime(c, t);
      const dur = isFinite(el.duration) ? el.duration : media.duration;
      if (c.kind === 'audio') this.audio.setGain(el, playing ? clipGain(p, c, t) : 0);
      if (mt < 0 || mt > dur) { if (!el.paused) el.pause(); continue; }
      const r = clamp((c.speed || 1) * (this.rate > 0 ? this.rate : 1), 0.0625, 16);
      if (el.playbackRate !== r) { try { el.playbackRate = r; } catch { } }
      if (!playing || this.rate < 0) { // reverse/scrub: step frames
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - mt) > 0.5 / p.fps) el.currentTime = mt;
        continue;
      }
      if (el.paused) { el.currentTime = mt; el.play().catch(() => { }); }
      else if (Math.abs(el.currentTime - mt) > 0.15) el.currentTime = mt;
    }
    for (const rec of this.els.values()) if (!active.has(rec.el) && !rec.el.paused) { rec.el.pause(); this.audio.setGain(rec.el, 0); }
  }
}
