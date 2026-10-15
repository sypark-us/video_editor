import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';
import { timecode, parseTimecode } from '../js/util.js';
import { clipGain } from '../js/audio.js';

const setup = () => {
  const p = M.createProject({ fps: 30 });
  const v1 = M.videoTracks(p)[0].id, a1 = M.audioTracks(p)[0].id;
  const med = M.addMedia(p, { name: 'a.mp4', type: 'video', duration: 20, width: 1920, height: 1080, hasAudio: true });
  return { p, v1, a1, med };
};

test('timecode round trip', () => {
  assert.equal(timecode(0, 30), '00:00:00:00');
  assert.equal(timecode(61.5, 30), '00:01:01:15');
  assert.equal(timecode(3600, 30), '01:00:00:00');
  assert.equal(parseTimecode('00:01:01:15', 30), 61.5);
  assert.equal(parseTimecode('1:30', 30), 90);
  assert.equal(parseTimecode('2.5s', 30), 2.5);
});

test('placeClip overwrite trims and splits existing clips', () => {
  const { p, v1, med } = setup();
  const a = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 10 }), v1, 0);
  const b = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 2 }), v1, 4);
  const clips = M.clipsOnTrack(p, v1);
  assert.equal(clips.length, 3);
  assert.deepEqual(clips.map((c) => [c.start, c.duration]), [[0, 4], [4, 2], [6, 4]]);
  assert.equal(clips[2].inPoint, 6, 'right remainder keeps media offset');
  assert.equal(clips[1].id, b.id);
  // full cover removes
  M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 12 }), v1, 0);
  assert.equal(M.clipsOnTrack(p, v1).length, 1);
  assert.ok(a);
});

test('placeClip insert ripples clips to the right', () => {
  const { p, v1, med } = setup();
  M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 10, name: 'A' }), v1, 0);
  M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 2, name: 'B' }), v1, 4, { insert: true });
  const clips = M.clipsOnTrack(p, v1);
  assert.deepEqual(clips.map((c) => [c.name, c.start, c.duration]), [['A', 0, 4], ['B', 4, 2], ['A', 6, 6]]);
  assert.equal(M.sequenceDuration(p), 12);
});

test('split, ripple delete and close gap', () => {
  const { p, v1, med } = setup();
  const a = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 10 }), v1, 0);
  const r = M.splitAll(p, 4);
  assert.equal(r.length, 1);
  assert.equal(a.duration, 4); assert.equal(r[0].start, 4); assert.equal(r[0].duration, 6); assert.equal(r[0].inPoint, 4);
  M.rippleDeleteClips(p, [a.id]);
  assert.equal(p.clips.length, 1); assert.equal(p.clips[0].start, 0);
  // gap closing
  p.clips[0].start = 3;
  assert.equal(M.closeGap(p, v1, 1), true);
  assert.equal(p.clips[0].start, 0);
  assert.equal(M.closeGap(p, v1, 1), false, 'no gap when inside a clip');
});

test('trim respects neighbours and media bounds; ripple trim shifts', () => {
  const { p, v1, med } = setup();
  const a = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 5 }), v1, 0);
  const b = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 5, inPoint: 5 }), v1, 5);
  M.trimClip(p, a, 'end', 8);
  assert.equal(a.duration, 5, 'cannot extend into neighbour');
  M.trimClip(p, b, 'start', 3);
  assert.equal(b.start, 5, 'cannot extend into neighbour');
  M.trimClip(p, b, 'end', 100);
  assert.equal(M.clipEnd(b), 20, 'limited by media length');
  M.trimClip(p, a, 'end', 3, { ripple: true });
  assert.equal(a.duration, 3); assert.equal(b.start, 3, 'ripple shifts following clip');
  M.trimClip(p, a, 'start', 1, { ripple: true });
  assert.equal(a.start, 0); assert.equal(a.inPoint, 1); assert.equal(a.duration, 2); assert.equal(b.start, 2);
});

test('moveClips with track change and overwrite', () => {
  const { p, v1, med } = setup();
  const v2 = M.videoTracks(p)[1].id;
  const a = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 5 }), v1, 0);
  const b = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 5 }), v2, 10);
  M.moveClips(p, [a.id], 12, new Map([[a.id, v2]]));
  assert.equal(a.trackId, v2); assert.equal(a.start, 12);
  assert.equal(b.duration, 2, 'overwritten clip trimmed');
  M.moveClips(p, [a.id], -100);
  assert.equal(a.start, 0, 'clamped at zero');
});

test('linked selection and link/unlink', () => {
  const { p, v1, a1, med } = setup();
  const v = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 5, linkId: 'L' }), v1, 0);
  const a = M.placeClip(p, M.makeClip({ kind: 'audio', mediaId: med.id, duration: 5, linkId: 'L' }), a1, 0);
  assert.deepEqual(M.expandSelection(p, [v.id]).sort(), [v.id, a.id].sort());
  const r = M.splitAll(p, 2);
  assert.equal(r.length, 2); assert.equal(r[0].linkId, r[1].linkId); assert.notEqual(r[0].linkId, 'L');
  M.unlink(p, [v.id]);
  assert.deepEqual(M.expandSelection(p, [v.id]), [v.id]);
});

