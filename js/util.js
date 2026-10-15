// Small shared helpers (no DOM dependencies except where noted).
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const EPS = 1e-6;

let counter = 0;
export function uid(prefix = 'id') {
  counter = (counter + 1) % 0xffffff;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function roundToFrame(t, fps) { return Math.round(t * fps) / fps; }

// Seconds -> "HH:MM:SS:FF" (non-drop-frame).
export function timecode(t, fps = 30) {
  if (!isFinite(t)) t = 0;
  const neg = t < 0; t = Math.abs(t);
  const totalFrames = Math.round(t * fps);
  const f = totalFrames % Math.round(fps);
  const s = Math.floor(totalFrames / fps);
  const pad = (n) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}

// "HH:MM:SS:FF", "MM:SS", "SS", "1.5s" -> seconds.
export function parseTimecode(str, fps = 30) {
  const s = String(str).trim();
  if (/^-?\d+(\.\d+)?s?$/.test(s)) return parseFloat(s);
  const parts = s.split(/[:;]/).map(Number);
  if (parts.some(isNaN)) return NaN;
  const [ff, ss = 0, mm = 0, hh = 0] = parts.reverse();
  if (parts.length === 1) return ff;
  if (parts.length === 2) return ss * 60 + ff; // MM:SS
  return hh * 3600 + mm * 60 + ss + ff / fps;
}

export function formatDuration(t) {
  if (!isFinite(t)) return '--:--';
  const s = Math.floor(t);
  const pad = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

export function debounce(fn, ms) {
  let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}

export function deepClone(o) { return typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)); }

// DOM helper: el('div.cls#id', {attr: v, onclick: fn}, child, ...)
export function el(spec, props = {}, ...children) {
  const m = spec.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const node = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) for (const tok of m[2].match(/[.#][\w-]+/g)) tok[0] === '.' ? node.classList.add(tok.slice(1)) : (node.id = tok.slice(1));
  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props) && typeof props !== 'string') {
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'class') node.className = v;
      else if (k in node && k !== 'list') { try { node[k] = v; } catch { node.setAttribute(k, v); } }
      else node.setAttribute(k, v);
    }
  } else children.unshift(props);
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return hex.length >= 7 ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [((n >> 8) & 15) * 17, ((n >> 4) & 15) * 17, (n & 15) * 17];
}
