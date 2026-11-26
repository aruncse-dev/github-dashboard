// Zoom for code views (diffs and file viewer): A−/A+ buttons, pinch on touch screens,
// ctrl/⌘ + wheel (trackpad pinch) on desktop, + / − / 0 keys, line wrapping and full screen.
// One setting for every code view, remembered per browser.
import { storage } from './api';
import { icon, isDialogOpen } from './ui';

const KEY = 'gh_pr_code_view';
const BASE = 12;
const MIN = 8;
const MAX = 24;

interface Settings { size: number; wrap: boolean; full: boolean }

function read(): Settings {
  try {
    const v = JSON.parse(storage.get(KEY) ?? '{}');
    return {
      size: typeof v.size === 'number' ? clamp(v.size) : BASE,
      wrap: v.wrap === true,
      full: v.full === true,
    };
  } catch {
    return { size: BASE, wrap: false, full: false };
  }
}

function clamp(n: number): number {
  return Math.min(MAX, Math.max(MIN, n));
}

const settings = read();
const save = () => storage.set(KEY, JSON.stringify({ ...settings, size: Math.round(settings.size * 2) / 2 }));

const bars: HTMLElement[] = [];
const sheets: string[] = [];

function apply(): void {
  const root = document.documentElement;
  root.style.setProperty('--code-fs', `${settings.size}px`);
  root.toggleAttribute('data-code-wrap', settings.wrap);
  for (const id of sheets) document.querySelector(`${id} .Overlay`)?.classList.toggle('full', settings.full);
  const pct = `${Math.round((settings.size / BASE) * 100)}%`;
  for (const bar of bars) {
    bar.querySelector<HTMLElement>('[data-zoom="reset"]')!.textContent = pct;
    bar.querySelector<HTMLButtonElement>('[data-zoom="out"]')!.disabled = settings.size <= MIN;
    bar.querySelector<HTMLButtonElement>('[data-zoom="in"]')!.disabled = settings.size >= MAX;
    bar.querySelector('[data-zoom="wrap"]')!.setAttribute('aria-pressed', String(settings.wrap));
    bar.querySelector('[data-zoom="full"]')!.setAttribute('aria-pressed', String(settings.full));
  }
}

/** Zooms around the viewport's centre, so what you were reading stays in view. */
function setSize(size: number, scroller?: HTMLElement): void {
  const next = clamp(size);
  if (next === settings.size) return;
  const ratio = scroller && scroller.scrollHeight ? (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight : 0;
  settings.size = next;
  apply();
  if (scroller) scroller.scrollTop = ratio * scroller.scrollHeight - scroller.clientHeight / 2;
}

function step(dir: 1 | -1): number {
  // Small steps at small sizes, bigger ones when large.
  const s = settings.size;
  const inc = s < 12 ? 1 : s < 16 ? 1.5 : 2;
  return dir > 0 ? s + inc : s - inc;
}

const TOOLBAR = `
  <div class="zoom-group" role="group" aria-label="Text size">
    <button class="btn btn-sm" type="button" data-zoom="out" title="Smaller text (−)" aria-label="Smaller text"><span class="aa">A</span>−</button>
    <button class="btn btn-sm zoom-pct" type="button" data-zoom="reset" title="Reset text size (0)" aria-label="Reset text size">100%</button>
    <button class="btn btn-sm" type="button" data-zoom="in" title="Larger text (+)" aria-label="Larger text"><span class="aa">A</span>+</button>
  </div>
  <button class="btn btn-sm" type="button" data-zoom="wrap" aria-pressed="false" title="Wrap long lines (w)">${icon('wrap')}Wrap</button>
  <button class="btn btn-sm btn-icon" type="button" data-zoom="full" aria-pressed="false" title="Full screen (f)" aria-label="Full screen">${icon('fullscreen')}</button>`;

/**
 * Wires one code dialog: `bar` gets the toolbar, `scroller` is the dialog body that scrolls,
 * `sheetId` the dialog (for keyboard shortcuts and full screen).
 */
export function initZoom(sheetId: string, bar: HTMLElement, scroller: HTMLElement): void {
  bar.insertAdjacentHTML('afterbegin', TOOLBAR);
  bars.push(bar);
  sheets.push(sheetId);

  bar.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]')?.dataset.zoom;
    if (act === 'in') setSize(step(1), scroller);
    else if (act === 'out') setSize(step(-1), scroller);
    else if (act === 'reset') setSize(BASE, scroller);
    else if (act === 'wrap') { settings.wrap = !settings.wrap; apply(); }
    else if (act === 'full') { settings.full = !settings.full; apply(); }
    else return;
    save();
  });

  // Pinch with two fingers. The page itself would zoom otherwise (and fixed dialogs with it).
  let pinch: { d0: number; size0: number } | null = null;
  let frame = 0;
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  scroller.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) pinch = { d0: dist(e.touches) || 1, size0: settings.size };
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const size = pinch.size0 * (dist(e.touches) / pinch.d0);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => setSize(size, scroller));
  }, { passive: false });
  const endPinch = (e: TouchEvent) => {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      save();
    }
  };
  scroller.addEventListener('touchend', endPinch);
  scroller.addEventListener('touchcancel', endPinch);

  // Trackpad pinch and ctrl/⌘ + wheel arrive as wheel events with ctrlKey set.
  let wheelSave = 0;
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // A mouse-wheel notch (~100) is one gentle step; trackpad pinches send small deltas and stay smooth.
    const delta = Math.max(-40, Math.min(40, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
    setSize(settings.size * Math.exp(-delta / 200), scroller);
    clearTimeout(wheelSave);
    wheelSave = window.setTimeout(save, 300);
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (!isDialogOpen(sheetId) || e.ctrlKey || e.metaKey || e.altKey) return;
    // Only when this dialog is on top and the user isn't typing.
    const top = [...document.querySelectorAll<HTMLElement>('.Overlay-backdrop:not(.hidden)')]
      .sort((a, b) => +a.style.zIndex - +b.style.zIndex).pop();
    if (top?.id !== sheetId.slice(1)) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable]')) return;
    const act = ({ '+': 'in', '=': 'in', '-': 'out', '_': 'out', '0': 'reset', w: 'wrap', f: 'full' } as Record<string, string>)[e.key];
    if (!act) return;
    e.preventDefault();
    bar.querySelector<HTMLElement>(`[data-zoom="${act}"]`)?.click();
  });

  apply();
}
