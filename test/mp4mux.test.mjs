import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mp4Muxer, parseBoxes, findBox } from '../js/mp4mux.js';

const str = (u8, o) => String.fromCharCode(...u8.subarray(o, o + 4));
const u32 = (u8, o) => new DataView(u8.buffer, u8.byteOffset).getUint32(o);

function fakeVideo(n, fps = 30, withB = false) {
  const chunks = [];
  for (let i = 0; i < n; i++) {
    // decode order = i; with B-frames pretend pts are reordered within groups of 3 (I P B -> 0,2,1)
    let pts = i;
    if (withB && i % 3 === 1) pts = i + 1; else if (withB && i % 3 === 2) pts = i - 1;
    chunks.push({ type: i % 10 === 0 ? 'key' : 'delta', timestamp: Math.round((pts * 1e6) / fps), duration: Math.round(1e6 / fps), data: Uint8Array.from([0, 0, 0, 2, 0x65, i & 255]) });
  }
  return chunks;
}

test('muxes video-only MP4 with correct box layout and chunk offsets', () => {
  const m = new Mp4Muxer({ width: 320, height: 180, fps: 30 });
  const avcC = Uint8Array.from([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 2, 0x68, 0xee]);
  fakeVideo(30).forEach((c, i) => m.addVideoChunk(c, i === 0 ? { decoderConfig: { description: avcC } } : undefined));
  const out = m.finalize();
  const boxes = parseBoxes(out);
  assert.deepEqual(boxes.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
  assert.equal(str(out, 8), 'isom');
  const trak = findBox(boxes, 'moov/trak'); assert.ok(trak);
  const stbl = findBox(boxes, 'moov/trak/mdia/minf/stbl');
  const types = stbl.children.map((b) => b.type);
  assert.deepEqual(types, ['stsd', 'stts', 'stss', 'stsc', 'stsz', 'stco']);
  const avc1 = findBox(boxes, 'moov/trak/mdia/minf/stbl/stsd/avc1'); assert.ok(avc1);
  const avcCBox = avc1.children.find((b) => b.type === 'avcC'); assert.ok(avcCBox);
  assert.deepEqual(out.subarray(avcCBox.bodyStart, avcCBox.bodyStart + avcC.length), avcC);
  // stss: 3 key frames (0, 10, 20)
  const stss = stbl.children.find((b) => b.type === 'stss');
  assert.equal(u32(out, stss.bodyStart + 4), 3); assert.equal(u32(out, stss.bodyStart + 8), 1); assert.equal(u32(out, stss.bodyStart + 12), 11);
  // stco: first chunk offset points at first sample in mdat, sample data matches
  const stco = stbl.children.find((b) => b.type === 'stco');
  assert.equal(u32(out, stco.bodyStart + 4), 30);
  const off0 = u32(out, stco.bodyStart + 8);
  const mdat = boxes[2];
  assert.equal(off0, mdat.bodyStart);
  assert.deepEqual([...out.subarray(off0, off0 + 6)], [0, 0, 0, 2, 0x65, 0]);
  const off5 = u32(out, stco.bodyStart + 8 + 5 * 4);
  assert.equal(out[off5 + 5], 5);
  // stts: one run of 30 samples at 3000 ticks (90k/30)
  const stts = stbl.children.find((b) => b.type === 'stts');
  assert.equal(u32(out, stts.bodyStart + 4), 1); assert.equal(u32(out, stts.bodyStart + 8), 30); assert.equal(u32(out, stts.bodyStart + 12), 3000);
  // mvhd duration = 1000 ms
  const mvhd = findBox(boxes, 'moov/mvhd');
  assert.equal(u32(out, mvhd.bodyStart + 4 + 8), 1000); assert.equal(u32(out, mvhd.bodyStart + 4 + 12), 1000);
  assert.equal(out.length, u32(out, 0) + u32(out, boxes[1].start) + mdat.size);
});

test('B-frame reordering produces a ctts box and an edit list', () => {
  const m = new Mp4Muxer({ width: 64, height: 64, fps: 30 });
  fakeVideo(9, 30, true).forEach((c) => m.addVideoChunk(c));
  const out = m.finalize();
  const boxes = parseBoxes(out);
  const stbl = findBox(boxes, 'moov/trak/mdia/minf/stbl');
  const ctts = stbl.children.find((b) => b.type === 'ctts');
  assert.ok(ctts, 'ctts present');
  assert.ok(findBox(boxes, 'moov/trak/edts/elst'), 'edit list compensates the shift');
  // all composition offsets non-negative
  const n = u32(out, ctts.bodyStart + 4);
  for (let i = 0; i < n; i++) assert.ok(u32(out, ctts.bodyStart + 8 + i * 8 + 4) < 0x80000000);
});

test('muxes AAC audio track with esds and interleaves samples', () => {
  const m = new Mp4Muxer({ width: 64, height: 64, fps: 10, audio: { codec: 'aac', sampleRate: 48000, channels: 2 } });
  fakeVideo(10, 10).forEach((c) => m.addVideoChunk(c));
  const asc = Uint8Array.from([0x11, 0x90]);
  for (let i = 0; i < 47; i++) m.addAudioChunk({ type: 'key', timestamp: Math.round((i * 1024 * 1e6) / 48000), duration: Math.round((1024 * 1e6) / 48000), data: Uint8Array.from([0xaa, i]) }, i === 0 ? { decoderConfig: { description: asc } } : undefined);
  const out = m.finalize();
  const boxes = parseBoxes(out);
  const traks = findBox(boxes, 'moov').children.filter((b) => b.type === 'trak');
  assert.equal(traks.length, 2);
  const mp4a = findBox(boxes, 'moov').children[2].children.find((b) => b.type === 'mdia').children.find((b) => b.type === 'minf').children.find((b) => b.type === 'stbl').children[0].children[0];
  assert.equal(mp4a.type, 'mp4a');
  const esds = mp4a.children.find((b) => b.type === 'esds'); assert.ok(esds);
  const body = out.subarray(esds.bodyStart + 4, esds.start + esds.size);
  assert.equal(body[0], 0x03, 'ES_Descriptor tag');
  const idx = body.findIndex((v, i) => v === 0x05 && body[i + 5] === 0x11 && body[i + 6] === 0x90);
  assert.ok(idx > 0, 'AudioSpecificConfig embedded');
  // samples interleaved by time: first video (t=0), then audio (t=0) etc.
  const mdat = boxes[2];
  assert.deepEqual([...out.subarray(mdat.bodyStart, mdat.bodyStart + 6)], [0, 0, 0, 2, 0x65, 0]);
  assert.deepEqual([...out.subarray(mdat.bodyStart + 6, mdat.bodyStart + 8)], [0xaa, 0]);
  const hdlr = traks[1].children.find((b) => b.type === 'mdia').children.find((b) => b.type === 'hdlr');
  assert.equal(str(out, hdlr.bodyStart + 8), 'soun');
});

test('Opus audio uses an Opus sample entry with dOps from OpusHead', () => {
  const m = new Mp4Muxer({ width: 64, height: 64, fps: 10, audio: { codec: 'opus', sampleRate: 48000, channels: 2 } });
  fakeVideo(2, 10).forEach((c) => m.addVideoChunk(c));
  const head = new Uint8Array(19); head.set([..."OpusHead"].map((c) => c.charCodeAt(0))); head[8] = 1; head[9] = 2;
  new DataView(head.buffer).setUint16(10, 312, true); new DataView(head.buffer).setUint32(12, 48000, true);
  m.addAudioChunk({ type: 'key', timestamp: 0, duration: 20000, data: Uint8Array.from([1, 2, 3]) }, { decoderConfig: { description: head } });
  const out = m.finalize();
  const boxes = parseBoxes(out);
  const atrak = findBox(boxes, 'moov').children.filter((b) => b.type === 'trak')[1];
  const stsd = atrak.children.find((b) => b.type === 'mdia').children.find((b) => b.type === 'minf').children.find((b) => b.type === 'stbl').children[0];
  assert.equal(stsd.children[0].type, 'Opus');
  const dops = stsd.children[0].children.find((b) => b.type === 'dOps'); assert.ok(dops);
  assert.equal(out[dops.bodyStart + 1], 2, 'channel count');
  assert.equal(new DataView(out.buffer).getUint16(dops.bodyStart + 2), 312, 'pre-skip big-endian');
});
