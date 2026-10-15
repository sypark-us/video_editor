// Modal dialogs and context menus.
import { el } from './util.js';

const modal = () => document.getElementById('modal');
const box = () => document.getElementById('modalBox');
let onKey = null;

export function closeModal() { modal().classList.add('hidden'); box().innerHTML = ''; if (onKey) { document.removeEventListener('keydown', onKey, true); onKey = null; } }

// Generic modal: title, body nodes, buttons [{label, primary, onClick(close)}]
export function openModal(title, body, buttons = [{ label: 'Close' }], { escape = true } = {}) {
  closeModal();
  const b = box();
  b.append(el('h3', title), el('.body', body));
  const foot = el('.foot');
  for (const btn of buttons) {
    foot.append(el('button', { class: btn.primary ? 'primary' : '', onclick: () => { if (btn.onClick) { const r = btn.onClick(closeModal); if (r === false) return; } if (!btn.keepOpen) closeModal(); } }, btn.label));
  }
  b.append(foot);
  modal().classList.remove('hidden');
  onKey = (e) => {
    if (e.key === 'Escape' && escape) { e.stopPropagation(); closeModal(); }
    else if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) { const prim = buttons.find((x) => x.primary); if (prim) { e.stopPropagation(); e.preventDefault(); const r = prim.onClick ? prim.onClick(closeModal) : undefined; if (r !== false && !prim.keepOpen) closeModal(); } }
    else e.stopPropagation(); // keep editor shortcuts out of dialogs
  };
  document.addEventListener('keydown', onKey, true);
  const first = b.querySelector('input, select, textarea'); if (first) setTimeout(() => first.focus(), 0);
  return b;
}
export const isModalOpen = () => !modal().classList.contains('hidden');

export function promptDialog(title, label, value = '', { type = 'text' } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type, value });
    openModal(title, [el('.row', el('label', label), input)], [
      { label: 'Cancel', onClick: () => resolve(null) },
      { label: 'OK', primary: true, onClick: () => resolve(input.value) },
    ]);
    input.select();
  });
}
export function confirmDialog(title, message) {
  return new Promise((resolve) => {
    openModal(title, [el('p', message)], [{ label: 'Cancel', onClick: () => resolve(false) }, { label: 'OK', primary: true, onClick: () => resolve(true) }]);
  });
}
export function alertDialog(title, message) { openModal(title, [el('p', { style: { whiteSpace: 'pre-wrap' } }, message)], [{ label: 'OK', primary: true }]); }

// Context menu: items [{label, key, onClick, disabled, sep}]
const ctx = () => document.getElementById('ctxmenu');
export function showContextMenu(items, x, y) {
  const m = ctx(); m.innerHTML = '';
  for (const it of items) {
    if (it.sep) { m.append(el('.sep')); continue; }
    m.append(el('.item' + (it.disabled ? '.disabled' : ''), { onclick: () => { hideContextMenu(); it.onClick && it.onClick(); } }, it.label, it.key ? el('span.key', it.key) : null));
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, { capture: true, once: true }), 0);
}
function onDocDown(e) { if (!ctx().contains(e.target)) hideContextMenu(); else document.addEventListener('pointerdown', onDocDown, { capture: true, once: true }); }
export function hideContextMenu() { ctx().classList.add('hidden'); }
