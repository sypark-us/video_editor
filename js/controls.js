// Effect Controls panel: motion/opacity keyframes, applied effects, audio, title and transition settings.
import { el, timecode, clamp } from './util.js';
import { EFFECTS, TRANSITIONS, clipById, isAnimated, getProp, setKeyframe, removeKeyframe, clearKeyframes, maxDuration, clipEnd, mediaById, clipsOnTrack } from './model.js';

const FONTS = ['Inter, Arial, sans-serif', 'Arial, Helvetica, sans-serif', 'Georgia, serif', '"Times New Roman", serif', '"Courier New", monospace', 'Impact, sans-serif', '"Comic Sans MS", cursive', 'Verdana, sans-serif', '"Trebuchet MS", sans-serif', '"Segoe UI", sans-serif'];

export class EffectControls {
  constructor(app) { this.app = app; this.root = document.getElementById('effectControls'); this.collapsed = new Set(); this.pending = null; }
  get p() { return this.app.project; }
  get clip() { const id = [...this.app.selection][0]; return id ? clipById(this.p, id) : null; }
  localTime(c) { return clamp(this.app.playhead - c.start, 0, c.duration); }

  render() {
    const c = this.clip; const r = this.root; r.innerHTML = '';
    if (!c) { r.append(el('.empty', 'Select a clip to edit its motion, opacity, effects and audio.')); return; }
    const app = this.app;
    const name = el('input', { type: 'text', value: c.name, onchange: () => app.edit('Rename', () => { c.name = name.value; }) });
    const en = el('input', { type: 'checkbox', checked: c.enabled !== false, title: 'Enable clip', onchange: () => app.edit('Toggle clip', () => { c.enabled = en.checked; }) });
    r.append(el('.ecTitle', en, name, el('span.dim', c.kind)));
    const nsel = this.app.selection.size; if (nsel > 1) r.append(el('p.hint', { style: { padding: '0 8px' } }, `${nsel} clips selected; editing the first. Effects added here apply to all selected clips.`));

    if (c.kind !== 'audio') {
      const motion = this.section('Motion', 'motion');
      motion.body.append(
        this.kfRow(c, 'Position X', 'x', -4000, 4000, 1, 'px'),
        this.kfRow(c, 'Position Y', 'y', -4000, 4000, 1, 'px'),
        this.kfRow(c, 'Scale', 'scale', 0, 400, 0.5, '%'),
        this.kfRow(c, 'Rotation', 'rotation', -360, 360, 0.5, '°'),
        el('.prop', el('span'), el('label'), el('.val', el('button', { onclick: () => app.edit('Reset motion', () => { Object.assign(c.transform, { x: 0, y: 0, scale: 100, rotation: 0 }); for (const k of ['x', 'y', 'scale', 'rotation']) clearKeyframes(c, k); }) }, 'Reset'),
          el('button', { title: 'Scale to fill the frame', onclick: () => this.fitFill(c) }, 'Fill frame'))),
      );
      const op = this.section('Opacity', 'opacity');
      op.body.append(this.kfRow(c, 'Opacity', 'opacity', 0, 100, 1, '%'));
      r.append(motion.el, op.el);
    }
    // Speed / duration
    const tm = this.section('Time', 'time');
    const spd = el('input', { type: 'number', min: 1, max: 1600, step: 1, value: Math.round(c.speed * 100) });
    spd.addEventListener('change', () => app.setSpeed(c, clamp(spd.value / 100, 0.01, 16)));
    tm.body.append(el('.prop', el('span'), el('label', 'Speed'), el('.val', spd, el('span.dim', '%'))),
      el('.prop', el('span'), el('label', 'Duration'), el('.val', el('span.tc', timecode(c.duration, this.p.fps)))),
      el('.prop', el('span'), el('label', 'In / Out'), el('.val', el('span.dim', `${timecode(c.start, this.p.fps)} – ${timecode(clipEnd(c), this.p.fps)}`))));
    if (c.kind === 'video' && c.mediaId) tm.body.append(el('.prop', el('span'), el('label', 'Source in'), el('.val', el('span.dim', timecode(c.inPoint, this.p.fps)))));
    r.append(tm.el);

    if (c.kind === 'title') r.append(this.titleSection(c));
    if (c.kind === 'color') {
      const s = this.section('Color Matte', 'color');
      s.body.append(this.colorRow('Color', () => c.color, (v) => { c.color = v; }, 'Color'));
      r.append(s.el);
    }
    if (c.kind === 'audio') {
      const a = this.section('Audio', 'audio');
      a.body.append(this.kfRow(c, 'Volume', 'volume', 0, 2, 0.01, '', (v) => Math.round(v * 100) + '%'),
        this.numRow('Fade in', () => c.fadeIn, (v) => { c.fadeIn = clamp(v, 0, c.duration); }, 0, 30, 0.1, 's', 'Fade in'),
        this.numRow('Fade out', () => c.fadeOut, (v) => { c.fadeOut = clamp(v, 0, c.duration); }, 0, 30, 0.1, 's', 'Fade out'),
        this.checkRow('Mute', () => c.muted, (v) => { c.muted = v; }, 'Mute clip'));
      r.append(a.el);
    }

    if (c.kind !== 'audio') {
      // Effects
      const fxs = this.section('Effects', 'effects');
      (c.effects || []).forEach((e, i) => {
        const s = this.section(e.type, 'fx:' + e.id, { removable: true, enabled: e.enabled !== false, onRemove: () => app.edit('Remove effect', () => { c.effects.splice(i, 1); }), onToggle: (v) => app.edit('Toggle effect', () => { e.enabled = v; }) });
        const def = EFFECTS[e.type]; if (def) for (const [k, spec] of Object.entries(def.params)) {
          if (typeof spec[0] === 'string') s.body.append(this.colorRow(k, () => e.params[k], (v) => { e.params[k] = v; }, 'Effect param'));
          else if (spec[1] === 0 && spec[2] === 1 && Number.isInteger(spec[0])) s.body.append(this.checkRow(k, () => !!e.params[k], (v) => { e.params[k] = v ? 1 : 0; }, 'Effect param'));
          else s.body.append(this.numRow(k, () => e.params[k], (v) => { e.params[k] = v; }, spec[1], spec[2], (spec[2] - spec[1]) > 10 ? 1 : 0.1, '', 'Effect param'));
        }
        fxs.body.append(s.el);
      });
      const sel = el('select', el('option', { value: '' }, 'Add effect…'), ...Object.keys(EFFECTS).map((n) => el('option', { value: n }, n)));
      sel.addEventListener('change', () => { if (sel.value) app.applyEffect(sel.value, [...app.selection]); sel.value = ''; });
      fxs.body.append(el('.addFx', sel));
      r.append(fxs.el);
      // Transitions
      const tr = this.section('Transitions', 'transitions');
      tr.body.append(this.transRow(c, 'In', 'transitionIn'), this.transRow(c, 'Out', 'transitionOut'));
      r.append(tr.el);
    }
  }

