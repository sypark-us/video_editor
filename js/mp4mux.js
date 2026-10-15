// Minimal ISO BMFF (MP4) muxer for WebCodecs output: H.264 (avc1) video plus AAC (mp4a) or Opus audio.
// Builds a progressive (moov-before-mdat) file in memory; no dependencies, works in Node for tests.

const te = new TextEncoder();

class Writer {
  constructor() { this.parts = []; this.size = 0; }
  bytes(u8) { this.parts.push(u8); this.size += u8.length; return this; }
  u8(v) { return this.bytes(Uint8Array.of(v & 255)); }
  u16(v) { return this.bytes(Uint8Array.of((v >> 8) & 255, v & 255)); }
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }
  u24(v) { return this.bytes(Uint8Array.of((v >> 16) & 255, (v >> 8) & 255, v & 255)); }
  u32(v) { return this.bytes(Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)); }
  u64(v) { const hi = Math.floor(v / 4294967296), lo = v >>> 0; return this.u32(hi).u32(lo); }
  fixed16(v) { return this.u32(Math.round(v * 65536)); }
  fixed8(v) { return this.u16(Math.round(v * 256)); }
  str(s) { return this.bytes(te.encode(s)); }
  zeros(n) { return this.bytes(new Uint8Array(n)); }
  out() { const r = new Uint8Array(this.size); let o = 0; for (const p of this.parts) { r.set(p, o); o += p.length; } return r; }
}

export function box(type, ...payloads) {
  const w = new Writer();
  const body = payloads.map((p) => (p instanceof Uint8Array ? p : p.out ? p.out() : new Uint8Array(0)));
  const size = 8 + body.reduce((s, b) => s + b.length, 0);
  w.u32(size).str(type);
  for (const b of body) w.bytes(b);
  return w.out();
}
export function fullBox(type, version, flags, ...payloads) {
  const h = new Writer(); h.u8(version).u24(flags);
  return box(type, h.out(), ...payloads);
}
const matrix = () => { const w = new Writer(); w.u32(0x10000).u32(0).u32(0).u32(0).u32(0x10000).u32(0).u32(0).u32(0).u32(0x40000000); return w.out(); };

// Bitstream helpers for AudioSpecificConfig when the encoder gives none.
function aacAudioSpecificConfig(sampleRate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let idx = rates.indexOf(sampleRate); if (idx < 0) idx = 3;
  const aot = 2; // AAC LC
  const bits = (aot << 11) | (idx << 7) | (channels << 3);
  return Uint8Array.of((bits >> 8) & 255, bits & 255);
}
function descriptor(tag, payload) {
  const w = new Writer();
  w.u8(tag);
  let len = payload.length;
  // 4-byte expandable length (always valid, commonly used by muxers).
  w.u8(0x80 | ((len >> 21) & 0x7f)).u8(0x80 | ((len >> 14) & 0x7f)).u8(0x80 | ((len >> 7) & 0x7f)).u8(len & 0x7f);
  w.bytes(payload);
  return w.out();
}

export class Mp4Muxer {
  /**
   * @param {object} o
   * @param {number} o.width @param {number} o.height @param {number} o.fps
   * @param {{codec:'aac'|'opus', sampleRate:number, channels:number}|null} o.audio
   */
  constructor(o) {
    this.width = o.width; this.height = o.height; this.fps = o.fps || 30;
    this.vTimescale = 90000;
    this.audio = o.audio || null;
    this.aTimescale = this.audio ? this.audio.sampleRate : 0;
    this.video = []; // {data, pts(µs), dur(µs), key}
    this.aud = [];
    this.avcC = null; this.audioDesc = null;
  }
  static chunkData(chunk) {
    if (chunk.data) return chunk.data instanceof Uint8Array ? chunk.data : new Uint8Array(chunk.data);
    const u = new Uint8Array(chunk.byteLength); chunk.copyTo(u); return u;
  }
  addVideoChunk(chunk, meta) {
    if (meta?.decoderConfig?.description && !this.avcC) this.avcC = new Uint8Array(meta.decoderConfig.description.buffer ? meta.decoderConfig.description : meta.decoderConfig.description);
    this.video.push({ data: Mp4Muxer.chunkData(chunk), pts: chunk.timestamp, dur: chunk.duration || Math.round(1e6 / this.fps), key: chunk.type === 'key' });
  }
  addAudioChunk(chunk, meta) {
    if (meta?.decoderConfig?.description && !this.audioDesc) { const d = meta.decoderConfig.description; this.audioDesc = d instanceof Uint8Array ? d : new Uint8Array(d.buffer || d); }
    this.aud.push({ data: Mp4Muxer.chunkData(chunk), pts: chunk.timestamp, dur: chunk.duration || 0 });
  }