test('keyframe interpolation (linear, ease, hold) and shifting on trim', () => {
  const { p, v1, med } = setup();
  const c = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 10 }), v1, 0);
  M.setKeyframe(c, 'opacity', 0, 0); M.setKeyframe(c, 'opacity', 2, 100);
  assert.equal(M.getProp(c, 'opacity', 1), 50);
  assert.equal(M.getProp(c, 'opacity', -1), 0); assert.equal(M.getProp(c, 'opacity', 5), 100);
  c.keyframes.opacity[0].ease = 'hold'; assert.equal(M.getProp(c, 'opacity', 1), 0);
  c.keyframes.opacity[0].ease = 'ease'; assert.equal(M.getProp(c, 'opacity', 1), 50); assert.ok(M.getProp(c, 'opacity', 0.5) < 25);
  M.setKeyframe(c, 'opacity', 2, 80); assert.equal(c.keyframes.opacity.length, 2, 'same-time keyframe updates');
  M.trimClip(p, c, 'start', 1);
  assert.equal(c.keyframes.opacity[1].t, 1, 'keyframes shift with left trim');
  M.removeKeyframe(c, 'opacity', 1); M.removeKeyframe(c, 'opacity', -1);
  assert.equal(M.isAnimated(c, 'opacity'), false);
  assert.equal(M.getProp(c, 'opacity', 0), 100);
});

test('transitions centre on the cut and fade when alone', () => {
  const { p, v1, med } = setup();
  const a = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 5 }), v1, 0);
  const b = M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 5, transitionIn: { type: 'Cross Dissolve', duration: 1 } }), v1, 5);
  const tr = M.transitionAt(p, v1, 5);
  assert.ok(tr); assert.equal(tr.a.id, a.id); assert.equal(tr.b.id, b.id); assert.equal(tr.progress, 0.5);
  assert.equal(M.transitionAt(p, v1, 4.4), null); assert.equal(M.transitionAt(p, v1, 5.6), null);
  b.start = 7; // gap: fade from black over full duration
  const t2 = M.transitionAt(p, v1, 7.25);
  assert.ok(t2); assert.equal(t2.a, null); assert.equal(t2.progress, 0.25);
  a.transitionOut = { type: 'Dip to Black', duration: 2 };
  const t3 = M.transitionAt(p, v1, 4.5);
  assert.ok(t3); assert.equal(t3.b, null); assert.equal(t3.type, 'Dip to Black');
});

test('snapping picks the nearest point within tolerance', () => {
  const { p, v1, med } = setup();
  M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 5 }), v1, 2);
  const pts = M.snapPoints(p, { playhead: 9 });
  assert.equal(M.snapTime(6.9, pts, 0.2), 7);
  assert.equal(M.snapTime(8.5, pts, 0.2), null);
  assert.equal(M.snapTime(9.1, pts, 0.2), 9);
});

test('audio gain: fades, keyframes, mute and solo', () => {
  const { p, a1, med } = setup();
  const c = M.placeClip(p, M.makeClip({ kind: 'audio', mediaId: med.id, duration: 10, fadeIn: 2, fadeOut: 2 }), a1, 0);
  assert.equal(clipGain(p, c, 1), 0.5); assert.equal(clipGain(p, c, 5), 1); assert.equal(clipGain(p, c, 9), 0.5);
  M.setKeyframe(c, 'volume', 4, 0); M.setKeyframe(c, 'volume', 6, 2);
  assert.equal(clipGain(p, c, 5), 1);
  const tr = M.trackById(p, a1); tr.muted = true; assert.equal(clipGain(p, c, 5), 0); tr.muted = false;
  M.audioTracks(p)[1].solo = true; assert.equal(clipGain(p, c, 5), 0);
});

test('serialize/deserialize and history', () => {
  const { p, v1, med } = setup();
  med.url = 'blob:x'; med.file = {};
  M.placeClip(p, M.makeClip({ mediaId: med.id, duration: 5 }), v1, 0);
  const json = JSON.parse(JSON.stringify(M.serialize(p)));
  assert.equal(json.media[0].url, undefined);
  const q = M.deserialize(json);
  assert.equal(q.clips.length, 1); assert.equal(q.tracks.length, 6); assert.equal(q.fps, 30);
  const h = new M.History();
  h.push(p, 'delete'); M.deleteClips(p, [p.clips[0].id]); assert.equal(p.clips.length, 0);
  assert.equal(h.undo(p), 'delete'); assert.equal(p.clips.length, 1);
  assert.equal(h.redo(p), 'delete'); assert.equal(p.clips.length, 0);
});

test('track management renames tracks', () => {
  const p = M.createProject({ videoTracks: 2, audioTracks: 1 });
  M.addTrack(p, 'audio');
  assert.deepEqual(p.tracks.map((t) => t.name), ['V1', 'V2', 'A1', 'A2']);
  M.removeTrack(p, p.tracks[0].id);
  assert.deepEqual(p.tracks.map((t) => t.name), ['V1', 'A1', 'A2']);
});