  section(title, key, o = {}) {
    const s = el('.ecSection' + (this.collapsed.has(key) ? '.collapsed' : ''));
    const head = el('.ecHead', el('span', this.collapsed.has(key) ? '▸' : '▾'), el('span', title));
    head.addEventListener('click', () => { if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key); s.classList.toggle('collapsed'); head.firstChild.textContent = s.classList.contains('collapsed') ? '▸' : '▾'; });
    if (o.removable) {
      const t = el('input.toggle', { type: 'checkbox', checked: o.enabled, title: 'Enable effect', onclick: (e) => e.stopPropagation(), onchange: () => o.onToggle(t.checked) });
      head.append(t, el('button.x', { title: 'Remove effect', onclick: (e) => { e.stopPropagation(); o.onRemove(); } }, '✕'));
    }
    const body = el('.ecBody');
    s.append(head, body);
    return { el: s, body };
  }

  // Generic numeric row with slider + number; `get/set` operate on the model; commits through history.
  numRow(label, get, set, min, max, step, unit, hist, fmt) {
    const app = this.app;
    const slider = el('input', { type: 'range', min, max, step, value: get() });
    const num = el('input', { type: 'number', min, max, step, value: round(get()) });
    let editing = false;
    const apply = (v, final) => {
      v = clamp(parseFloat(v), min, max); if (isNaN(v)) return;
      if (!editing) { app.history.push(this.p, hist); editing = true; }
      set(v); slider.value = v; num.value = round(v);
      if (final) { editing = false; app.changed({ keepControls: true }); } else app.drawFrame();
    };
    slider.addEventListener('input', () => apply(slider.value, false));
    slider.addEventListener('change', () => apply(slider.value, true));
    num.addEventListener('change', () => apply(num.value, true));
    return el('.prop', el('span'), el('label', { title: label }, label), el('.val', slider), el('.val', num, el('span.dim', unit)));
  }
  colorRow(label, get, set, hist) {
    const app = this.app;
    const inp = el('input', { type: 'color', value: get() });
    let editing = false;
    inp.addEventListener('input', () => { if (!editing) { app.history.push(this.p, hist); editing = true; } set(inp.value); app.drawFrame(); });
    inp.addEventListener('change', () => { editing = false; set(inp.value); app.changed({ keepControls: true }); });
    return el('.prop', el('span'), el('label', label), el('.val', inp));
  }
  checkRow(label, get, set, hist) {
    const app = this.app;
    const inp = el('input', { type: 'checkbox', checked: get() });
    inp.addEventListener('change', () => app.edit(hist, () => set(inp.checked)));
    return el('.prop', el('span'), el('label', label), el('.val', inp));
  }
  selectRow(label, options, get, set, hist) {
    const app = this.app;
    const s = el('select', ...options.map((o) => el('option', { value: Array.isArray(o) ? o[0] : o, selected: (Array.isArray(o) ? o[0] : o) === get() }, Array.isArray(o) ? o[1] : o)));
    s.addEventListener('change', () => app.edit(hist, () => set(s.value)));
    return el('.prop', el('span'), el('label', label), el('.val', s));
  }

  // Keyframe-able property row: stopwatch toggles animation; diamond adds/removes a keyframe at the playhead.
  kfRow(c, label, prop, min, max, step, unit, fmt) {
    const app = this.app;
    const lt = this.localTime(c);
    const animated = isAnimated(c, prop);
    const cur = getProp(c, prop, lt);
    const kfs = c.keyframes?.[prop] || [];
    const atKf = kfs.find((k) => Math.abs(k.t - lt) < 1e-4);
    const stop = el('button.kf' + (animated ? '.on' : ''), { title: animated ? 'Stop animating (removes keyframes)' : 'Animate with keyframes' }, '⏱');
    stop.addEventListener('click', () => app.edit('Toggle animation', () => { if (animated) { const v = getProp(c, prop, lt); clearKeyframes(c, prop); if (prop === 'volume') c.volume = v; else c.transform[prop] = v; } else setKeyframe(c, prop, lt, cur); }));
    const slider = el('input', { type: 'range', min, max, step, value: cur });
    const num = el('input', { type: 'number', min, max, step, value: round(cur) });
    let editing = false;
    const apply = (v, final) => {
      v = clamp(parseFloat(v), min, max); if (isNaN(v)) return;
      if (!editing) { app.history.push(this.p, 'Change ' + label); editing = true; }
      if (isAnimated(c, prop)) setKeyframe(c, prop, lt, v); else if (prop === 'volume') c.volume = v; else c.transform[prop] = v;
      slider.value = v; num.value = round(v);
      if (final) { editing = false; app.changed({ keepControls: true }); } else app.drawFrame();
    };
    slider.addEventListener('input', () => apply(slider.value, false));
    slider.addEventListener('change', () => apply(slider.value, true));
    num.addEventListener('change', () => apply(num.value, true));
    const nav = el('.kfnav');
    if (animated) {
      const prev = kfs.filter((k) => k.t < lt - 1e-4).pop(), next = kfs.find((k) => k.t > lt + 1e-4);
      nav.append(
        el('button', { title: 'Previous keyframe', disabled: !prev, onclick: () => prev && app.setPlayhead(c.start + prev.t) }, '◀'),
        el('button' + (atKf ? '.on' : ''), { title: atKf ? 'Remove keyframe' : 'Add keyframe', onclick: () => app.edit('Keyframe', () => { if (atKf) removeKeyframe(c, prop, lt); else setKeyframe(c, prop, lt, cur); }) }, '◆'),
        el('button', { title: 'Next keyframe', disabled: !next, onclick: () => next && app.setPlayhead(c.start + next.t) }, '▶'));
      if (atKf) {
        const ease = el('select', { title: 'Interpolation from this keyframe' }, ...[['linear', 'Linear'], ['ease', 'Ease'], ['hold', 'Hold']].map(([v, l]) => el('option', { value: v, selected: (atKf.ease || 'linear') === v }, l)));
        ease.addEventListener('change', () => app.edit('Keyframe ease', () => { atKf.ease = ease.value; }));
        nav.append(ease);
      }
    }
    return el('.prop', stop, el('label', { title: label }, label), el('.val', slider), el('.val', num, el('span.dim', unit), nav));
  }

  transRow(c, label, key) {
    const app = this.app;
    const cur = c[key];
    const sel = el('select', el('option', { value: '' }, 'None'), ...TRANSITIONS.map((t) => el('option', { value: t, selected: cur && cur.type === t }, t)));
    const dur = el('input', { type: 'number', min: 0.1, max: 10, step: 0.1, value: cur ? cur.duration : 1, disabled: !cur });
    const upd = () => app.edit('Transition', () => { c[key] = sel.value ? { type: sel.value, duration: clamp(parseFloat(dur.value) || 1, 0.1, Math.max(0.1, c.duration)) } : null; });
    sel.addEventListener('change', upd); dur.addEventListener('change', upd);
    return el('.prop', el('span'), el('label', label), el('.val', sel), el('.val', dur, el('span.dim', 's')));
  }

  titleSection(c) {
    const app = this.app; const t = c.text;
    const s = this.section('Text', 'text');
    const ta = el('textarea', { value: t.content, spellcheck: false });
    let editing = false;
    ta.addEventListener('input', () => { if (!editing) { app.history.push(this.p, 'Edit text'); editing = true; } t.content = ta.value; c.name = (ta.value.split('\n')[0] || 'Title').slice(0, 40); app.drawFrame(); });
    ta.addEventListener('change', () => { editing = false; app.changed({ keepControls: true }); });
    s.body.append(el('.prop.wide', el('span'), ta));
    s.body.append(this.selectRow('Font', FONTS.map((f) => [f, f.split(',')[0].replace(/"/g, '')]), () => t.font, (v) => { t.font = v; }, 'Font'));
    s.body.append(this.numRow('Size', () => t.size, (v) => { t.size = v; }, 8, 400, 1, 'px', 'Font size'));
    s.body.append(this.colorRow('Color', () => t.color, (v) => { t.color = v; }, 'Text color'));
    s.body.append(this.checkRow('Bold', () => t.bold, (v) => { t.bold = v; }, 'Bold'), this.checkRow('Italic', () => t.italic, (v) => { t.italic = v; }, 'Italic'));
    s.body.append(this.selectRow('Align', ['left', 'center', 'right'], () => t.align, (v) => { t.align = v; }, 'Align'));
    s.body.append(this.numRow('Line height', () => t.lineHeight, (v) => { t.lineHeight = v; }, 0.6, 3, 0.05, '', 'Line height'));
    s.body.append(this.colorRow('Background', () => t.background, (v) => { t.background = v; }, 'Background'));
    s.body.append(this.numRow('Bg opacity', () => t.backgroundOpacity, (v) => { t.backgroundOpacity = v; }, 0, 100, 1, '%', 'Background opacity'));
    s.body.append(this.numRow('Outline', () => t.outline, (v) => { t.outline = v; }, 0, 30, 0.5, 'px', 'Outline'));
    s.body.append(this.colorRow('Outline color', () => t.outlineColor, (v) => { t.outlineColor = v; }, 'Outline color'));
    s.body.append(this.numRow('Shadow', () => t.shadow, (v) => { t.shadow = v; }, 0, 60, 1, 'px', 'Shadow'));
    return s.el;
  }

  fitFill(c) {
    const app = this.app; const p = this.p;
    const s = app.player.getSource(c, c.inPoint); if (!s) return;
    const contain = Math.min(p.width / s.w, p.height / s.h), cover = Math.max(p.width / s.w, p.height / s.h);
    app.edit('Fill frame', () => { c.transform.scale = Math.round((cover / contain) * 1000) / 10; clearKeyframes(c, 'scale'); });
  }
}
const round = (v) => Math.round(v * 100) / 100;
