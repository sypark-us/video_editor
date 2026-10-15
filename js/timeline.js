// Timeline panel: track headers, ruler, clips, and all pointer interactions (select, move, trim, razor, marquee, drag-drop).
import { el, timecode, clamp, EPS } from './util.js';
import { videoTracks, audioTracks, clipEnd, clipsOnTrack, mediaById, snapPoints, snapTime, sequenceDuration, trackById, clipById, splitAll, trimClip, moveClips, expandSelection, localTime, maxDuration, TRANSITIONS, isAnimated } from './model.js';

export class Timeline {
  constructor(app) {
    this.app = app;
    this.scroll = document.getElementById('tlScroll');
    this.content = document.getElementById('tlContent');
    this.ruler = document.getElementById('ruler');
    this.tracksEl = document.getElementById('tracks');
    this.headers = document.getElementById('trackHeaders');
    this.playheadEl = document.getElementById('playhead');
    this.marquee = document.getElementById('marquee');
    this.pxPerSec = 40;
    this.rowH = 56; this.audioRowH = 44; this.rulerH = 28;
    this.drag = null;
    this.bind();
  }
  get p() { return this.app.project; }
  timeToX(t) { return t * this.pxPerSec; }
  xToTime(x) { return x / this.pxPerSec; }
  // Track rows top-to-bottom: video tracks (highest first), then audio tracks.
  trackOrder() { return [...videoTracks(this.p).reverse(), ...audioTracks(this.p)]; }
  trackTop(trackId) { let y = 0; for (const t of this.trackOrder()) { if (t.id === trackId) return y; y += t.kind === 'video' ? this.rowH : this.audioRowH; } return y; }
  trackAtY(y) { let acc = 0; for (const t of this.trackOrder()) { const h = t.kind === 'video' ? this.rowH : this.audioRowH; if (y >= acc && y < acc + h) return t; acc += h; } return null; }
  contentWidth() { const vis = this.scroll.clientWidth; return Math.max(vis, this.timeToX(sequenceDuration(this.p) + 30)) + 200; }
  clientToContent(e) { const r = this.content.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top - this.rulerH }; }

  setZoom(pps, anchorClientX = null) {
    const r = this.scroll.getBoundingClientRect();
    const ax = anchorClientX == null ? r.width / 2 : anchorClientX - r.left;
    const tAtAnchor = this.xToTime(this.scroll.scrollLeft + ax);
    this.pxPerSec = clamp(pps, 1, 2000);
    this.render();
    this.scroll.scrollLeft = Math.max(0, this.timeToX(tAtAnchor) - ax);
    const z = document.getElementById('zoom'); if (z) z.value = Math.round(Math.log(this.pxPerSec / 2) / Math.log(500) * 100);
  }
  zoomToFit() { const d = Math.max(1, sequenceDuration(this.p)); this.setZoom((this.scroll.clientWidth - 40) / d); this.scroll.scrollLeft = 0; }

  render() {
    const p = this.p;
    const W = this.contentWidth();
    this.content.style.width = W + 'px';
    // headers
    this.headers.innerHTML = '';
    for (const t of this.trackOrder()) this.headers.append(this.buildHeader(t));
    // tracks
    this.tracksEl.innerHTML = '';
    for (const t of this.trackOrder()) {
      const row = el(`.track.${t.kind}${t.locked ? '.locked' : ''}`, { dataset: { track: t.id } });
      for (const c of clipsOnTrack(p, t.id)) row.append(this.buildClip(c, t));
      this.tracksEl.append(row);
    }
    this.renderRuler();
    this.updatePlayhead();
    this.updateSelection();
  }
  buildHeader(t) {
    const app = this.app;
    const h = el(`.trackHead.${t.kind}`, { dataset: { track: t.id } }, el('span.tname', t.name));
    const btn = (cls, label, title, on, onClick) => el(`button.${cls}${on ? '.on' : ''}`, { title, onclick: (e) => { e.stopPropagation(); onClick(); } }, label);
    if (t.kind === 'video') h.append(btn('eye', t.hidden ? '○' : '●', 'Toggle track output', !t.hidden, () => app.edit('Toggle track', () => { t.hidden = !t.hidden; })));
    else {
      h.append(btn('mute', 'M', 'Mute', t.muted, () => app.edit('Mute track', () => { t.muted = !t.muted; })));
      h.append(btn('solo', 'S', 'Solo', t.solo, () => app.edit('Solo track', () => { t.solo = !t.solo; })));
      const vol = el('input.vol', { type: 'range', min: 0, max: 150, value: Math.round((t.volume ?? 1) * 100), title: 'Track volume' });
      vol.addEventListener('input', () => { t.volume = vol.value / 100; });
      vol.addEventListener('change', () => app.edit('Track volume', () => { t.volume = vol.value / 100; }));
      vol.addEventListener('pointerdown', (e) => e.stopPropagation());
      h.append(vol);
    }
    h.append(btn('lock', t.locked ? '🔒' : '🔓', 'Lock track', t.locked, () => app.edit('Lock track', () => { t.locked = !t.locked; })));
    h.addEventListener('contextmenu', (e) => { e.preventDefault(); app.trackContextMenu(t, e.clientX, e.clientY); });
    return h;
  }
  buildClip(c, track) {
    const p = this.p; const pps = this.pxPerSec;
    const x = this.timeToX(c.start), w = Math.max(2, this.timeToX(c.duration));
    const d = el(`.clip.${c.kind}${c.enabled === false ? '.disabled' : ''}`, { dataset: { id: c.id }, style: { left: x + 'px', width: w + 'px' }, title: c.name });
    const media = c.mediaId ? mediaById(p, c.mediaId) : null;
    if (c.kind === 'video' && media && media.thumb && w > 70) d.append(el('.thumb', { style: { backgroundImage: `url(${media.thumb})` } }));
    if (c.kind === 'audio' && media) {
      const cv = el('canvas.wave'); d.append(cv);
      requestAnimationFrame(() => this.drawWave(cv, c, media, w));
    }
    if (c.kind === 'color') d.style.background = `linear-gradient(${c.color}, ${c.color}) 0 0/14px 100% no-repeat, var(--color)`;
    d.append(el('.label', (c.kind === 'title' ? 'T: ' : '') + c.name));
    if (c.fadeIn > 0) d.append(el('.fade.in', { style: { left: 0, width: this.timeToX(c.fadeIn) + 'px' } }));
    if (c.fadeOut > 0) d.append(el('.fade.out', { style: { right: 0, width: this.timeToX(c.fadeOut) + 'px' } }));
    if (c.transitionIn && c.transitionIn.duration > 0) d.append(el('.trans', { style: { left: 0, width: this.timeToX(c.transitionIn.duration / 2) + 'px' }, title: c.transitionIn.type }));
    if (c.transitionOut && c.transitionOut.duration > 0) d.append(el('.trans', { style: { right: 0, width: this.timeToX(c.transitionOut.duration / 2) + 'px' }, title: c.transitionOut.type }));
    if (c.speed !== 1) d.append(el('.speed', `${Math.round(c.speed * 100)}%`));
    for (const prop of Object.keys(c.keyframes || {})) if (isAnimated(c, prop)) for (const k of c.keyframes[prop]) d.append(el('.kfmark', { style: { left: (this.timeToX(k.t) - 3) + 'px' }, title: `${prop} keyframe` }));
    if (!track.locked) d.append(el('.edge.l', { dataset: { edge: 'start' } }), el('.edge.r', { dataset: { edge: 'end' } }));
    return d;
  }
  async drawWave(cv, c, media, w) {
    const peaks = await this.app.peaksFor(media);
    if (!peaks || !cv.isConnected) return;
    const h = this.audioRowH - 8; cv.width = Math.min(4000, Math.ceil(w)); cv.height = h;
    const g = cv.getContext('2d'); g.fillStyle = 'rgba(255,255,255,.55)';
    const perSec = peaks.length / Math.max(0.001, media.duration);
    const scale = cv.width / w;
    for (let px = 0; px < cv.width; px++) {
      const t = c.inPoint + (px / scale / this.pxPerSec) * c.speed;
      const i = Math.floor(t * perSec); if (i < 0 || i >= peaks.length) continue;
      const a = Math.max(1, peaks[i] * h);
      g.fillRect(px, (h - a) / 2, 1, a);
    }
  }
  renderRuler() {
    const cv = this.ruler; const W = this.contentWidth();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.ceil(W * dpr); cv.height = this.rulerH * dpr; cv.style.width = W + 'px'; cv.style.height = this.rulerH + 'px';
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    g.fillStyle = '#181818'; g.fillRect(0, 0, W, this.rulerH);
    const p = this.p, fps = p.fps, pps = this.pxPerSec;
    // choose a major tick step (seconds) with at least ~80px spacing
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const major = steps.find((s) => s * pps >= 80) || 3600;
    const minor = major / (major >= 1 ? (major === 1 ? 4 : 5) : 2);
    g.strokeStyle = '#444'; g.fillStyle = '#aaa'; g.font = '10px ui-monospace, Consolas, monospace'; g.textBaseline = 'top';
    const tEnd = this.xToTime(W);
    g.beginPath();
    for (let t = 0; t <= tEnd; t += minor) { const x = Math.round(this.timeToX(t)) + 0.5; g.moveTo(x, this.rulerH - 5); g.lineTo(x, this.rulerH); }
    g.stroke();
    g.strokeStyle = '#666'; g.beginPath();
    for (let t = 0; t <= tEnd; t += major) { const x = Math.round(this.timeToX(t)) + 0.5; g.moveTo(x, this.rulerH - 12); g.lineTo(x, this.rulerH); g.fillText(timecode(t, fps), x + 3, 3); }
    g.stroke();
    // in/out
    if (p.inPoint != null || p.outPoint != null) {
      const a = p.inPoint ?? 0, b = p.outPoint ?? sequenceDuration(p);
      g.fillStyle = 'rgba(154,92,246,.35)'; g.fillRect(this.timeToX(a), 0, this.timeToX(b) - this.timeToX(a), this.rulerH);
    }
    // markers
    for (const m of p.markers) { const x = this.timeToX(m.t); g.fillStyle = m.color; g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x + 5, 6); g.lineTo(x, 11); g.lineTo(x - 5, 6); g.closePath(); g.fill(); if (m.name) { g.fillStyle = '#ddd'; g.fillText(m.name, x + 7, 12); } }
  }
  updatePlayhead() {
    this.playheadEl.style.left = this.timeToX(this.app.playhead) + 'px';
    this.playheadEl.style.height = (this.rulerH + this.tracksEl.offsetHeight) + 'px';
  }
  updateSelection() {
    for (const d of this.tracksEl.querySelectorAll('.clip')) d.classList.toggle('selected', this.app.selection.has(d.dataset.id));
  }
  scrollToPlayhead() {
    const x = this.timeToX(this.app.playhead), s = this.scroll;
    if (x < s.scrollLeft || x > s.scrollLeft + s.clientWidth - 20) s.scrollLeft = Math.max(0, x - (this.app.player.playing ? 60 : s.clientWidth / 2));
  }

  // ---- interactions ----
  bind() {
    const app = this.app;
    this.scroll.addEventListener('scroll', () => { this.headers.style.transform = `translateY(${-this.scroll.scrollTop}px)`; });
    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.altKey) { e.preventDefault(); this.setZoom(this.pxPerSec * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX); }
      else if (e.shiftKey || Math.abs(e.deltaX) > 0) { /* native horizontal */ }
    }, { passive: false });
    this.content.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.content.addEventListener('dblclick', (e) => {
      const clipEl = e.target.closest('.clip'); if (!clipEl) return;
      const c = clipById(this.p, clipEl.dataset.id); if (c) app.openClipInSource(c);
    });
    this.content.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const clipEl = e.target.closest('.clip');
      if (clipEl) { if (!app.selection.has(clipEl.dataset.id)) app.select([clipEl.dataset.id]); app.clipContextMenu(e.clientX, e.clientY); }
      else { const { x, y } = this.clientToContent(e); const tr = this.trackAtY(y); app.timelineContextMenu(this.xToTime(x), tr, e.clientX, e.clientY); }
    });
    // Drag & drop from bins / effects / files
    this.content.addEventListener('dragover', (e) => {
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      const { y } = this.clientToContent(e); const tr = this.trackAtY(y);
      for (const row of this.tracksEl.children) row.classList.toggle('dropTarget', !!tr && row.dataset.track === tr.id);
    });
    this.content.addEventListener('dragleave', () => { for (const row of this.tracksEl.children) row.classList.remove('dropTarget'); });
    this.content.addEventListener('drop', (e) => {
      e.preventDefault();
      for (const row of this.tracksEl.children) row.classList.remove('dropTarget');
      const { x, y } = this.clientToContent(e); const t = this.snapped(Math.max(0, this.xToTime(x))); const tr = this.trackAtY(y);
      const mediaId = e.dataTransfer.getData('application/x-media');
      const fx = e.dataTransfer.getData('application/x-effect');
      const trans = e.dataTransfer.getData('application/x-transition');
      const clipEl = e.target.closest('.clip');
      if (mediaId) app.addMediaToTimeline(mediaId, tr, t);
      else if (fx && clipEl) app.applyEffect(fx, [clipEl.dataset.id]);
      else if (trans && clipEl) { const c = clipById(this.p, clipEl.dataset.id); const r = clipEl.getBoundingClientRect(); app.applyTransition(trans, [c.id], e.clientX - r.left < r.width / 2 ? 'in' : 'out'); }
      else if (e.dataTransfer.files && e.dataTransfer.files.length) app.importFiles([...e.dataTransfer.files], { track: tr, time: t });
    });
  }
  snapped(t, exclude = [], extra = []) {
    if (!this.app.snap) return t;
    const pts = snapPoints(this.p, { exclude, playhead: this.app.playhead }).concat(extra);
    const s = snapTime(t, pts, 8 / this.pxPerSec);
    return s == null ? t : s;
  }
  showSnapline(t) {
    let s = this.content.querySelector('.snapline');
    if (t == null) { if (s) s.remove(); return; }
    if (!s) { s = el('.snapline'); this.content.append(s); }
    s.style.left = this.timeToX(t) + 'px'; s.style.height = this.content.offsetHeight + 'px';
  }

  onPointerDown(e) {
    if (e.button === 1) return;
    const app = this.app;
    if (e.button === 2) return;
    const { x, y } = this.clientToContent(e);
    const onRuler = y < 0;
    const clipEl = e.target.closest('.clip');
    const edgeEl = e.target.closest('.edge');
    const tool = app.tool;
    this.content.setPointerCapture(e.pointerId);
    if (app.player.playing) app.pause();

    if (tool === 'hand') { this.startDrag(e, { kind: 'hand', sx: e.clientX, sy: e.clientY, sl: this.scroll.scrollLeft, st: this.scroll.scrollTop }); return; }
    if (onRuler || (!clipEl && tool !== 'razor' && e.target === this.ruler)) { app.setPlayhead(this.snapped(Math.max(0, this.xToTime(x)), [], []), { scrub: true }); this.startDrag(e, { kind: 'scrub' }); return; }
    if (tool === 'razor') {
      if (clipEl) { const c = clipById(this.p, clipEl.dataset.id); const t = this.snapped(this.xToTime(x)); const ids = app.linked ? expandSelection(this.p, [c.id]) : [c.id]; app.edit('Split', () => splitAll(this.p, t, ids)); }
      return;
    }
    if (edgeEl && clipEl) {
      const c = clipById(this.p, clipEl.dataset.id);
      if (!app.selection.has(c.id)) app.select([c.id]);
      const ids = app.linked ? expandSelection(this.p, [...app.selection]) : [...app.selection];
      const clips = ids.map((id) => clipById(this.p, id)).filter(Boolean);
      app.history.push(this.p, 'Trim');
      this.startDrag(e, { kind: 'trim', edge: edgeEl.dataset.edge, clips, orig: clips.map((k) => ({ start: k.start, duration: k.duration, inPoint: k.inPoint })), ripple: e.ctrlKey, moved: false, x0: x });
      return;
    }
    if (clipEl) {
      const id = clipEl.dataset.id;
      if (e.shiftKey || e.ctrlKey) app.select([id], { toggle: true });
      else if (!app.selection.has(id)) app.select([id]);
      const ids = app.linked ? expandSelection(this.p, [...app.selection]) : [...app.selection];
      const clips = ids.map((i) => clipById(this.p, i)).filter((c) => c && !trackById(this.p, c.trackId)?.locked);
      this.startDrag(e, { kind: 'move', clips, x0: x, y0: y, orig: clips.map((c) => ({ start: c.start, trackId: c.trackId })), moved: false, insert: e.ctrlKey, grab: this.xToTime(x) - clipById(this.p, id).start, anchor: clipById(this.p, id) });
      return;
    }
    // empty area: playhead + marquee
    if (!e.shiftKey) app.select([]);
    app.setPlayhead(Math.max(0, this.xToTime(x)), { scrub: true });
    this.startDrag(e, { kind: 'marquee', x0: x, y0: y, moved: false, add: e.shiftKey });
  }
  startDrag(e, d) {
    this.drag = d;
    const move = (ev) => this.onPointerMove(ev);
    const up = (ev) => { this.content.removeEventListener('pointermove', move); this.content.removeEventListener('pointerup', up); this.content.removeEventListener('pointercancel', up); this.onPointerUp(ev); };
    this.content.addEventListener('pointermove', move); this.content.addEventListener('pointerup', up); this.content.addEventListener('pointercancel', up);
  }
  onPointerMove(e) {
    const d = this.drag; if (!d) return;
    const app = this.app; const p = this.p;
    const { x, y } = this.clientToContent(e);
    if (d.kind === 'hand') { this.scroll.scrollLeft = d.sl - (e.clientX - d.sx); this.scroll.scrollTop = d.st - (e.clientY - d.sy); return; }
    if (d.kind === 'scrub') { app.setPlayhead(Math.max(0, this.xToTime(x)), { scrub: true }); return; }
    if (d.kind === 'marquee') {
      if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return;
      d.moved = true;
      const x0 = Math.min(x, d.x0), x1 = Math.max(x, d.x0), y0 = Math.min(y, d.y0), y1 = Math.max(y, d.y0);
      Object.assign(this.marquee.style, { left: x0 + 'px', top: (y0 + this.rulerH) + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px' });
      this.marquee.classList.remove('hidden');
      const t0 = this.xToTime(x0), t1 = this.xToTime(x1);
      const ids = [];
      for (const c of p.clips) { const top = this.trackTop(c.trackId); const h = trackById(p, c.trackId).kind === 'video' ? this.rowH : this.audioRowH; if (c.start < t1 && clipEnd(c) > t0 && top < y1 && top + h > y0) ids.push(c.id); }
      app.select(ids, { add: d.add, silent: true });
      return;
    }
    if (d.kind === 'trim') {
      if (!d.moved && Math.abs(x - d.x0) < 3) return;
      d.moved = true;
      let t = this.xToTime(x);
      const ex = d.clips.map((c) => c.id);
      const st = this.snapped(t, ex); this.showSnapline(st !== t ? st : null); t = st;
      // restore originals then apply
      d.clips.forEach((c, i) => Object.assign(c, d.orig[i]));
      const dt = d.edge === 'start' ? t - d.orig[0].start : t - (d.orig[0].start + d.orig[0].duration);
      d.clips.forEach((c, i) => { const o = d.orig[i]; trimClip(p, c, d.edge, d.edge === 'start' ? o.start + dt : o.start + o.duration + dt, { ripple: d.ripple }); });
      const c = d.clips[0];
      app.status(`${d.ripple ? 'Ripple trim' : 'Trim'}: ${timecode(c.duration, p.fps)}`);
      this.render(); app.drawFrame();
      return;
    }
    if (d.kind === 'move') {
      if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return;
      if (!d.moved) { d.moved = true; app.history.push(p, 'Move'); }
      let dt = this.xToTime(x - d.x0);
      // snap anchor clip's start/end
      const a = d.orig[d.clips.indexOf(d.anchor)];
      const ex = d.clips.map((c) => c.id);
      const sStart = this.snapped(a.start + dt, ex), sEnd = this.snapped(a.start + d.anchor.duration + dt, ex);
      let snapT = null;
      if (sStart !== a.start + dt) { dt = sStart - a.start; snapT = sStart; } else if (sEnd !== a.start + d.anchor.duration + dt) { dt = sEnd - (a.start + d.anchor.duration); snapT = sEnd; }
      this.showSnapline(snapT);
      // vertical: shift tracks of same kind by row delta
      const fromTrack = this.trackAtY(d.y0), toTrack = this.trackAtY(y);
      const order = this.trackOrder();
      let rowDelta = fromTrack && toTrack ? order.indexOf(toTrack) - order.indexOf(fromTrack) : 0;
      const minStart = Math.min(...d.orig.map((o) => o.start));
      if (minStart + dt < 0) dt = -minStart;
      // preview: move DOM elements only
      d.clips.forEach((c, i) => {
        const o = d.orig[i];
        const elc = this.tracksEl.querySelector(`.clip[data-id="${c.id}"]`); if (!elc) return;
        let target = trackById(p, o.trackId);
        if (rowDelta) { const idx = order.indexOf(target); const cand = order[clamp(idx + rowDelta, 0, order.length - 1)]; if (cand && cand.kind === target.kind && !cand.locked) target = cand; }
        elc.style.left = this.timeToX(o.start + dt) + 'px';
        elc.style.transform = `translateY(${this.trackTop(target.id) - this.trackTop(o.trackId)}px)`;
        elc.classList.add('ghost');
        d.targets = d.targets || new Map(); d.targets.set(c.id, target.id);
      });
      d.dt = dt;
      app.status(`Move ${dt >= 0 ? '+' : ''}${timecode(dt, p.fps)}${d.insert ? ' (insert)' : ''}`);
      return;
    }
  }
  onPointerUp(e) {
    const d = this.drag; this.drag = null; if (!d) return;
    const app = this.app; const p = this.p;
    this.showSnapline(null);
    try { this.content.releasePointerCapture(e.pointerId); } catch { }
    if (d.kind === 'marquee') { this.marquee.classList.add('hidden'); if (d.moved) app.selectionChanged(); return; }
    if (d.kind === 'trim') { if (!d.moved) app.history.undoStack.pop(); else app.changed(); return; }
    if (d.kind === 'move') {
      if (!d.moved) { this.render(); return; }
      const ids = d.clips.map((c) => c.id);
      d.clips.forEach((c, i) => Object.assign(c, d.orig[i]));
      const trackMap = new Map(); if (d.targets) for (const [id, tid] of d.targets) trackMap.set(id, tid);
      moveClips(p, ids, d.dt, trackMap, { insert: d.insert });
      app.changed();
      return;
    }
  }
}
