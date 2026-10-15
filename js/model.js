// Pure project/sequence model: no DOM, usable from Node tests.
import { uid, clamp, lerp, EPS, deepClone } from './util.js';

export const PRESETS = [
  { name: '1080p 30 (Full HD)', width: 1920, height: 1080, fps: 30 },
  { name: '1080p 60', width: 1920, height: 1080, fps: 60 },
  { name: '1080p 24 (Film)', width: 1920, height: 1080, fps: 24 },
  { name: '720p 30', width: 1280, height: 720, fps: 30 },
  { name: '4K UHD 30', width: 3840, height: 2160, fps: 30 },
  { name: 'Vertical 1080x1920 (Shorts/Reels)', width: 1080, height: 1920, fps: 30 },
  { name: 'Square 1080x1080', width: 1080, height: 1080, fps: 30 },
];

export const TRANSITIONS = ['Cross Dissolve', 'Dip to Black', 'Dip to White', 'Wipe Left', 'Wipe Right', 'Wipe Up', 'Wipe Down', 'Push Left', 'Push Right', 'Iris', 'Zoom'];

// Video effects and their parameters: name -> [default, min, max] (or [hexColor] for colors).
export const EFFECTS = {
  'Brightness & Contrast': { params: { brightness: [0, -100, 100], contrast: [0, -100, 100] } },
  'Saturation': { params: { amount: [100, 0, 300] } },
  'Hue Shift': { params: { degrees: [0, -180, 180] } },
  'Gaussian Blur': { params: { radius: [5, 0, 100] } },
  'Black & White': { params: { amount: [100, 0, 100] } },
  'Sepia': { params: { amount: [100, 0, 100] } },
  'Invert': { params: { amount: [100, 0, 100] } },
  'Crop': { params: { left: [0, 0, 100], top: [0, 0, 100], right: [0, 0, 100], bottom: [0, 0, 100] } },
  'Flip': { params: { horizontal: [0, 0, 1], vertical: [0, 0, 1] } },
  'Chroma Key': { params: { color: ['#00ff00'], similarity: [30, 0, 100], smoothness: [10, 0, 100] } },
  'Vignette': { params: { amount: [50, 0, 100], size: [50, 0, 100] } },
  'Drop Shadow': { params: { distance: [10, 0, 200], angle: [135, 0, 360], blur: [10, 0, 100], opacity: [60, 0, 100] } },
  'Tint': { params: { color: ['#ff8800'], amount: [50, 0, 100] } },
  'Pixelate': { params: { size: [10, 1, 100] } },
};
export const ANIMATABLE = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'];

export function createProject(opts = {}) {
  const p = {
    version: 1,
    name: opts.name || 'Untitled',
    width: opts.width || 1920, height: opts.height || 1080, fps: opts.fps || 30,
    sampleRate: 48000,
    media: [], tracks: [], clips: [], markers: [],
    inPoint: null, outPoint: null,
  };
  for (let i = 0; i < (opts.videoTracks ?? 3); i++) addTrack(p, 'video');
  for (let i = 0; i < (opts.audioTracks ?? 3); i++) addTrack(p, 'audio');
  return p;
}

export function addTrack(p, kind, name) {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  const t = { id: uid('trk'), kind, name: name || (kind === 'video' ? `V${n}` : `A${n}`), muted: false, solo: false, locked: false, hidden: false, volume: 1 };
  p.tracks.push(t);
  return t;
}
export function removeTrack(p, trackId) {
  p.clips = p.clips.filter((c) => c.trackId !== trackId);
  p.tracks = p.tracks.filter((t) => t.id !== trackId);
  renameTracks(p);
}
export function renameTracks(p) {
  let v = 0, a = 0;
  for (const t of p.tracks) t.name = t.kind === 'video' ? `V${++v}` : `A${++a}`;
}
export const videoTracks = (p) => p.tracks.filter((t) => t.kind === 'video');
export const audioTracks = (p) => p.tracks.filter((t) => t.kind === 'audio');
export const trackById = (p, id) => p.tracks.find((t) => t.id === id);
export const clipById = (p, id) => p.clips.find((c) => c.id === id);
export const mediaById = (p, id) => p.media.find((m) => m.id === id);

