// Drag handles that change column widths on desktop. Widths are CSS variables
// (--w-<name>) on <html>, remembered per browser in localStorage.
import { useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';

export interface WidthSpec { def: number; min: number; max: number; label: string }

export const WIDTHS = {
  sidebar: { def: 260, min: 180, max: 560, label: 'サイドバーの幅' },
  content: { def: 860, min: 480, max: 1800, label: '本文の幅' },
  rail: { def: 240, min: 160, max: 480, label: '目次の幅' },
  ai: { def: 400, min: 320, max: 900, label: 'AI パネルの幅' },
} satisfies Record<string, WidthSpec>;
export type WidthName = keyof typeof WIDTHS;

const storeKey = (n: WidthName) => `noren:width:${n}`;
const clamp = (n: WidthName, w: number) => Math.round(Math.min(WIDTHS[n].max, Math.max(WIDTHS[n].min, w)));

function readSaved(n: WidthName): number | null {
  try {
    const v = Number(localStorage.getItem(storeKey(n)));
    return Number.isFinite(v) && v > 0 ? clamp(n, v) : null;
  } catch { return null; }
}
function apply(n: WidthName, w: number | null) {
  if (w === null) document.documentElement.style.removeProperty(`--w-${n}`);
  else document.documentElement.style.setProperty(`--w-${n}`, `${w}px`);
  // keep every handle of the same width (e.g. both edges of the centred body) in sync
  window.dispatchEvent(new CustomEvent('noren:width', { detail: { name: n, value: w ?? WIDTHS[n].def } }));
}
function save(n: WidthName, w: number | null) {
  try {
    if (w === null) localStorage.removeItem(storeKey(n));
    else localStorage.setItem(storeKey(n), String(w));
  } catch { /* storage unavailable: the width still applies until reload */ }
}

/** Apply remembered widths before the first render. */
export function initWidths() {
  for (const n of Object.keys(WIDTHS) as WidthName[]) apply(n, readSaved(n));
}

/**
 * A vertical separator. `target` is the element whose width it controls;
 * `edge` is which side of that element the handle sits on. `factor` 2 is for a
 * centred element: both sides move, so the width changes by twice the drag.
 */
export function Resizer({ name, target, edge, factor = 1, className = '' }: { name: WidthName; target: string; edge: 'left' | 'right'; factor?: number; className?: string }) {
  const spec = WIDTHS[name];
  const [value, setValue] = useState<number>(() => readSaved(name) ?? spec.def);
  const sign = (edge === 'right' ? 1 : -1) * factor;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ name: string; value: number }>).detail;
      if (d.name === name) setValue(d.value);
    };
    window.addEventListener('noren:width', on);
    return () => window.removeEventListener('noren:width', on);
  }, [name]);

  const current = () => {
    const el = document.querySelector<HTMLElement>(target);
    return el ? el.getBoundingClientRect().width : value;
  };
  const set = (w: number, persist: boolean) => {
    const v = clamp(name, w);
    apply(name, v);
    setValue(v);
    if (persist) save(name, v);
    return v;
  };
  const reset = () => {
    apply(name, null);
    save(name, null);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = current();
    let last = startW;
    document.body.classList.add('col-resizing');
    const move = (ev: globalThis.PointerEvent) => { last = set(startW + (ev.clientX - startX) * sign, false); };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('col-resizing');
      save(name, last);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      set(current() + (e.key === 'ArrowRight' ? step : -step) * (edge === 'right' ? 1 : -1) * factor, true);
    } else if (e.key === 'Home') { e.preventDefault(); set(spec.min, true); }
    else if (e.key === 'End') { e.preventDefault(); set(spec.max, true); }
    else if (e.key === 'Enter') { e.preventDefault(); reset(); }
  };

  return (
    <div
      className={`col-resizer ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`${spec.label}（ドラッグか矢印キーで変更、ダブルクリックか Enter で元に戻す）`}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      aria-valuenow={value}
      tabIndex={0}
      title={`${spec.label}を変える（ダブルクリックで元に戻す）`}
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  );
}
