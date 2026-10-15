// Compositor: draws one timeline frame into a 2D canvas context.
import { clipAt, transitionAt, localTime, getProp, videoTracks, mediaById, clipEnd } from './model.js';
import { hexToRgb, clamp } from './util.js';

const makeCanvas = (w, h) => {
  const c = typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  c.width = w; c.height = h; return c;
};

export class Compositor {
  constructor() { this.pool = []; this.titleCache = new Map(); this.checker = null; }
  scratch(i, w, h) {
    let c = this.pool[i];
    if (!c) c = this.pool[i] = makeCanvas(w, h);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }

  /**
   * @param ctx 2D context sized to project.width x project.height (or scaled: we use ctx transform)
   * @param getSource (clip, mediaTime) => {el, w, h} | null  (video/img element)
   */
  render(ctx, p, t, getSource, opts = {}) {
    const W = p.width, H = p.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = opts.transparent ? 'rgba(0,0,0,0)' : '#000';
    if (opts.transparent) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); else ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (ctx.canvas.width !== W || ctx.canvas.height !== H) ctx.scale(ctx.canvas.width / W, ctx.canvas.height / H);
    for (const track of videoTracks(p)) {
      if (track.hidden) continue;
      const tr = transitionAt(p, track.id, t);
      if (tr) this.drawTransition(ctx, p, t, tr, getSource);
      else {
        const c = clipAt(p, track.id, t);
        if (c && c.enabled !== false) this.drawClip(ctx, p, c, t, getSource);
      }
    }
    ctx.restore();
  }

  // Render a single clip into a full-frame scratch canvas (used for transitions).
  renderClipToLayer(idx, p, c, t, getSource) {
    const L = this.scratch(idx, p.width, p.height);
    const lctx = L.getContext('2d');
    lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.globalAlpha = 1; lctx.filter = 'none'; lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, L.width, L.height);
    if (c && c.enabled !== false) this.drawClip(lctx, p, c, t, getSource);
    return L;
  }

  drawTransition(ctx, p, t, tr, getSource) {
    const W = p.width, H = p.height, q = tr.progress;
    const A = this.renderClipToLayer(0, p, tr.a, t, getSource);
    const B = this.renderClipToLayer(1, p, tr.b, t, getSource);
    const type = tr.type;
    ctx.save();
    switch (type) {
      case 'Dip to Black': case 'Dip to White': {
        const col = type === 'Dip to Black' ? '0,0,0' : '255,255,255';
        if (q < 0.5) { ctx.drawImage(A, 0, 0); ctx.fillStyle = `rgba(${col},${q * 2})`; }
        else { ctx.drawImage(B, 0, 0); ctx.fillStyle = `rgba(${col},${(1 - q) * 2})`; }
        ctx.fillRect(0, 0, W, H); break;
      }
      case 'Wipe Left': case 'Wipe Right': case 'Wipe Up': case 'Wipe Down': {
        ctx.drawImage(A, 0, 0);
        ctx.beginPath();
        if (type === 'Wipe Right') ctx.rect(0, 0, W * q, H);
        else if (type === 'Wipe Left') ctx.rect(W * (1 - q), 0, W * q, H);
        else if (type === 'Wipe Down') ctx.rect(0, 0, W, H * q);
        else ctx.rect(0, H * (1 - q), W, H * q);
        ctx.clip(); ctx.drawImage(B, 0, 0); break;
      }
      case 'Push Left': ctx.drawImage(A, -W * q, 0); ctx.drawImage(B, W * (1 - q), 0); break;
      case 'Push Right': ctx.drawImage(A, W * q, 0); ctx.drawImage(B, -W * (1 - q), 0); break;
      case 'Iris': {
        ctx.drawImage(A, 0, 0);
        ctx.beginPath(); ctx.arc(W / 2, H / 2, q * Math.hypot(W, H) / 2, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(B, 0, 0); break;
      }
      case 'Zoom': {
        const s = 1 + q * 0.5;
        ctx.globalAlpha = 1; ctx.drawImage(A, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s);
        ctx.globalAlpha = q; const s2 = 1.5 - q * 0.5; ctx.drawImage(B, (W - W * s2) / 2, (H - H * s2) / 2, W * s2, H * s2);
        break;
      }
      default: // Cross Dissolve
        ctx.drawImage(A, 0, 0); ctx.globalAlpha = q; ctx.drawImage(B, 0, 0);
    }
    ctx.restore();
  }

  drawClip(ctx, p, c, t, getSource) {
    const W = p.width, H = p.height;
    const lt = t - c.start; // clip-local timeline seconds (keyframe time)
    const opacity = clamp(getProp(c, 'opacity', lt), 0, 100) / 100;
    if (opacity <= 0) return;
    const x = getProp(c, 'x', lt), y = getProp(c, 'y', lt), scale = getProp(c, 'scale', lt) / 100, rot = getProp(c, 'rotation', lt);

    let src = null, sw = 0, sh = 0, baseScale = 1;
    if (c.kind === 'color') { src = this.colorLayer(W, H, c.color); sw = W; sh = H; }
    else if (c.kind === 'title') { src = this.titleLayer(W, H, c.text); sw = W; sh = H; }
    else {
      const s = getSource(c, localTime(c, t));
      if (!s || !s.el || !s.w || !s.h) return;
      src = s.el; sw = s.w; sh = s.h;
      baseScale = Math.min(W / sw, H / sh);
    }

    // Effects: CSS filters plus special pixel/geometry ops.
    const fx = (c.effects || []).filter((e) => e.enabled !== false);
    let filter = '';
    let crop = null, flipH = false, flipV = false, chroma = null, vignette = null, shadow = null, tint = null, pixelate = null;
    for (const e of fx) {
      const q = e.params;
      switch (e.type) {
        case 'Brightness & Contrast': filter += ` brightness(${1 + q.brightness / 100}) contrast(${1 + q.contrast / 100})`; break;
        case 'Saturation': filter += ` saturate(${q.amount / 100})`; break;
        case 'Hue Shift': filter += ` hue-rotate(${q.degrees}deg)`; break;
        case 'Gaussian Blur': if (q.radius > 0) filter += ` blur(${q.radius * baseScale}px)`; break;
        case 'Black & White': filter += ` grayscale(${q.amount / 100})`; break;
        case 'Sepia': filter += ` sepia(${q.amount / 100})`; break;
        case 'Invert': filter += ` invert(${q.amount / 100})`; break;
        case 'Crop': crop = q; break;
        case 'Flip': flipH = !!q.horizontal; flipV = !!q.vertical; break;
        case 'Chroma Key': chroma = q; break;
        case 'Vignette': vignette = q; break;
        case 'Drop Shadow': shadow = q; break;
        case 'Tint': tint = q; break;
        case 'Pixelate': pixelate = q; break;
      }
    }

    // Stage the source in a layer canvas when pixel ops are needed.
    let layer = src, lw = sw, lh = sh;
    const needLayer = chroma || tint || pixelate || vignette || (filter && (c.kind === 'title'));
    if (needLayer) {
      const cap = Math.max(1, Math.min(1, 2048 / Math.max(sw, sh)));
      lw = Math.max(1, Math.round(sw * cap)); lh = Math.max(1, Math.round(sh * cap));
      const L = this.scratch(2, lw, lh); const lc = L.getContext('2d');
      lc.setTransform(1, 0, 0, 1, 0, 0); lc.globalAlpha = 1; lc.globalCompositeOperation = 'source-over';
      lc.clearRect(0, 0, lw, lh);
      lc.filter = filter.trim() || 'none';
      lc.imageSmoothingEnabled = true;
      if (pixelate && pixelate.size > 1) {
        const pw = Math.max(1, Math.round(lw / pixelate.size)), ph = Math.max(1, Math.round(lh / pixelate.size));
        const S = this.scratch(3, pw, ph); const sc = S.getContext('2d');
        sc.imageSmoothingEnabled = true; sc.clearRect(0, 0, pw, ph); sc.drawImage(src, 0, 0, pw, ph);
        lc.imageSmoothingEnabled = false; lc.drawImage(S, 0, 0, lw, lh); lc.imageSmoothingEnabled = true;
      } else lc.drawImage(src, 0, 0, lw, lh);
      lc.filter = 'none';
      if (chroma) this.applyChromaKey(lc, lw, lh, chroma);
      if (tint) { const [r, g, b] = hexToRgb(tint.color); lc.globalCompositeOperation = 'source-atop'; lc.fillStyle = `rgba(${r},${g},${b},${tint.amount / 100})`; lc.fillRect(0, 0, lw, lh); lc.globalCompositeOperation = 'source-over'; }
      if (vignette) {
        const g = lc.createRadialGradient(lw / 2, lh / 2, Math.min(lw, lh) * (0.2 + vignette.size / 100 * 0.6), lw / 2, lh / 2, Math.hypot(lw, lh) / 2);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${vignette.amount / 100})`);
        lc.globalCompositeOperation = 'source-atop'; lc.fillStyle = g; lc.fillRect(0, 0, lw, lh); lc.globalCompositeOperation = 'source-over';
      }
      layer = L; filter = '';
    }

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.filter = filter.trim() || 'none';
    ctx.translate(W / 2 + x, H / 2 + y);
    ctx.rotate((rot * Math.PI) / 180);
    const s = baseScale * scale;
    ctx.scale(s * (flipH ? -1 : 1), s * (flipV ? -1 : 1));
    if (shadow) {
      const a = (shadow.angle * Math.PI) / 180;
      ctx.shadowColor = `rgba(0,0,0,${shadow.opacity / 100})`;
      ctx.shadowBlur = shadow.blur * s; ctx.shadowOffsetX = Math.cos(a) * shadow.distance * s; ctx.shadowOffsetY = Math.sin(a) * shadow.distance * s;
    }
    const k = lw / sw; // layer may be downscaled
    let sx = 0, sy = 0, cw = lw, ch = lh;
    if (crop) {
      sx = (lw * crop.left) / 100; sy = (lh * crop.top) / 100;
      cw = Math.max(0, lw - sx - (lw * crop.right) / 100); ch = Math.max(0, lh - sy - (lh * crop.bottom) / 100);
    }
    if (cw > 0 && ch > 0) {
      try { ctx.drawImage(layer, sx, sy, cw, ch, -sw / 2 + sx / k, -sh / 2 + sy / k, cw / k, ch / k); } catch { /* source not ready */ }
    }
    ctx.restore();
  }

  applyChromaKey(lc, w, h, q) {
    let img; try { img = lc.getImageData(0, 0, w, h); } catch { return; }
    const d = img.data; const [kr, kg, kb] = hexToRgb(q.color);
    const sim = (q.similarity / 100) * 255 * 1.2, smooth = (q.smoothness / 100) * 255 * 0.8 + 1;
    // Compare in YCbCr chroma plane for robustness against lighting.
    const kcb = 128 - 0.168736 * kr - 0.331264 * kg + 0.5 * kb, kcr = 128 + 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const dist = Math.hypot(cb - kcb, cr - kcr) * 2.2;
      if (dist < sim) d[i + 3] = 0;
      else if (dist < sim + smooth) d[i + 3] = Math.round(d[i + 3] * ((dist - sim) / smooth));
    }
    lc.putImageData(img, 0, 0);
  }

  colorLayer(W, H, color) {
    const L = this.scratch(4, W, H); const lc = L.getContext('2d');
    lc.setTransform(1, 0, 0, 1, 0, 0); lc.filter = 'none'; lc.globalAlpha = 1; lc.globalCompositeOperation = 'source-over';
    lc.fillStyle = color; lc.fillRect(0, 0, W, H); return L;
  }

  titleLayer(W, H, text) {
    const key = JSON.stringify([W, H, text]);
    const hit = this.titleCache.get(key);
    if (hit) return hit;
    if (this.titleCache.size > 24) this.titleCache.delete(this.titleCache.keys().next().value);
    const L = makeCanvas(W, H); const lc = L.getContext('2d');
    lc.clearRect(0, 0, W, H);
    const size = text.size * (W / 1920);
    const font = `${text.italic ? 'italic ' : ''}${text.bold ? 'bold ' : ''}${size}px ${text.font}`;
    lc.font = font; lc.textBaseline = 'middle';
    // Word-wrap to 90% of frame width.
    const lines = [];
    for (const para of String(text.content || '').split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const test = line ? line + ' ' + word : word;
        if (lc.measureText(test).width > W * 0.9 && line) { lines.push(line); line = word; } else line = test;
      }
      lines.push(line);
    }
    const lh = size * (text.lineHeight || 1.2);
    const totalH = lh * lines.length;
    const align = text.align || 'center';
    lc.textAlign = align;
    const ax = align === 'left' ? W * 0.05 : align === 'right' ? W * 0.95 : W / 2;
    if (text.backgroundOpacity > 0) {
      const maxW = Math.max(...lines.map((l) => lc.measureText(l).width));
      const pad = size * 0.4;
      const bx = align === 'left' ? ax - pad : align === 'right' ? ax - maxW - pad : ax - maxW / 2 - pad;
      const [r, g, b] = hexToRgb(text.background);
      lc.fillStyle = `rgba(${r},${g},${b},${text.backgroundOpacity / 100})`;
      lc.fillRect(bx, H / 2 - totalH / 2 - pad / 2, maxW + pad * 2, totalH + pad);
    }
    lines.forEach((l, i) => {
      const y = H / 2 - totalH / 2 + lh * (i + 0.5);
      if (text.shadow > 0) { lc.shadowColor = 'rgba(0,0,0,0.8)'; lc.shadowBlur = text.shadow * (W / 1920); lc.shadowOffsetX = lc.shadowOffsetY = text.shadow * 0.3 * (W / 1920); }
      if (text.outline > 0) { lc.lineWidth = text.outline * 2 * (W / 1920); lc.strokeStyle = text.outlineColor; lc.lineJoin = 'round'; lc.strokeText(l, ax, y); }
      lc.shadowColor = 'transparent';
      lc.fillStyle = text.color; lc.fillText(l, ax, y);
    });
    this.titleCache.set(key, L);
    return L;
  }

  // Bounding box of a clip's drawn content in sequence pixels (for the program monitor gizmo).
  clipBounds(p, c, t, getSource) {
    const W = p.width, H = p.height, lt = t - c.start;
    let sw = W, sh = H, base = 1;
    if (c.kind === 'video') { const s = getSource(c, localTime(c, t)); if (!s || !s.w) return null; sw = s.w; sh = s.h; base = Math.min(W / sw, H / sh); }
    const s = base * getProp(c, 'scale', lt) / 100;
    return { cx: W / 2 + getProp(c, 'x', lt), cy: H / 2 + getProp(c, 'y', lt), w: sw * s, h: sh * s, rot: getProp(c, 'rotation', lt) };
  }
}