export function addMedia(p, m) {
  const media = { id: uid('med'), name: 'media', type: 'video', duration: 0, width: 0, height: 0, hasAudio: false, size: 0, ...m };
  p.media.push(media);
  return media;
}
export function removeMedia(p, mediaId) {
  p.clips = p.clips.filter((c) => c.mediaId !== mediaId);
  p.media = p.media.filter((m) => m.id !== mediaId);
}

export function defaultTransform() { return { x: 0, y: 0, scale: 100, rotation: 0, opacity: 100 }; }
export function defaultText() {
  return { content: 'Title', font: 'Inter, Arial, sans-serif', size: 96, color: '#ffffff', bold: true, italic: false, align: 'center',
    background: '#000000', backgroundOpacity: 0, outline: 0, outlineColor: '#000000', shadow: 0, lineHeight: 1.2 };
}

// kind: 'video' | 'audio' | 'title' | 'color'
export function makeClip(spec) {
  return {
    id: uid('clip'), kind: 'video', mediaId: null, trackId: null, name: 'Clip',
    start: 0, duration: 5, inPoint: 0, speed: 1, linkId: null, enabled: true,
    transform: defaultTransform(), keyframes: {}, effects: [],
    volume: 1, fadeIn: 0, fadeOut: 0, muted: false,
    text: null, color: '#1f6feb', transitionIn: null, transitionOut: null,
    ...spec,
  };
}
export const clipEnd = (c) => c.start + c.duration;
export const clipsOnTrack = (p, trackId) => p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
export function clipAt(p, trackId, t) {
  return p.clips.find((c) => c.trackId === trackId && t >= c.start - EPS && t < clipEnd(c) - EPS);
}
export function clipsInRange(p, t0, t1) { return p.clips.filter((c) => c.start < t1 - EPS && clipEnd(c) > t0 + EPS); }
export function sequenceDuration(p) { return p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0); }
// Media-local time for a timeline time t inside clip c.
export const localTime = (c, t) => c.inPoint + (t - c.start) * c.speed;
export function mediaDuration(p, c) {
  const m = c.mediaId ? mediaById(p, c.mediaId) : null;
  return m && m.type !== 'image' ? m.duration : Infinity;
}
// Longest the clip may extend to the right given its source length.
export function maxDuration(p, c) {
  const md = mediaDuration(p, c);
  return isFinite(md) ? Math.max(0, (md - c.inPoint) / c.speed) : Infinity;
}

// Overwrite semantics: placing [t0,t1) on a track trims/removes/splits whatever is there.
export function clearRange(p, trackId, t0, t1, except = []) {
  const added = [];
  for (const c of clipsOnTrack(p, trackId)) {
    if (except.includes(c.id)) continue;
    const e = clipEnd(c);
    if (e <= t0 + EPS || c.start >= t1 - EPS) continue;
    if (c.start >= t0 - EPS && e <= t1 + EPS) { p.clips.splice(p.clips.indexOf(c), 1); continue; }
    if (c.start < t0 && e > t1) { // split around the range
      const right = splitClipAt(p, c, t1); trimRight(p, c, t0); added.push(right); continue;
    }
    if (c.start < t0) trimRight(p, c, t0); else trimLeft(p, c, t1);
  }
  return added;
}

function trimRight(p, c, newEnd) { c.duration = Math.max(0, newEnd - c.start); }
function trimLeft(p, c, newStart) {
  const d = newStart - c.start;
  c.inPoint += d * c.speed; c.start = newStart; c.duration -= d;
  shiftKeyframes(c, -d);
}
function shiftKeyframes(c, dt) {
  if (!dt) return;
  for (const k of Object.keys(c.keyframes || {})) c.keyframes[k] = c.keyframes[k].map((kf) => ({ ...kf, t: kf.t + dt }));
}

