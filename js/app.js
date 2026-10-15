// Cutroom: application shell. Wires the model, player, compositor, timeline, panels, monitors, menus and shortcuts.
import { el, timecode, parseTimecode, formatDuration, formatBytes, download, clamp, uid, deepClone, debounce, roundToFrame } from './util.js';
import * as M from './model.js';
import { Compositor } from './render.js';
import { AudioEngine } from './audio.js';
import { Player, probeFile, mediaTypeOf } from './media.js';
import { Timeline } from './timeline.js';
import { EffectControls } from './controls.js';
import { openModal, closeModal, promptDialog, confirmDialog, alertDialog, showContextMenu, isModalOpen } from './dialogs.js';
import { exportMp4, exportWebm, exportFrame, canUseWebCodecs } from './export.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.project = M.createProject({ name: 'Untitled' });
    this.history = new M.History();
    this.audio = new AudioEngine();
    this.player = new Player(() => this.project, this.audio);
    this.compositor = new Compositor();
    this.playhead = 0; this.selection = new Set(); this.tool = 'select'; this.snap = true; this.linked = true;
    this.clipboard = null; this.shuttle = 0; this.source = null; this.peaksCache = new Map();
    this.dirty = false;
  }

  init() {
    this.timeline = new Timeline(this);
    this.controls = new EffectControls(this);
    this.program = $('program'); this.programCtx = this.program.getContext('2d');
    this.buildMenus(); this.bindUI(); this.bindKeys(); this.bindDrop();
    this.player.onTick = (t) => { this.playhead = t; this.renderProgram(t); this.timeline.updatePlayhead(); this.timeline.scrollToPlayhead(); this.updateTc(); };
    this.player.onStop = (t) => { this.playhead = roundToFrame(t, this.project.fps); this.shuttle = 0; this.updatePlayButton(); this.drawFrame(); this.controls.render(); };
    this.renderEffectsPanel();
    this.loadProject(this.project);
    this.status('Ready. Import media to begin.');
    if (location.search.includes('demo')) this.demo();
  }

  // ---------- state helpers ----------
  edit(label, fn) { this.history.push(this.project, label); fn(); this.changed(); }
  changed() {
    this.dirty = true;
    this.player.gc();
    this.timeline.render();
    const st = this.controls.root.scrollTop; this.controls.render(); this.controls.root.scrollTop = st;
    this.updateSeqInfo(); this.drawFrame(); this.autosave();
  }
  select(ids, { toggle = false, add = false, silent = false } = {}) {
    if (toggle) for (const id of ids) { if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id); }
    else if (add) for (const id of ids) this.selection.add(id);
    else this.selection = new Set(ids);
    if (this.linked) this.selection = new Set(M.expandSelection(this.project, [...this.selection]));
    if (silent) this.timeline.updateSelection(); else this.selectionChanged();
  }
  selectionChanged() { this.timeline.updateSelection(); this.controls.render(); this.updateGizmo(); }
  selectedClips() { return [...this.selection].map((id) => M.clipById(this.project, id)).filter(Boolean); }
  status(msg) { $('status').textContent = msg; }
  setPlayhead(t, { scrub = false } = {}) {
    t = Math.max(0, t); if (!scrub) t = roundToFrame(t, this.project.fps);
    this.playhead = t; this.updateTc(); this.timeline.updatePlayhead(); if (!scrub) this.timeline.scrollToPlayhead();
    this.drawFrame(); this.controlsSoon();
  }
  controlsSoon = debounce(() => { const st = this.controls.root.scrollTop; this.controls.render(); this.controls.root.scrollTop = st; }, 120);
  updateTc() { $('tcInput').value = timecode(this.playhead, this.project.fps); }
  updateSeqInfo() {
    const p = this.project; $('seqInfo').textContent = `${p.name} · ${p.width}×${p.height} @ ${p.fps}fps`; $('seqDur').textContent = timecode(M.sequenceDuration(p), p.fps); $('projectName').textContent = p.name; document.title = `${p.name} — Cutroom`;
  }
  autosave = debounce(() => { try { localStorage.setItem('cutroom.autosave', JSON.stringify(M.serialize(this.project))); } catch { } }, 1500);

  loadProject(p) {
    this.player.stop(false);
    for (const rec of this.player.els.values()) { rec.el.pause(); rec.el.removeAttribute('src'); }
    this.player.els.clear(); this.player.images.clear();
    this.project = p; this.history = new M.History(); this.selection = new Set(); this.playhead = 0;
    this.sizeProgram(); this.renderBin(); this.timeline.render(); this.controls.render(); this.updateSeqInfo(); this.updateTc(); this.drawFrame(); this.timeline.zoomToFit();
  }

  // ---------- menus ----------
  buildMenus() {
    const menus = [
      ['File', [
        ['New Project…', 'Ctrl+N', () => this.newProjectDialog()], ['Open Project…', 'Ctrl+O', () => $('projectInput').click()], ['Save Project', 'Ctrl+S', () => this.saveProject()],
        ['Recover Autosave', '', () => this.recoverAutosave()], null,
        ['Import Media…', 'Ctrl+I', () => $('fileInput').click()], null,
        ['Sequence Settings…', '', () => this.sequenceSettings()], null,
        ['Export Video…', 'Ctrl+M', () => this.exportDialog()], ['Export Frame (PNG)', 'Ctrl+Shift+E', () => this.exportFrame()],
      ]],
      ['Edit', [
        ['Undo', 'Ctrl+Z', () => this.undo()], ['Redo', 'Ctrl+Shift+Z', () => this.redo()], null,
        ['Cut', 'Ctrl+X', () => this.cut()], ['Copy', 'Ctrl+C', () => this.copy()], ['Paste', 'Ctrl+V', () => this.paste()], ['Duplicate', 'Ctrl+Shift+D', () => this.duplicate()], null,
        ['Delete', 'Del', () => this.deleteSelection(false)], ['Ripple Delete', 'Shift+Del', () => this.deleteSelection(true)], null,
        ['Select All', 'Ctrl+A', () => this.select(this.project.clips.map((c) => c.id))], ['Deselect All', 'Esc', () => this.select([])],
      ]],
      ['Clip', [
        ['Split at Playhead', 'Ctrl+K', () => this.splitAtPlayhead()], ['Speed / Duration…', 'Ctrl+R', () => this.speedDialog()], ['Rename…', '', () => this.renameClip()], null,
        ['Link / Unlink', 'Ctrl+L', () => this.toggleLink()], ['Enable / Disable', 'Shift+E', () => this.toggleEnabled()], null,
        ['Apply Default Transition (Cross Dissolve)', 'Ctrl+D', () => this.applyTransition('Cross Dissolve', [...this.selection], 'both')], ['Remove Transitions', '', () => this.edit('Remove transitions', () => { for (const c of this.selectedClips()) { c.transitionIn = null; c.transitionOut = null; } })], null,
        ['Audio Fade In/Out 1s', '', () => this.edit('Fade', () => { for (const c of this.selectedClips()) if (c.kind === 'audio') { c.fadeIn = Math.min(1, c.duration / 2); c.fadeOut = Math.min(1, c.duration / 2); } })],
        ['Remove Effects', '', () => this.edit('Remove effects', () => { for (const c of this.selectedClips()) c.effects = []; })],
      ]],
      ['Sequence', [
        ['Add Title', 'Ctrl+T', () => this.addTitle()], ['Add Color Matte', '', () => this.addColorMatte()], null,
        ['Add Marker', 'M', () => this.addMarker()], ['Clear In/Out', 'Ctrl+Shift+X', () => this.edit('Clear in/out', () => { this.project.inPoint = null; this.project.outPoint = null; })], null,
        ['Add Video Track', '', () => this.edit('Add track', () => M.addTrack(this.project, 'video'))], ['Add Audio Track', '', () => this.edit('Add track', () => M.addTrack(this.project, 'audio'))], null,
        ['Zoom In', '=', () => this.timeline.setZoom(this.timeline.pxPerSec * 1.5)], ['Zoom Out', '-', () => this.timeline.setZoom(this.timeline.pxPerSec / 1.5)], ['Zoom to Fit', '\\', () => this.timeline.zoomToFit()],
      ]],
      ['Help', [['Keyboard Shortcuts', '', () => this.shortcutsDialog()], ['About Cutroom', '', () => alertDialog('Cutroom', 'A free, local, browser-based video editor.\nNothing is uploaded: media stays on your computer.\n\nExport uses WebCodecs (H.264/AAC MP4) with a WebM fallback.')]]],
    ];
    const host = $('menus');
    for (const [title, items] of menus) {
      const m = el('.menu'); const btn = el('button', title); m.append(btn);
      btn.addEventListener('click', (e) => { e.stopPropagation(); const open = m.classList.contains('open'); this.closeMenus(); if (!open) this.openMenu(m, items); });
      btn.addEventListener('pointerenter', () => { if (host.querySelector('.menu.open') && !m.classList.contains('open')) { this.closeMenus(); this.openMenu(m, items); } });
      host.append(m);
    }
    document.addEventListener('pointerdown', (e) => { if (!host.contains(e.target)) this.closeMenus(); });
  }
  openMenu(m, items) {
    const list = el('.menuList');
    for (const it of items) { if (!it) { list.append(el('.sep')); continue; } list.append(el('.item', { onclick: () => { this.closeMenus(); it[2](); } }, it[0], it[1] ? el('span.key', it[1]) : null)); }
    m.append(list); m.classList.add('open');
  }
  closeMenus() { for (const m of document.querySelectorAll('.menu.open')) { m.classList.remove('open'); m.querySelector('.menuList')?.remove(); } }

  // ---------- UI binding ----------
  bindUI() {
    for (const t of document.querySelectorAll('#leftPanel .tab')) t.addEventListener('click', () => { for (const x of document.querySelectorAll('#leftPanel .tab')) x.classList.toggle('active', x === t); for (const pg of document.querySelectorAll('#leftPanel .tabpage')) pg.classList.toggle('active', pg.id === t.dataset.tab + 'Panel'); });
    $('importBtn').onclick = () => $('fileInput').click();
    $('fileInput').onchange = (e) => { this.importFiles([...e.target.files]); e.target.value = ''; };
    $('projectInput').onchange = (e) => { if (e.target.files[0]) this.openProjectFile(e.target.files[0]); e.target.value = ''; };
    $('newTitleBtn').onclick = () => this.addTitle();
    $('newColorBtn').onclick = () => this.addColorMatte();
    $('mediaSearch').oninput = () => this.renderBin();
    $('exportBtn').onclick = () => this.exportDialog();
    $('projectName').ondblclick = async () => { const n = await promptDialog('Rename project', 'Name', this.project.name); if (n) { this.project.name = n; this.updateSeqInfo(); } };
    // transport
    $('playBtn').onclick = () => this.togglePlay();
    $('stepBack').onclick = () => this.step(-1); $('stepFwd').onclick = () => this.step(1);
    $('goStart').onclick = () => this.setPlayhead(0); $('goEnd').onclick = () => this.setPlayhead(M.sequenceDuration(this.project));
    $('markIn').onclick = () => this.markIn(); $('markOut').onclick = () => this.markOut();
    $('loopBtn').onclick = () => { this.player.loop = !this.player.loop; $('loopBtn').classList.toggle('active', this.player.loop); };
    $('tcInput').onchange = () => { const t = parseTimecode($('tcInput').value, this.project.fps); if (!isNaN(t)) this.setPlayhead(t); else this.updateTc(); $('tcInput').blur(); };
    $('tcInput').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { this.updateTc(); e.target.blur(); } };
    $('safeMargins').onchange = () => { $('safeOverlay').classList.toggle('hidden', !$('safeMargins').checked); };
    $('monitorZoom').onchange = () => this.sizeProgram();
    // timeline toolbar
    for (const b of document.querySelectorAll('.tool')) b.onclick = () => this.setTool(b.dataset.tool);
    $('snapBtn').onclick = () => { this.snap = !this.snap; $('snapBtn').classList.toggle('active', this.snap); };
    $('linkBtn').onclick = () => { this.linked = !this.linked; $('linkBtn').classList.toggle('active', this.linked); };
    $('splitBtn').onclick = () => this.splitAtPlayhead();
    $('markerBtn').onclick = () => this.addMarker();
    $('addVideoTrack').onclick = () => this.edit('Add track', () => M.addTrack(this.project, 'video'));
    $('addAudioTrack').onclick = () => this.edit('Add track', () => M.addTrack(this.project, 'audio'));
    $('zoom').oninput = () => this.timeline.setZoom(2 * Math.pow(500, $('zoom').value / 100));
    // source monitor
    $('srcPlay').onclick = () => this.sourceTogglePlay();
    $('srcStep-').onclick = () => this.sourceSeek(this.source ? this.source.time - 1 / this.project.fps : 0);
    $('srcStep+').onclick = () => this.sourceSeek(this.source ? this.source.time + 1 / this.project.fps : 0);
    $('srcIn').onclick = () => { if (this.source) { this.source.in = this.source.time; if (this.source.out != null && this.source.out <= this.source.in) this.source.out = null; this.drawSource(); } };
    $('srcOut').onclick = () => { if (this.source) { this.source.out = this.source.time; if (this.source.in != null && this.source.in >= this.source.out) this.source.in = null; this.drawSource(); } };
    $('srcInsert').onclick = () => this.sourceToTimeline(true);
    $('srcOverwrite').onclick = () => this.sourceToTimeline(false);
    $('srcScrub').addEventListener('pointerdown', (e) => {
      const r = $('srcScrub').getBoundingClientRect(); const go = (ev) => { if (this.source) this.sourceSeek(((ev.clientX - r.left) / r.width) * this.source.media.duration); };
      go(e); const mv = (ev) => go(ev); const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    new ResizeObserver(() => { this.sizeProgram(); this.drawSource(); }).observe($('programView'));
    this.bindGizmo();
    window.addEventListener('beforeunload', (e) => { if (this.dirty && this.project.clips.length) { e.preventDefault(); e.returnValue = ''; } });
  }
  setTool(t) { this.tool = t; for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === t); $('tlContent').style.cursor = t === 'razor' ? 'crosshair' : t === 'hand' ? 'grab' : ''; }
  bindDrop() {
    let depth = 0;
    document.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { depth++; $('dropOverlay').classList.remove('hidden'); } });
    document.addEventListener('dragleave', () => { if (depth > 0 && --depth === 0) $('dropOverlay').classList.add('hidden'); });
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      depth = 0; $('dropOverlay').classList.add('hidden');
      if (e.target.closest('#tlContent')) return; // timeline handles its own drop
      e.preventDefault(); if (e.dataTransfer.files?.length) this.importFiles([...e.dataTransfer.files]);
    });
  }

  // ---------- keyboard ----------
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (isModalOpen()) return;
      const tag = e.target.tagName; const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
      if (typing && !(e.target.type === 'range' || e.target.type === 'checkbox')) { if (e.key === 'Escape') e.target.blur(); return; }
      const k = e.key, K = k.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (ctrl) {
        const map = { z: () => (e.shiftKey ? this.redo() : this.undo()), y: () => this.redo(), x: () => this.cut(), c: () => this.copy(), v: () => this.paste(), a: () => this.select(this.project.clips.map((c) => c.id)),
          k: () => this.splitAtPlayhead(), s: () => this.saveProject(), o: () => $('projectInput').click(), i: () => $('fileInput').click(), n: () => this.newProjectDialog(), m: () => this.exportDialog(),
          l: () => this.toggleLink(), r: () => this.speedDialog(), d: () => (e.shiftKey ? this.duplicate() : this.applyTransition('Cross Dissolve', [...this.selection], 'both')), t: () => this.addTitle(), e: () => e.shiftKey && this.exportFrame() };
        if (map[K]) { stop(); map[K](); }
        return;
      }
      switch (k) {
        case ' ': stop(); this.togglePlay(); break;
        case 'k': case 'K': stop(); this.pause(); break;
        case 'j': case 'J': stop(); this.shuttleStep(-1); break;
        case 'l': case 'L': stop(); this.shuttleStep(1); break;
        case 'ArrowLeft': stop(); this.step(e.shiftKey ? -5 : -1); break;
        case 'ArrowRight': stop(); this.step(e.shiftKey ? 5 : 1); break;
        case 'ArrowUp': stop(); this.gotoEdit(-1); break;
        case 'ArrowDown': stop(); this.gotoEdit(1); break;
        case 'Home': stop(); this.setPlayhead(0); break;
        case 'End': stop(); this.setPlayhead(M.sequenceDuration(this.project)); break;
        case 'i': stop(); this.markIn(); break;
        case 'o': stop(); this.markOut(); break;
        case 'I': stop(); if (this.project.inPoint != null) this.setPlayhead(this.project.inPoint); break;
        case 'O': stop(); if (this.project.outPoint != null) this.setPlayhead(this.project.outPoint); break;
        case 'v': case 'V': stop(); this.setTool('select'); break;
        case 'c': case 'C': stop(); this.setTool('razor'); break;
        case 'h': case 'H': stop(); this.setTool('hand'); break;
        case 's': case 'S': stop(); $('snapBtn').click(); break;
        case 'Delete': case 'Backspace': stop(); this.deleteSelection(e.shiftKey); break;
        case 'Escape': stop(); this.select([]); break;
        case 'm': case 'M': stop(); this.addMarker(); break;
        case '=': case '+': stop(); this.timeline.setZoom(this.timeline.pxPerSec * 1.5); break;
        case '-': case '_': stop(); this.timeline.setZoom(this.timeline.pxPerSec / 1.5); break;
        case '\\': stop(); this.timeline.zoomToFit(); break;
        case 'q': case 'Q': stop(); this.trimToPlayhead('start'); break;
        case 'w': case 'W': stop(); this.trimToPlayhead('end'); break;
        case 'E': stop(); this.toggleEnabled(); break;
        case ',': stop(); this.sourceToTimeline(true); break;
        case '.': stop(); this.sourceToTimeline(false); break;
      }
    });
  }

  // ---------- playback ----------
  togglePlay() { if (this.player.playing) this.pause(); else this.play(1); }
  play(rate = 1) {
    const p = this.project; if (!p.clips.length) return;
    let start = this.playhead, end = null;
    if (p.inPoint != null && p.outPoint != null && this.playhead >= p.inPoint && this.playhead < p.outPoint) { end = p.outPoint; this.player.loopStart = p.inPoint; } else this.player.loopStart = 0;
    if (rate > 0 && start >= M.sequenceDuration(p) - 1e-6) start = this.player.loopStart;
    this.player.play(start, { end, rate });
    this.shuttle = rate; this.updatePlayButton(); $('gizmo').classList.add('hidden');
    this.meterLoop();
  }
  pause() { this.player.stop(true); this.shuttle = 0; this.updatePlayButton(); }
  shuttleStep(dir) {
    const seq = [1, 2, 4, 8];
    let r = this.shuttle;
    if (r === 0 || Math.sign(r) !== dir) r = dir; else { const i = seq.indexOf(Math.abs(r)); r = dir * seq[Math.min(seq.length - 1, i + 1)]; }
    this.play(r);
  }
  updatePlayButton() { $('playBtn').textContent = this.player.playing ? '❚❚' : '▶'; }
  step(frames) { if (this.player.playing) this.pause(); this.setPlayhead(this.playhead + frames / this.project.fps); }
  gotoEdit(dir) {
    const pts = M.snapPoints(this.project).filter((t) => (dir > 0 ? t > this.playhead + 1e-4 : t < this.playhead - 1e-4)).sort((a, b) => a - b);
    if (pts.length) this.setPlayhead(dir > 0 ? pts[0] : pts[pts.length - 1]);
  }
  markIn() { this.edit('Mark in', () => { this.project.inPoint = this.playhead; if (this.project.outPoint != null && this.project.outPoint <= this.playhead) this.project.outPoint = null; }); }
  markOut() { this.edit('Mark out', () => { this.project.outPoint = this.playhead; if (this.project.inPoint != null && this.project.inPoint >= this.playhead) this.project.inPoint = null; }); }
  meterLoop() {
    const tick = () => { if (!this.player.playing) { $('meterBar').style.width = '0%'; return; } $('meterBar').style.width = Math.min(100, this.audio.level() * 100) + '%'; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  // ---------- program monitor ----------
  sizeProgram() {
    const p = this.project; const view = $('programView');
    const cap = 1280; const s = Math.min(1, cap / Math.max(p.width, p.height));
    const w = Math.round(p.width * s), h = Math.round(p.height * s);
    if (this.program.width !== w || this.program.height !== h) { this.program.width = w; this.program.height = h; }
    const z = $('monitorZoom').value;
    if (z === 'fit') { const fit = Math.min((view.clientWidth - 16) / p.width, (view.clientHeight - 16) / p.height); this.program.style.width = Math.max(1, Math.floor(p.width * fit)) + 'px'; this.program.style.height = Math.max(1, Math.floor(p.height * fit)) + 'px'; }
    else { this.program.style.width = Math.round(p.width * z) + 'px'; this.program.style.height = Math.round(p.height * z) + 'px'; }
    this.program.style.maxWidth = 'none'; this.program.style.maxHeight = 'none';
    this.renderProgram(this.playhead); this.updateGizmo();
  }
  async drawFrame() {
    const req = (this._req = (this._req || 0) + 1);
    if (this.player.playing) return;
    const t = this.playhead;
    try { await this.player.seek(t); } catch { }
    if (req !== this._req) return;
    this.renderProgram(t);
    this.updateGizmo();
  }
  renderProgram(t) {
    try { this.compositor.render(this.programCtx, this.project, t, this.player.getSource); } catch (e) { console.error(e); }
    const r = this.program.getBoundingClientRect(), v = $('programView').getBoundingClientRect();
    Object.assign($('safeOverlay').style, { left: (r.left - v.left) + 'px', top: (r.top - v.top) + 'px', width: r.width + 'px', height: r.height + 'px' });
  }
  gizmoClip() { const cs = this.selectedClips().filter((c) => c.kind !== 'audio'); return cs.length === 1 && !this.player.playing ? cs[0] : null; }
  updateGizmo() {
    const g = $('gizmo'); const c = this.gizmoClip();
    if (!c || this.playhead < c.start || this.playhead >= M.clipEnd(c)) { g.classList.add('hidden'); $('programView').classList.remove('draggable'); return; }
    const b = this.compositor.clipBounds(this.project, c, this.playhead, this.player.getSource);
    if (!b) { g.classList.add('hidden'); return; }
    const r = this.program.getBoundingClientRect(), v = $('programView').getBoundingClientRect();
    const s = r.width / this.project.width;
    Object.assign(g.style, { left: (r.left - v.left + (b.cx - b.w / 2) * s) + 'px', top: (r.top - v.top + (b.cy - b.h / 2) * s) + 'px', width: (b.w * s) + 'px', height: (b.h * s) + 'px', transform: `rotate(${b.rot}deg)` });
    g.classList.remove('hidden'); $('programView').classList.add('draggable');
  }
  bindGizmo() {
    const view = $('programView');
    view.addEventListener('pointerdown', (e) => {
      const c = this.gizmoClip(); if (!c || e.button !== 0) return;
      if (this.playhead < c.start || this.playhead >= M.clipEnd(c)) return;
      const r = this.program.getBoundingClientRect(); const s = r.width / this.project.width;
      const handle = e.target.closest('.h'); const lt = this.playhead - c.start;
      const b = this.compositor.clipBounds(this.project, c, this.playhead, this.player.getSource); if (!b) return;
      const cx = r.left + b.cx * s, cy = r.top + b.cy * s;
      const inside = handle || (Math.abs(e.clientX - cx) <= b.w * s / 2 + 4 && Math.abs(e.clientY - cy) <= b.h * s / 2 + 4);
      if (!inside) return;
      e.preventDefault(); view.setPointerCapture(e.pointerId);
      this.history.push(this.project, 'Transform');
      const o = { x: M.getProp(c, 'x', lt), y: M.getProp(c, 'y', lt), scale: M.getProp(c, 'scale', lt), rot: M.getProp(c, 'rotation', lt) };
      const d0 = Math.hypot(e.clientX - cx, e.clientY - cy), a0 = Math.atan2(e.clientY - cy, e.clientX - cx);
      const setP = (prop, v) => { if (M.isAnimated(c, prop)) M.setKeyframe(c, prop, lt, v); else c.transform[prop] = v; };
      const mv = (ev) => {
        if (handle && handle.classList.contains('rot')) { const a = Math.atan2(ev.clientY - cy, ev.clientX - cx); setP('rotation', Math.round((o.rot + ((a - a0) * 180) / Math.PI) * 10) / 10); }
        else if (handle) { const d = Math.hypot(ev.clientX - cx, ev.clientY - cy); setP('scale', Math.max(1, Math.round(o.scale * (d / Math.max(1, d0)) * 10) / 10)); }
        else { setP('x', Math.round(o.x + (ev.clientX - e.clientX) / s)); setP('y', Math.round(o.y + (ev.clientY - e.clientY) / s)); }
        this.renderProgram(this.playhead); this.updateGizmo();
      };
      const up = () => { view.removeEventListener('pointermove', mv); view.removeEventListener('pointerup', up); this.changed(); };
      view.addEventListener('pointermove', mv); view.addEventListener('pointerup', up);
    });
  }

  // ---------- media bin ----------
  async importFiles(files, place = null) {
    const good = files.filter((f) => mediaTypeOf(f));
    if (!good.length) { this.status('No supported media files.'); return []; }
    this.status(`Importing ${good.length} file(s)…`);
    const added = [];
    for (const f of good) {
      try { const m = M.addMedia(this.project, await probeFile(f)); added.push(m); this.renderBin(); }
      catch (e) { console.warn(e); this.status(`Could not import ${f.name}`); }
    }
    this.status(`Imported ${added.length} file(s).`);
    if (place && added.length) {
      let t = place.time ?? this.playhead; const track = place.track;
      this.history.push(this.project, 'Import to timeline');
      for (const m of added) { const clips = this.clipsFromMedia(m); this.placeClips(clips, track, t); t += clips[0].duration; }
      this.changed();
    }
    for (const m of added) if (m.type !== 'image') this.peaksFor(m);
    return added;
  }
  peaksFor(media) {
    if (!this.peaksCache.has(media.id)) this.peaksCache.set(media.id, this.audio.peaks(media).then((pk) => { if (!pk) media.hasAudio = false; this.renderBin(); return pk; }));
    return this.peaksCache.get(media.id);
  }
  renderBin() {
    const list = $('mediaList'); list.innerHTML = '';
    const q = ($('mediaSearch').value || '').toLowerCase();
    const items = this.project.media.filter((m) => !q || m.name.toLowerCase().includes(q));
    $('mediaEmpty').classList.toggle('hidden', this.project.media.length > 0);
    for (const m of items) {
      const thumb = el('.thumb', { style: m.thumb ? { backgroundImage: `url(${m.thumb})` } : {} }, m.thumb ? '' : m.type === 'audio' ? '♪' : '▣');
      const sub = m.type === 'image' ? `${m.width}×${m.height}` : `${formatDuration(m.duration)}${m.width ? ` · ${m.width}×${m.height}` : ''}${m.type === 'video' && !m.hasAudio ? ' · no audio' : ''}`;
      const it = el('.mediaItem', { draggable: true, dataset: { id: m.id }, title: `${m.name}\n${formatBytes(m.size || 0)}` }, thumb, el('.meta', el('.name', m.name), el('.sub', el('span.badge', m.type), sub)));
      if (m.missing) it.style.opacity = '.5';
      it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-media', m.id); e.dataTransfer.effectAllowed = 'copy'; });
      it.addEventListener('click', () => { for (const x of list.children) x.classList.toggle('selected', x === it); this.binSelected = m.id; });
      it.addEventListener('dblclick', () => this.openSource(m));
      it.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu([
          { label: 'Open in Source Monitor', onClick: () => this.openSource(m) },
          { label: 'Add to Timeline at Playhead', onClick: () => this.addMediaToTimeline(m.id, null, this.playhead) },
          { label: 'Rename…', onClick: async () => { const n = await promptDialog('Rename media', 'Name', m.name); if (n) { m.name = n; this.renderBin(); } } },
          { sep: true },
          { label: 'Remove from Project', onClick: async () => { const used = this.project.clips.filter((c) => c.mediaId === m.id).length; if (!used || await confirmDialog('Remove media', `${m.name} is used by ${used} clip(s). Remove it and those clips?`)) this.edit('Remove media', () => M.removeMedia(this.project, m.id)), this.renderBin(); } },
        ], e.clientX, e.clientY);
      });
      list.append(it);
    }
  }
  renderEffectsPanel() {
    const fx = $('fxList'); fx.innerHTML = '';
    for (const name of Object.keys(M.EFFECTS)) {
      const it = el('.fxItem', { draggable: true, title: 'Drag onto a clip, or double-click to apply to the selection' }, name);
      it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-effect', name); });
      it.addEventListener('dblclick', () => this.applyEffect(name, [...this.selection]));
      fx.append(it);
    }
    const tr = $('trList'); tr.innerHTML = '';
    for (const name of M.TRANSITIONS) {
      const it = el('.fxItem', { draggable: true, title: 'Drag onto a clip edge, or double-click to apply to the selection' }, name);
      it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-transition', name); });
      it.addEventListener('dblclick', () => this.applyTransition(name, [...this.selection], 'both'));
      tr.append(it);
    }
  }

  // ---------- creating clips ----------
  clipsFromMedia(m, inPt = 0, outPt = null) {
    const dur = (outPt ?? m.duration) - inPt;
    const out = [];
    if (m.type === 'audio') out.push(M.makeClip({ kind: 'audio', mediaId: m.id, name: m.name, duration: dur, inPoint: inPt }));
    else {
      const v = M.makeClip({ kind: 'video', mediaId: m.id, name: m.name, duration: m.type === 'image' ? 5 : dur, inPoint: inPt });
      out.push(v);
      if (m.type === 'video' && m.hasAudio !== false) { const a = M.makeClip({ kind: 'audio', mediaId: m.id, name: m.name, duration: dur, inPoint: inPt }); const l = uid('lnk'); v.linkId = l; a.linkId = l; out.push(a); }
    }
    return out;
  }
  // Place clips: video on `track` (or V1) and linked audio on the first unlocked audio track.
  placeClips(clips, track, t, { insert = false } = {}) {
    const p = this.project;
    const firstFree = (kind) => p.tracks.find((tr) => tr.kind === kind && !tr.locked) || p.tracks.find((tr) => tr.kind === kind);
    for (const c of clips) {
      let tr = track && track.kind === c.kind ? track : null;
      if (!tr && track && c.kind === 'audio' && clips.length > 1) tr = firstFree('audio');
      if (!tr) tr = firstFree(c.kind);
      if (!tr) tr = M.addTrack(p, c.kind);
      M.placeClip(p, c, tr.id, t, { insert });
    }
  }
  addMediaToTimeline(mediaId, track, t, { insert = false } = {}) {
    const m = M.mediaById(this.project, mediaId); if (!m) return;
    this.edit('Add clip', () => { const clips = this.clipsFromMedia(m); this.placeClips(clips, track, t, { insert }); this.selection = new Set(clips.map((c) => c.id)); });
    this.status(`Added ${m.name}`);
  }
  addTitle(t = this.playhead, track = null) {
    const c = M.makeClip({ kind: 'title', name: 'Title', duration: 5, text: M.defaultText() });
    const top = M.videoTracks(this.project); const tr = track || top.find((x) => !M.clipAt(this.project, x.id, t) && !x.locked) || top[top.length - 1];
    this.edit('Add title', () => { M.placeClip(this.project, c, tr.id, t); this.selection = new Set([c.id]); });
  }
  addColorMatte(t = this.playhead, track = null) {
    const c = M.makeClip({ kind: 'color', name: 'Color Matte', duration: 5, color: '#1f6feb' });
    const vt = M.videoTracks(this.project); const tr = track || vt.find((x) => !M.clipAt(this.project, x.id, t) && !x.locked) || vt[0];
    this.edit('Add color matte', () => { M.placeClip(this.project, c, tr.id, t); this.selection = new Set([c.id]); });
  }

  // ---------- editing commands ----------
  undo() { const l = this.history.undo(this.project); if (l != null) { this.selection = new Set([...this.selection].filter((id) => M.clipById(this.project, id))); this.changedAfterHistory(); this.status(`Undo ${l}`); } }
  redo() { const l = this.history.redo(this.project); if (l != null) { this.selection = new Set([...this.selection].filter((id) => M.clipById(this.project, id))); this.changedAfterHistory(); this.status(`Redo ${l}`); } }
  changedAfterHistory() { this.player.gc(); this.timeline.render(); this.controls.render(); this.updateSeqInfo(); this.drawFrame(); this.autosave(); }
  splitAtPlayhead() {
    const t = this.playhead; const ids = this.selection.size ? [...this.selection] : null;
    const targets = (ids ? ids.map((i) => M.clipById(this.project, i)) : this.project.clips).filter((c) => c && t > c.start + 1e-6 && t < M.clipEnd(c) - 1e-6);
    if (!targets.length) { this.status('Nothing to split at the playhead.'); return; }
    this.edit('Split', () => { const r = M.splitAll(this.project, t, targets.map((c) => c.id)); if (ids) this.selection = new Set(r.map((c) => c.id)); });
  }
  deleteSelection(ripple) {
    const ids = [...this.selection].filter((id) => { const c = M.clipById(this.project, id); return c && !M.trackById(this.project, c.trackId)?.locked; });
    if (!ids.length) return;
    this.edit(ripple ? 'Ripple delete' : 'Delete', () => { if (ripple) M.rippleDeleteClips(this.project, ids); else M.deleteClips(this.project, ids); this.selection.clear(); });
  }
  copy() { const cs = this.selectedClips(); if (!cs.length) return; const t0 = Math.min(...cs.map((c) => c.start)); this.clipboard = cs.map((c) => ({ ...deepClone(c), start: c.start - t0 })); this.status(`Copied ${cs.length} clip(s)`); }
  cut() { this.copy(); this.deleteSelection(false); }
  paste() {
    if (!this.clipboard?.length) return;
    const p = this.project; const linkMap = new Map();
    this.edit('Paste', () => {
      const ids = [];
      for (const src of this.clipboard) {
        const c = deepClone(src); c.id = uid('clip');
        if (c.linkId) { if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('lnk')); c.linkId = linkMap.get(c.linkId); }
        const tr = M.trackById(p, c.trackId) || p.tracks.find((t) => t.kind === c.kind) || M.addTrack(p, c.kind);
        M.placeClip(p, c, tr.id, this.playhead + c.start); ids.push(c.id);
      }
      this.selection = new Set(ids);
    });
  }
  duplicate() { const cs = this.selectedClips(); if (!cs.length) return; const t1 = Math.max(...cs.map(M.clipEnd)); const saved = this.playhead; this.copy(); this.playhead = t1; this.paste(); this.playhead = saved; this.updateTc(); this.timeline.updatePlayhead(); }
  applyEffect(name, ids) {
    const def = M.EFFECTS[name]; if (!def) return;
    const cs = ids.map((i) => M.clipById(this.project, i)).filter((c) => c && c.kind !== 'audio');
    if (!cs.length) { this.status('Select a video, title or color clip first.'); return; }
    this.edit('Add ' + name, () => { for (const c of cs) { const params = {}; for (const [k, s] of Object.entries(def.params)) params[k] = s[0]; (c.effects ||= []).push({ id: uid('fx'), type: name, enabled: true, params }); } });
  }
  applyTransition(name, ids, edge = 'both', duration = 1) {
    const cs = ids.map((i) => M.clipById(this.project, i)).filter((c) => c && c.kind !== 'audio');
    if (!cs.length) { this.status('Select a video clip first.'); return; }
    this.edit('Add transition', () => { for (const c of cs) { const d = Math.min(duration, c.duration); if (edge === 'in' || edge === 'both') c.transitionIn = { type: name, duration: d }; if (edge === 'out' || edge === 'both') c.transitionOut = { type: name, duration: d }; } });
  }
  setSpeed(c, speed) {
    this.edit('Speed', () => {
      const ids = this.linked ? M.expandSelection(this.project, [c.id]) : [c.id];
      for (const id of ids) { const k = M.clipById(this.project, id); const srcLen = k.duration * k.speed; k.speed = speed; k.duration = srcLen / speed; M.clearRange(this.project, k.trackId, k.start, M.clipEnd(k), [k.id]); }
    });
  }
  async speedDialog() {
    const c = this.selectedClips()[0]; if (!c) return;
    const v = await promptDialog('Speed / Duration', 'Speed %', Math.round(c.speed * 100), { type: 'number' });
    if (v != null && !isNaN(parseFloat(v))) this.setSpeed(c, clamp(parseFloat(v) / 100, 0.01, 16));
  }
  async renameClip() { const c = this.selectedClips()[0]; if (!c) return; const n = await promptDialog('Rename clip', 'Name', c.name); if (n) this.edit('Rename', () => { c.name = n; }); }
  toggleLink() {
    const cs = this.selectedClips(); if (!cs.length) return;
    if (cs.some((c) => c.linkId)) this.edit('Unlink', () => M.unlink(this.project, cs.map((c) => c.id)));
    else if (cs.length >= 2) this.edit('Link', () => M.link(this.project, cs.map((c) => c.id)));
  }
  toggleEnabled() { const cs = this.selectedClips(); if (cs.length) this.edit('Enable/disable', () => { for (const c of cs) c.enabled = c.enabled === false; }); }
  trimToPlayhead(edge) {
    const t = this.playhead;
    const cs = this.selectedClips().filter((c) => t > c.start && t < M.clipEnd(c));
    if (!cs.length) return;
    this.edit('Trim to playhead', () => { for (const c of cs) M.trimClip(this.project, c, edge, t, { ripple: true }); });
  }
  addMarker() { this.edit('Add marker', () => M.addMarker(this.project, this.playhead)); }

  // ---------- context menus ----------
  clipContextMenu(x, y) {
    const cs = this.selectedClips(); const c = cs[0]; if (!c) return;
    showContextMenu([
      { label: 'Cut', key: 'Ctrl+X', onClick: () => this.cut() }, { label: 'Copy', key: 'Ctrl+C', onClick: () => this.copy() }, { label: 'Paste', key: 'Ctrl+V', onClick: () => this.paste(), disabled: !this.clipboard },
      { sep: true },
      { label: 'Split at Playhead', key: 'Ctrl+K', onClick: () => this.splitAtPlayhead() },
      { label: 'Speed / Duration…', key: 'Ctrl+R', onClick: () => this.speedDialog() },
      { label: c.linkId ? 'Unlink' : 'Link', key: 'Ctrl+L', onClick: () => this.toggleLink(), disabled: !c.linkId && cs.length < 2 },
      { label: c.enabled === false ? 'Enable' : 'Disable', key: 'Shift+E', onClick: () => this.toggleEnabled() },
      { label: 'Rename…', onClick: () => this.renameClip() },
      { sep: true },
      { label: 'Apply Cross Dissolve', key: 'Ctrl+D', onClick: () => this.applyTransition('Cross Dissolve', cs.map((k) => k.id), 'both') },
      { label: 'Remove Transitions', onClick: () => this.edit('Remove transitions', () => { for (const k of cs) { k.transitionIn = null; k.transitionOut = null; } }) },
      { label: 'Remove Effects', onClick: () => this.edit('Remove effects', () => { for (const k of cs) k.effects = []; }) },
      { sep: true },
      { label: 'Open in Source Monitor', onClick: () => this.openClipInSource(c) },
      { sep: true },
      { label: 'Delete', key: 'Del', onClick: () => this.deleteSelection(false) }, { label: 'Ripple Delete', key: 'Shift+Del', onClick: () => this.deleteSelection(true) },
    ], x, y);
  }
  timelineContextMenu(t, track, x, y) {
    showContextMenu([
      { label: 'Paste', key: 'Ctrl+V', onClick: () => { this.setPlayhead(t); this.paste(); }, disabled: !this.clipboard },
      { label: 'Close Gap (Ripple Delete)', onClick: () => this.edit('Close gap', () => M.closeGap(this.project, track.id, t)), disabled: !track },
      { sep: true },
      { label: 'Add Title Here', onClick: () => this.addTitle(t, track && track.kind === 'video' ? track : null) },
      { label: 'Add Color Matte Here', onClick: () => this.addColorMatte(t, track && track.kind === 'video' ? track : null) },
      { label: 'Add Marker Here', onClick: () => this.edit('Add marker', () => M.addMarker(this.project, t)) },
      { sep: true },
      { label: 'Zoom to Fit', key: '\\', onClick: () => this.timeline.zoomToFit() },
    ], x, y);
  }
  trackContextMenu(track, x, y) {
    const n = this.project.tracks.filter((t) => t.kind === track.kind).length;
    showContextMenu([
      { label: 'Add Video Track', onClick: () => this.edit('Add track', () => M.addTrack(this.project, 'video')) },
      { label: 'Add Audio Track', onClick: () => this.edit('Add track', () => M.addTrack(this.project, 'audio')) },
      { sep: true },
      { label: `Delete Track ${track.name}`, disabled: n <= 1, onClick: async () => { const used = this.project.clips.filter((c) => c.trackId === track.id).length; if (!used || await confirmDialog('Delete track', `${track.name} has ${used} clip(s). Delete anyway?`)) this.edit('Delete track', () => M.removeTrack(this.project, track.id)); } },
    ], x, y);
  }

  // ---------- source monitor ----------
  openClipInSource(c) { const m = M.mediaById(this.project, c.mediaId); if (m) this.openSource(m, c.inPoint); else this.status('This clip has no source media.'); }
  openSource(m, t = 0) {
    if (this.source?.el) { this.source.el.pause(); this.source.el.removeAttribute('src'); }
    this.source = { media: m, time: 0, in: null, out: null, el: null, playing: false };
    $('sourceName').textContent = m.name; $('sourceEmpty').classList.add('hidden'); $('sourceCanvas').classList.remove('hidden'); $('sourceDur').textContent = timecode(m.duration, this.project.fps);
    if (m.type !== 'image') {
      const e = document.createElement(m.type === 'audio' ? 'audio' : 'video'); e.src = m.url; e.preload = 'auto'; e.playsInline = true; this.source.el = e;
      e.addEventListener('seeked', () => this.drawSource()); e.addEventListener('loadeddata', () => this.drawSource());
    }
    this.sourceSeek(t);
  }
  sourceSeek(t) {
    const s = this.source; if (!s) return;
    s.time = clamp(t, 0, s.media.duration);
    if (s.el) { s.el.currentTime = s.time; }
    this.drawSource();
  }
  sourceTogglePlay() {
    const s = this.source; if (!s || !s.el) return;
    if (s.playing) { s.el.pause(); s.playing = false; $('srcPlay').textContent = '▶'; return; }
    if (s.time >= s.media.duration - 0.05) s.el.currentTime = s.time = 0;
    s.el.play().catch(() => { }); s.playing = true; $('srcPlay').textContent = '❚❚';
    const tick = () => { if (!s.playing || this.source !== s) return; s.time = s.el.currentTime; this.drawSource(); if (s.el.ended || s.el.paused) { s.playing = false; $('srcPlay').textContent = '▶'; return; } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  drawSource() {
    const s = this.source; if (!s) return;
    const cv = $('sourceCanvas'); const view = cv.parentElement; const m = s.media;
    const w = m.width || 640, h = m.height || 360;
    const fit = Math.min((view.clientWidth - 16) / w, (view.clientHeight - 16) / h);
    cv.width = Math.max(1, Math.round(w * Math.min(1, fit))); cv.height = Math.max(1, Math.round(h * Math.min(1, fit)));
    cv.style.width = Math.max(1, Math.floor(w * fit)) + 'px'; cv.style.height = Math.max(1, Math.floor(h * fit)) + 'px'; cv.style.maxWidth = 'none'; cv.style.maxHeight = 'none';
    const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    if (m.type === 'image') { const img = this.player.image(m); if (img.complete) g.drawImage(img, 0, 0, cv.width, cv.height); else img.onload = () => this.drawSource(); }
    else if (m.type === 'video') { try { g.drawImage(s.el, 0, 0, cv.width, cv.height); } catch { } }
    else this.peaksFor(m).then((pk) => { if (!pk || this.source !== s) return; g.fillStyle = '#3fb950'; const n = pk.length; for (let x = 0; x < cv.width; x++) { const i = Math.floor((x / cv.width) * n); const a = pk[i] * cv.height; g.fillRect(x, (cv.height - a) / 2, 1, Math.max(1, a)); } const px = (s.time / m.duration) * cv.width; g.fillStyle = '#7cc4ff'; g.fillRect(px, 0, 2, cv.height); });
    $('sourceTc').textContent = timecode(s.time, this.project.fps);
    const sc = $('srcScrub'); sc.querySelector('.head').style.left = `${(s.time / Math.max(0.001, m.duration)) * 100}%`;
    const io = sc.querySelector('.inout'); const a = s.in ?? 0, b = s.out ?? m.duration; io.style.left = `${(a / Math.max(0.001, m.duration)) * 100}%`; io.style.width = `${((b - a) / Math.max(0.001, m.duration)) * 100}%`;
  }
  sourceToTimeline(insert) {
    const s = this.source; if (!s) { this.status('Open a media item in the Source monitor first.'); return; }
    const m = s.media; const inPt = s.in ?? 0, outPt = s.out ?? m.duration;
    if (outPt - inPt <= 0) return;
    this.edit(insert ? 'Insert' : 'Overwrite', () => {
      const clips = this.clipsFromMedia(m, inPt, m.type === 'image' ? null : outPt);
      this.placeClips(clips, null, this.playhead, { insert }); this.selection = new Set(clips.map((c) => c.id));
      this.playhead = roundToFrame(this.playhead + clips[0].duration, this.project.fps);
    });
    this.updateTc(); this.timeline.updatePlayhead();
  }

  // ---------- project files ----------
  async newProjectDialog() {
    const name = el('input', { type: 'text', value: 'Untitled' });
    const preset = el('select', ...M.PRESETS.map((p, i) => el('option', { value: i }, p.name)), el('option', { value: 'custom' }, 'Custom…'));
    const w = el('input', { type: 'number', value: 1920, min: 16, max: 8192 }), h = el('input', { type: 'number', value: 1080, min: 16, max: 8192 }), fps = el('input', { type: 'number', value: 30, min: 1, max: 120, step: 0.001 });
    const custom = el('.row', el('label', 'Size / fps'), w, el('span', '×'), h, el('span', '@'), fps); custom.style.display = 'none';
    preset.onchange = () => { custom.style.display = preset.value === 'custom' ? '' : 'none'; if (preset.value !== 'custom') { const pr = M.PRESETS[preset.value]; w.value = pr.width; h.value = pr.height; fps.value = pr.fps; } };
    openModal('New Project', [el('.row', el('label', 'Name'), name), el('.row', el('label', 'Preset'), preset), custom, el('p.hint', 'The current project will be replaced. Save it first if needed (Ctrl+S).')], [
      { label: 'Cancel' },
      { label: 'Create', primary: true, onClick: () => { this.loadProject(M.createProject({ name: name.value || 'Untitled', width: +w.value || 1920, height: +h.value || 1080, fps: +fps.value || 30 })); this.dirty = false; } },
    ]);
  }
  sequenceSettings() {
    const p = this.project;
    const w = el('input', { type: 'number', value: p.width, min: 16, max: 8192 }), h = el('input', { type: 'number', value: p.height, min: 16, max: 8192 }), fps = el('input', { type: 'number', value: p.fps, min: 1, max: 120, step: 0.001 });
    const name = el('input', { type: 'text', value: p.name });
    openModal('Sequence Settings', [el('.row', el('label', 'Name'), name), el('.row', el('label', 'Frame size'), w, el('span', '×'), h), el('.row', el('label', 'Frame rate'), fps)], [
      { label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => { p.name = name.value || p.name; p.width = +w.value || p.width; p.height = +h.value || p.height; p.fps = +fps.value || p.fps; this.compositor.titleCache.clear(); this.sizeProgram(); this.changed(); } },
    ]);
  }
  saveProject() {
    const json = JSON.stringify(M.serialize(this.project), null, 1);
    download(new Blob([json], { type: 'application/json' }), `${this.project.name.replace(/[^\w.-]+/g, '_')}.cutroom`);
    this.dirty = false; this.status('Project saved (media files must be kept alongside; relink on open).');
  }
  async openProjectFile(file) {
    try { const p = M.deserialize(JSON.parse(await file.text())); await this.relinkDialog(p); this.loadProject(p); this.dirty = false; }
    catch (e) { alertDialog('Open failed', String(e.message || e)); }
  }
  async recoverAutosave() {
    let raw = null; try { raw = localStorage.getItem('cutroom.autosave'); } catch { }
    if (!raw) { alertDialog('Recover', 'No autosave found.'); return; }
    const p = M.deserialize(JSON.parse(raw)); await this.relinkDialog(p); this.loadProject(p);
  }
  // Ask for the media files referenced by a loaded project (matched by file name).
  relinkDialog(p) {
    return new Promise((resolve) => {
      if (!p.media.length) return resolve();
      for (const m of p.media) m.missing = true;
      const list = el('.list.relink');
      const refresh = () => { list.innerHTML = ''; for (const m of p.media) list.append(el('.item', el('span', { class: m.missing ? 'missing' : 'ok' }, m.missing ? '✗' : '✓'), el('span', m.name))); };
      refresh();
      const picker = el('input', { type: 'file', multiple: true, hidden: true });
      picker.onchange = async () => {
        for (const f of picker.files) {
          const m = p.media.find((x) => x.missing && x.name === f.name) || p.media.find((x) => x.missing && x.size === f.size);
          if (!m) continue;
          try { const probed = await probeFile(f); Object.assign(m, probed, { id: m.id, name: m.name }); m.missing = false; } catch { }
        }
        refresh(); picker.value = '';
      };
      openModal('Relink media', [el('p', 'Select the original media files for this project. Items are matched by file name.'), list, picker,
        el('.row', el('button', { onclick: () => picker.click() }, 'Locate files…'))], [{ label: 'Continue', primary: true, onClick: () => resolve() }], { escape: false });
    });
  }

  // ---------- export ----------
  exportDialog() {
    const p = this.project;
    if (!p.clips.length) { alertDialog('Export', 'The sequence is empty.'); return; }
    const webcodecs = canUseWebCodecs();
    const fmt = el('select', el('option', { value: 'mp4', disabled: !webcodecs }, 'MP4 (H.264 + AAC)' + (webcodecs ? '' : ' — not supported here')), el('option', { value: 'webm' }, 'WebM (VP9/VP8 + Opus, realtime)'));
    if (!webcodecs) fmt.value = 'webm';
    const res = el('select', el('option', { value: 'seq' }, `Sequence (${p.width}×${p.height})`), el('option', { value: '1080' }, '1080p'), el('option', { value: '720' }, '720p'), el('option', { value: '480' }, '480p'));
    const fps = el('input', { type: 'number', value: p.fps, min: 1, max: 120, step: 0.001 });
    const br = el('input', { type: 'number', value: p.width * p.height >= 3840 * 2160 ? 35 : p.width * p.height >= 1920 * 1080 ? 10 : 5, min: 0.5, max: 100, step: 0.5 });
    const range = el('select', el('option', { value: 'all' }, 'Entire sequence'), el('option', { value: 'inout', disabled: p.inPoint == null && p.outPoint == null }, 'In to Out'));
    const audio = el('input', { type: 'checkbox', checked: true });
    const fname = el('input', { type: 'text', value: p.name.replace(/[^\w.-]+/g, '_') });
    openModal('Export Video', [
      el('.row', el('label', 'File name'), fname), el('.row', el('label', 'Format'), fmt), el('.row', el('label', 'Resolution'), res),
      el('.row', el('label', 'Frame rate'), fps), el('.row', el('label', 'Bitrate (Mbps)'), br), el('.row', el('label', 'Range'), range), el('.row', el('label', 'Include audio'), audio),
      el('p.hint', 'MP4 export renders frame-by-frame with WebCodecs (faster than realtime on most machines). WebM export records a realtime playback.'),
    ], [{ label: 'Cancel' }, { label: 'Export', primary: true, onClick: () => {
      let w = p.width, h = p.height;
      if (res.value !== 'seq') { const target = +res.value; const s = target / Math.min(p.width, p.height); w = Math.round(p.width * s / 2) * 2; h = Math.round(p.height * s / 2) * 2; }
      const t0 = range.value === 'inout' ? (p.inPoint ?? 0) : 0, t1 = range.value === 'inout' ? (p.outPoint ?? M.sequenceDuration(p)) : M.sequenceDuration(p);
      setTimeout(() => this.runExport({ format: fmt.value, width: w, height: h, fps: +fps.value || p.fps, bitrate: (+br.value || 8) * 1e6, t0, t1, includeAudio: audio.checked, name: fname.value || 'export' }), 50);
    } }]);
  }
  async runExport(o) {
    const bar = el('.progress', el('div')); const label = el('p', 'Preparing…');
    const ctrl = new AbortController();
    openModal('Exporting', [label, bar], [{ label: 'Cancel', onClick: () => { ctrl.abort(); return false; } }], { escape: false });
    const t0 = performance.now();
    const onProgress = (phase, f) => { bar.firstChild.style.width = Math.round(f * 100) + '%'; label.textContent = `${phase === 'audio' ? 'Rendering audio' : phase === 'mux' ? 'Writing file' : 'Rendering video'} ${Math.round(f * 100)}%`; };
    if (this.player.playing) this.pause();
    const savedTick = this.player.onTick, savedStop = this.player.onStop;
    try {
      const args = { project: this.project, player: this.player, compositor: this.compositor, audio: this.audio, ...o, onProgress, signal: ctrl.signal };
      const blob = o.format === 'mp4' ? await exportMp4(args) : await exportWebm(args);
      download(blob, `${o.name}.${o.format}`);
      closeModal();
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      this.status(`Exported ${o.name}.${o.format} (${formatBytes(blob.size)}) in ${secs}s`);
      alertDialog('Export complete', `${o.name}.${o.format}\n${formatBytes(blob.size)} · ${o.width}×${o.height} @ ${o.fps}fps · ${secs}s`);
    } catch (e) {
      closeModal();
      if (e && e.name === 'AbortError') this.status('Export cancelled.'); else { console.error(e); alertDialog('Export failed', String(e.message || e)); }
    } finally { this.player.onTick = savedTick; this.player.onStop = savedStop; this.player.stop(false); this.drawFrame(); }
  }
  async exportFrame() { const blob = await exportFrame(this.project, this.compositor, this.player, this.playhead); download(blob, `${this.project.name}_${timecode(this.playhead, this.project.fps).replace(/:/g, '-')}.png`); }

  shortcutsDialog() {
    const rows = [['Space / K', 'Play-pause / stop'], ['J / L', 'Shuttle backward / forward (repeat to speed up)'], ['← / →', 'Step one frame (Shift: 5 frames)'], ['↑ / ↓', 'Previous / next edit point'], ['Home / End', 'Start / end of sequence'],
      ['I / O', 'Mark in / out (Shift: go to in / out)'], ['V / C / H', 'Selection / Razor / Hand tool'], ['S', 'Toggle snapping'], ['Ctrl+K', 'Split at playhead'], ['Q / W', 'Ripple trim start / end to playhead'],
      ['Del / Shift+Del', 'Delete / ripple delete'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Ctrl+C / X / V', 'Copy / cut / paste at playhead'], ['Ctrl+Shift+D', 'Duplicate'], ['Ctrl+D', 'Apply cross dissolve'], ['Ctrl+L', 'Link / unlink'], ['Shift+E', 'Enable / disable clip'],
      ['Ctrl+R', 'Speed / duration'], ['Ctrl+T', 'Add title'], ['M', 'Add marker'], [', / .', 'Insert / overwrite from source monitor'], ['= / - / \\', 'Zoom in / out / fit'], ['Ctrl+I / O / S / N / M', 'Import / open / save / new / export'],
      ['Drag clip + Ctrl', 'Insert instead of overwrite'], ['Drag edge + Ctrl', 'Ripple trim'], ['Ctrl+wheel', 'Zoom timeline']];
    openModal('Keyboard Shortcuts', [el('table', { style: { borderSpacing: '12px 3px' } }, ...rows.map(([k, d]) => el('tr', el('td', el('b', k)), el('td', { class: 'dim' }, d))))]);
  }

  // Demo sequence (?demo): titles and color mattes only, no media needed.
  demo() {
    const p = this.project;
    const v1 = M.videoTracks(p)[0], v2 = M.videoTracks(p)[1];
    const a = M.makeClip({ kind: 'color', name: 'Blue', duration: 4, color: '#1f6feb' });
    const b = M.makeClip({ kind: 'color', name: 'Purple', duration: 4, color: '#9a5cf6', transitionIn: { type: 'Wipe Right', duration: 1 } });
    const t = M.makeClip({ kind: 'title', name: 'Cutroom', duration: 6, text: { ...M.defaultText(), content: 'Cutroom\nA video editor in your browser', size: 110, shadow: 12 } });
    t.keyframes = { opacity: [{ t: 0, v: 0, ease: 'ease' }, { t: 1, v: 100, ease: 'linear' }, { t: 5, v: 100, ease: 'ease' }, { t: 6, v: 0, ease: 'linear' }], scale: [{ t: 0, v: 80, ease: 'ease' }, { t: 6, v: 110, ease: 'linear' }] };
    M.placeClip(p, a, v1.id, 0); M.placeClip(p, b, v1.id, 4); M.placeClip(p, t, v2.id, 1);
    this.changed(); this.timeline.zoomToFit();
  }
}

const app = new App();
window.app = app;
app.init();