  // ---- track builders ----
  videoSampleTable() {
    const ts = this.vTimescale, frame = Math.round(ts / this.fps);
    const n = this.video.length;
    // Decode order = order received. dts = i*frame; ctts offset = pts - dts (+shift so all >= 0).
    const pts = this.video.map((s) => Math.round(s.pts * ts / 1e6));
    const dts = this.video.map((_, i) => i * frame);
    let shift = 0; for (let i = 0; i < n; i++) shift = Math.max(shift, dts[i] - pts[i]);
    const ctts = pts.map((p, i) => p - dts[i] + shift);
    const needCtts = ctts.some((v) => v !== 0);
    const stts = new Writer(); stts.u32(1).u32(n).u32(frame);
    const sttsBox = fullBox('stts', 0, 0, stts);
    let cttsBox = null;
    if (needCtts) {
      const runs = [];
      for (const v of ctts) { const last = runs[runs.length - 1]; if (last && last.v === v) last.n++; else runs.push({ v, n: 1 }); }
      const w = new Writer(); w.u32(runs.length); for (const r of runs) w.u32(r.n).u32(r.v);
      cttsBox = fullBox('ctts', 0, 0, w);
    }
    const keys = this.video.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    const stss = new Writer(); stss.u32(keys.length); for (const k of keys) stss.u32(k);
    return { duration: n * frame, shift, boxes: [sttsBox, cttsBox, fullBox('stss', 0, 0, stss)].filter(Boolean) };
  }
  audioSampleTable() {
    const ts = this.aTimescale;
    const durs = this.aud.map((s, i) => {
      if (i < this.aud.length - 1) return Math.max(1, Math.round((this.aud[i + 1].pts - s.pts) * ts / 1e6));
      return Math.max(1, Math.round(s.dur * ts / 1e6)) || 1024;
    });
    const runs = [];
    for (const d of durs) { const last = runs[runs.length - 1]; if (last && last.v === d) last.n++; else runs.push({ v: d, n: 1 }); }
    const w = new Writer(); w.u32(runs.length); for (const r of runs) w.u32(r.n).u32(r.v);
    return { duration: durs.reduce((a, b) => a + b, 0), boxes: [fullBox('stts', 0, 0, w)] };
  }
  static sizesAndChunks(samples, offsets) {
    const stsz = new Writer(); stsz.u32(0).u32(samples.length); for (const s of samples) stsz.u32(s.data.length);
    const stsc = new Writer(); stsc.u32(1).u32(1).u32(1).u32(1);
    const stco = new Writer(); stco.u32(offsets.length); for (const o of offsets) stco.u32(o);
    return [fullBox('stsc', 0, 0, stsc), fullBox('stsz', 0, 0, stsz), fullBox('stco', 0, 0, stco)];
  }
  avc1Box() {
    const w = new Writer();
    w.zeros(6).u16(1); // reserved, data_reference_index
    w.u16(0).u16(0).u32(0).u32(0).u32(0); // pre_defined/reserved
    w.u16(this.width).u16(this.height).u32(0x00480000).u32(0x00480000).u32(0).u16(1);
    w.zeros(32); // compressorname
    w.u16(0x18).i16(-1);
    const avcC = this.avcC || Uint8Array.of(1, 66, 0, 30, 0xff, 0xe1, 0, 0, 1, 0);
    return box('avc1', w, box('avcC', avcC));
  }
  audioSampleEntry() {
    const a = this.audio;
    const w = new Writer();
    w.zeros(6).u16(1);
    w.u32(0).u32(0); // reserved
    w.u16(a.channels).u16(16).u16(0).u16(0).u32(a.sampleRate << 16);
    if (a.codec === 'opus') {
      // dOps from OpusHead (if given) or defaults.
      const d = this.audioDesc;
      const ops = new Writer();
      ops.u8(0);
      if (d && d.length >= 19) {
        const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
        ops.u8(d[9]).u16(dv.getUint16(10, true)).u32(dv.getUint32(12, true)).i16(dv.getInt16(16, true)).u8(d[18]);
        if (d[18] !== 0 && d.length >= 21) ops.bytes(d.subarray(19));
      } else ops.u8(a.channels).u16(312).u32(a.sampleRate).i16(0).u8(0);
      return box('Opus', w, box('dOps', ops));
    }
    const asc = this.audioDesc && this.audioDesc.length >= 2 ? this.audioDesc : aacAudioSpecificConfig(a.sampleRate, a.channels);
    const dcd = new Writer();
    dcd.u8(0x40).u8(0x15).u24(0).u32(128000).u32(128000);
    const dcdBytes = new Writer().bytes(dcd.out()).bytes(descriptor(0x05, asc)).out();
    const es = new Writer(); es.u16(0).u8(0);
    const esBytes = new Writer().bytes(es.out()).bytes(descriptor(0x04, dcdBytes)).bytes(descriptor(0x06, Uint8Array.of(0x02))).out();
    const esds = fullBox('esds', 0, 0, descriptor(0x03, esBytes));
    return box('mp4a', w, esds);
  }
  trak(id, kind, mediaDur, mediaTs, stbl, editShift = 0) {
    const movieTs = 1000;
    const tk = new Writer();
    tk.u32(0).u32(0).u32(id).u32(0).u32(Math.round(mediaDur * movieTs / mediaTs));
    tk.u32(0).u32(0).u16(0).u16(0).fixed8(kind === 'soun' ? 1 : 0).u16(0).bytes(matrix());
    tk.fixed16(kind === 'vide' ? this.width : 0).fixed16(kind === 'vide' ? this.height : 0);
    const tkhd = fullBox('tkhd', 0, 3, tk);
    const md = new Writer(); md.u32(0).u32(0).u32(mediaTs).u32(mediaDur).u16(0x55c4).u16(0);
    const mdhd = fullBox('mdhd', 0, 0, md);
    const hd = new Writer(); hd.u32(0).str(kind).zeros(12).str(kind === 'vide' ? 'VideoHandler\0' : 'SoundHandler\0');
    const hdlr = fullBox('hdlr', 0, 0, hd);
    const mhd = kind === 'vide' ? fullBox('vmhd', 0, 1, new Writer().u16(0).u16(0).u16(0).u16(0)) : fullBox('smhd', 0, 0, new Writer().u16(0).u16(0));
    const dinf = box('dinf', fullBox('dref', 0, 0, new Writer().u32(1).bytes(fullBox('url ', 0, 1))));
    const minf = box('minf', mhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const parts = [tkhd];
    if (editShift > 0) {
      const el = new Writer(); el.u32(1).u32(Math.round(mediaDur * movieTs / mediaTs)).u32(editShift).u16(1).u16(0);
      parts.push(box('edts', fullBox('elst', 0, 0, el)));
    }
    parts.push(mdia);
    return box('trak', ...parts);
  }

  finalize() {
    const hasAudio = this.audio && this.aud.length > 0;
    const ftyp = box('ftyp', new Writer().str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41'));
    const vt = this.videoSampleTable();
    const at = hasAudio ? this.audioSampleTable() : null;
    // Interleave samples by time so players can stream progressively.
    const order = [];
    let vi = 0, ai = 0;
    while (vi < this.video.length || (hasAudio && ai < this.aud.length)) {
      const vp = vi < this.video.length ? this.video[vi].pts : Infinity;
      const ap = hasAudio && ai < this.aud.length ? this.aud[ai].pts : Infinity;
      if (vp <= ap) order.push(['v', vi++]); else order.push(['a', ai++]);
    }
    const mdatSize = 8 + this.video.reduce((s, x) => s + x.data.length, 0) + (hasAudio ? this.aud.reduce((s, x) => s + x.data.length, 0) : 0);
    // Build moov twice: first to learn its size (chunk offsets depend on it), then with correct offsets.
    const build = (moovSize) => {
      const base = ftyp.length + moovSize + 8;
      const vOff = new Array(this.video.length), aOff = new Array(this.aud.length);
      let o = base;
      for (const [k, i] of order) { if (k === 'v') { vOff[i] = o; o += this.video[i].data.length; } else { aOff[i] = o; o += this.aud[i].data.length; } }
      const vstbl = box('stbl', fullBox('stsd', 0, 0, new Writer().u32(1).bytes(this.avc1Box())), ...vt.boxes, ...Mp4Muxer.sizesAndChunks(this.video, vOff));
      const traks = [this.trak(1, 'vide', vt.duration, this.vTimescale, vstbl, vt.shift)];
      if (hasAudio) {
        const astbl = box('stbl', fullBox('stsd', 0, 0, new Writer().u32(1).bytes(this.audioSampleEntry())), ...at.boxes, ...Mp4Muxer.sizesAndChunks(this.aud, aOff));
        traks.push(this.trak(2, 'soun', at.duration, this.aTimescale, astbl));
      }
      const movieDur = Math.max(Math.round(vt.duration * 1000 / this.vTimescale), hasAudio ? Math.round(at.duration * 1000 / this.aTimescale) : 0);
      const mv = new Writer(); mv.u32(0).u32(0).u32(1000).u32(movieDur).fixed16(1).fixed8(1).zeros(10).bytes(matrix()).zeros(24).u32(traks.length + 1);
      return box('moov', fullBox('mvhd', 0, 0, mv), ...traks);
    };
    let moov = build(0);
    moov = build(moov.length);
    const out = new Uint8Array(ftyp.length + moov.length + mdatSize);
    out.set(ftyp, 0); out.set(moov, ftyp.length);
    const dv = new DataView(out.buffer);
    let o = ftyp.length + moov.length;
    dv.setUint32(o, mdatSize); out.set(te.encode('mdat'), o + 4); o += 8;
    for (const [k, i] of order) { const d = k === 'v' ? this.video[i].data : this.aud[i].data; out.set(d, o); o += d.length; }
    return out;
  }
}

// Tiny box parser (used by tests and for sanity checks).
export function parseBoxes(u8, start = 0, end = u8.length) {
  const out = [];
  let o = start;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  while (o + 8 <= end) {
    let size = dv.getUint32(o); const type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; }
    if (size === 0) size = end - o;
    if (size < hdr) break;
    const b = { type, start: o, size, bodyStart: o + hdr, children: null };
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts'].includes(type)) b.children = parseBoxes(u8, o + hdr, o + size);
    else if (type === 'stsd') b.children = parseBoxes(u8, o + hdr + 8, o + size);
    else if (['avc1', 'mp4a', 'Opus'].includes(type)) b.children = parseBoxes(u8, o + hdr + (type === 'avc1' ? 78 : 28), o + size);
    out.push(b);
    o += size;
  }
  return out;
}
export function findBox(boxes, path) {
  let list = boxes, found = null;
  for (const t of path.split('/')) { found = (list || []).find((b) => b.type === t); if (!found) return null; list = found.children; }
  return found;
}