// Split a clip at timeline time t; returns the new right-hand clip (or null).
export function splitClipAt(p, c, t) {
  if (t <= c.start + EPS || t >= clipEnd(c) - EPS) return null;
  const right = deepClone(c);
  right.id = uid('clip');
  right.start = t; right.duration = clipEnd(c) - t; right.inPoint = localTime(c, t);
  right.transitionIn = null; right.fadeIn = 0;
  c.duration = t - c.start; c.transitionOut = null; c.fadeOut = Math.min(c.fadeOut, c.duration);
  right.fadeOut = Math.min(right.fadeOut, right.duration);
  shiftKeyframes(right, -(t - c.start));
  p.clips.splice(p.clips.indexOf(c) + 1, 0, right);
  return right;
}
// Split every clip (on unlocked tracks) crossing t. Linked clips get matching new linkIds.
export function splitAll(p, t, ids = null) {
  const out = [];
  const linkMap = new Map();
  for (const c of [...p.clips]) {
    if (ids && !ids.includes(c.id)) continue;
    if (trackById(p, c.trackId)?.locked) continue;
    if (t > c.start + EPS && t < clipEnd(c) - EPS) {
      const r = splitClipAt(p, c, t);
      if (r) {
        out.push(r);
        if (c.linkId) { if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('lnk')); r.linkId = linkMap.get(c.linkId); }
      }
    }
  }
  return out;
}

export function trimClip(p, c, edge, t, { ripple = false } = {}) {
  const sib = clipsOnTrack(p, c.trackId);
  const idx = sib.indexOf(c);
  const minLen = 1 / p.fps;
  if (edge === 'start') {
    const prev = idx > 0 ? sib[idx - 1] : null;
    let lo = ripple ? -Infinity : (prev ? clipEnd(prev) : 0);
    lo = Math.max(lo, 0, c.start - c.inPoint / c.speed); // cannot go before media start
    const ns = clamp(t, lo, clipEnd(c) - minLen);
    const d = ns - c.start;
    trimLeft(p, c, ns);
    if (ripple) { // keep the clip where it was and shift it and everything after it
      c.start -= d; shiftKeyframes(c, 0);
      rippleAfter(p, c.trackId, clipEnd(c) + d, -d, [c.id]);
    }
  } else {
    const next = idx < sib.length - 1 ? sib[idx + 1] : null;
    const hi = Math.min(ripple || !next ? Infinity : next.start, c.start + maxDuration(p, c));
    const ne = clamp(t, c.start + minLen, hi);
    const oldEnd = clipEnd(c);
    trimRight(p, c, ne);
    if (ripple) rippleAfter(p, c.trackId, oldEnd, ne - oldEnd, [c.id]);
  }
}
function rippleAfter(p, trackId, from, delta, except = []) {
  for (const o of p.clips) if (o.trackId === trackId && !except.includes(o.id) && o.start >= from - EPS) o.start += delta;
}

export function deleteClips(p, ids) { p.clips = p.clips.filter((c) => !ids.includes(c.id)); }
// Ripple delete: remove clips, then close each resulting gap on that track.
export function rippleDeleteClips(p, ids) {
  const victims = p.clips.filter((c) => ids.includes(c.id));
  const byTrack = new Map();
  for (const c of victims) { if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []); byTrack.get(c.trackId).push(c); }
  deleteClips(p, ids);
  for (const [trackId, list] of byTrack) {
    list.sort((a, b) => b.start - a.start); // close gaps right-to-left so earlier shifts don't disturb later ones
    for (const c of list) {
      const gapEnd = clipEnd(c);
      const occupied = clipsOnTrack(p, trackId).some((o) => o.start < gapEnd - EPS && clipEnd(o) > c.start + EPS);
      if (!occupied) rippleAfter(p, trackId, gapEnd, -c.duration);
    }
  }
}
// Close the gap at time t on a track (ripple delete gap).
export function closeGap(p, trackId, t) {
  const sib = clipsOnTrack(p, trackId);
  if (sib.some((c) => t >= c.start - EPS && t < clipEnd(c) - EPS)) return false;
  const next = sib.find((c) => c.start > t + EPS);
  if (!next) return false;
  const prev = [...sib].reverse().find((c) => clipEnd(c) <= t + EPS);
  const gapStart = prev ? clipEnd(prev) : 0;
  const gap = next.start - gapStart;
  if (gap <= EPS) return false;
  rippleAfter(p, trackId, next.start, -gap);
  return true;
}

// Move clips by dt (and optionally to another track). Overwrite mode unless insert.
export function moveClips(p, ids, dt, trackMap = new Map(), { insert = false } = {}) {
  const moving = p.clips.filter((c) => ids.includes(c.id));
  if (!moving.length) return 0;
  const minStart = Math.min(...moving.map((c) => c.start));
  if (minStart + dt < 0) dt = -minStart;
  for (const c of moving) {
    c.start += dt;
    if (trackMap.has(c.id)) c.trackId = trackMap.get(c.id);
  }
  for (const c of moving) {
    if (insert) insertSpace(p, c.trackId, c.start, c.duration, ids);
    else clearRange(p, c.trackId, c.start, clipEnd(c), ids);
  }
  return dt;
}
function insertSpace(p, trackId, at, len, except = []) {
  for (const o of clipsOnTrack(p, trackId)) {
    if (except.includes(o.id)) continue;
    if (clipEnd(o) > at + EPS && o.start < at - EPS) { const r = splitClipAt(p, o, at); if (r) r.start += len; }
    else if (o.start >= at - EPS) o.start += len;
  }
}

export function placeClip(p, clip, trackId, start, { insert = false } = {}) {
  clip.trackId = trackId; clip.start = Math.max(0, start);
  if (insert) insertSpace(p, trackId, clip.start, clip.duration);
  else clearRange(p, trackId, clip.start, clipEnd(clip));
  p.clips.push(clip);
  return clip;
}

// Linked (A/V) groups.
export const linkedClips = (p, c) => (c.linkId ? p.clips.filter((o) => o.linkId === c.linkId) : [c]);
export function expandSelection(p, ids) {
  const out = new Set(ids);
  for (const id of ids) { const c = clipById(p, id); if (c) for (const l of linkedClips(p, c)) out.add(l.id); }
  return [...out];
}
export function unlink(p, ids) { for (const id of ids) { const c = clipById(p, id); if (c) c.linkId = null; } }
export function link(p, ids) { const l = uid('lnk'); for (const id of ids) { const c = clipById(p, id); if (c) c.linkId = l; } }

// ---- keyframes ----
// kf list: [{t (clip-local seconds), v, ease: 'linear'|'ease'|'hold'}]
export function isAnimated(c, prop) { return Array.isArray(c.keyframes?.[prop]) && c.keyframes[prop].length > 0; }
export function getProp(c, prop, lt) {
  const base = prop === 'volume' ? c.volume : c.transform[prop];
  const kfs = c.keyframes?.[prop];
  if (!kfs || !kfs.length) return base;
  if (lt <= kfs[0].t) return kfs[0].v;
  if (lt >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (lt >= a.t && lt <= b.t) {
      if (a.ease === 'hold') return a.v;
      let u = (lt - a.t) / Math.max(EPS, b.t - a.t);
      if (a.ease === 'ease') u = u * u * (3 - 2 * u);
      return lerp(a.v, b.v, u);
    }
  }
  return base;
}
export function setKeyframe(c, prop, lt, v, ease = 'linear') {
  if (!c.keyframes) c.keyframes = {};
  const list = (c.keyframes[prop] ||= []);
  const ex = list.find((k) => Math.abs(k.t - lt) < 1e-4);
  if (ex) { ex.v = v; return ex; }
  const kf = { t: lt, v, ease };
  list.push(kf); list.sort((a, b) => a.t - b.t);
  return kf;
}
export function removeKeyframe(c, prop, lt) {
  const list = c.keyframes?.[prop]; if (!list) return;
  c.keyframes[prop] = list.filter((k) => Math.abs(k.t - lt) >= 1e-4);
  if (!c.keyframes[prop].length) delete c.keyframes[prop];
}
export function clearKeyframes(c, prop) { if (c.keyframes) delete c.keyframes[prop]; }

// ---- transitions ----
// Returns {type, duration, a, b, progress, t0, t1} when t lies inside a transition on this track, else null.
// A transition is stored on the incoming clip (transitionIn) or outgoing clip (transitionOut); when the
// neighbouring clip butts against it the transition is centred on the cut, otherwise it fades from/to black.
export function transitionAt(p, trackId, t) {
  const sib = clipsOnTrack(p, trackId);
  for (let i = 0; i < sib.length; i++) {
    const b = sib[i];
    const tin = b.transitionIn;
    if (tin && tin.duration > 0) {
      const a = i > 0 && Math.abs(clipEnd(sib[i - 1]) - b.start) < 1e-3 ? sib[i - 1] : null;
      const half = a ? tin.duration / 2 : 0;
      const t0 = b.start - half, t1 = b.start + (a ? half : tin.duration);
      if (t >= t0 && t < t1) return { type: tin.type, duration: tin.duration, a, b, progress: (t - t0) / (t1 - t0), t0, t1 };
    }
    const tout = b.transitionOut;
    if (tout && tout.duration > 0) {
      const n = i < sib.length - 1 && Math.abs(clipEnd(b) - sib[i + 1].start) < 1e-3 ? sib[i + 1] : null;
      if (n && n.transitionIn && n.transitionIn.duration > 0) continue; // handled as n's transitionIn
      const e = clipEnd(b);
      const t0 = e - (n ? tout.duration / 2 : tout.duration), t1 = n ? e + tout.duration / 2 : e;
      if (t >= t0 && t < t1) return { type: tout.type, duration: tout.duration, a: b, b: n, progress: (t - t0) / (t1 - t0), t0, t1 };
    }
  }
  return null;
}

// ---- snapping ----
export function snapPoints(p, { exclude = [], playhead = null } = {}) {
  const pts = new Set([0]);
  for (const c of p.clips) if (!exclude.includes(c.id)) { pts.add(c.start); pts.add(clipEnd(c)); }
  for (const m of p.markers) pts.add(m.t);
  if (p.inPoint != null) pts.add(p.inPoint);
  if (p.outPoint != null) pts.add(p.outPoint);
  if (playhead != null) pts.add(playhead);
  return [...pts];
}
export function snapTime(t, points, tolerance) {
  let best = null, bd = tolerance;
  for (const q of points) { const d = Math.abs(q - t); if (d < bd) { bd = d; best = q; } }
  return best;
}

// ---- markers ----
export function addMarker(p, t, name = '', color = '#4caf50') {
  const m = { id: uid('mk'), t, name, color }; p.markers.push(m); p.markers.sort((a, b) => a.t - b.t); return m;
}

// ---- serialization ----
export function serialize(p) {
  return deepClone({ ...p, media: p.media.map(({ url, file, thumb, peaks, element, ...m }) => m) });
}
export function deserialize(json) {
  const p = createProject({ videoTracks: 0, audioTracks: 0 });
  Object.assign(p, deepClone(json));
  for (const c of p.clips) { c.transform ||= defaultTransform(); c.keyframes ||= {}; c.effects ||= []; }
  return p;
}

// ---- history ----
export class History {
  constructor(limit = 100) { this.undoStack = []; this.redoStack = []; this.limit = limit; }
  snapshot(p) { return deepClone({ tracks: p.tracks, clips: p.clips, markers: p.markers, inPoint: p.inPoint, outPoint: p.outPoint }); }
  push(p, label = '') {
    this.undoStack.push({ label, state: this.snapshot(p) });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  apply(p, s) { p.tracks = s.tracks; p.clips = s.clips; p.markers = s.markers; p.inPoint = s.inPoint; p.outPoint = s.outPoint; }
  undo(p) { const e = this.undoStack.pop(); if (!e) return null; this.redoStack.push({ label: e.label, state: this.snapshot(p) }); this.apply(p, e.state); return e.label; }
  redo(p) { const e = this.redoStack.pop(); if (!e) return null; this.undoStack.push({ label: e.label, state: this.snapshot(p) }); this.apply(p, e.state); return e.label; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
