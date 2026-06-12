import { useEffect, useState, type RefObject } from 'react';

export interface DropdownPos {
  top: number;
  left: number;
  width: number;
}

const MARGIN = 8;

/**
 * Viewport-clamped position for a `position: fixed` dropdown anchored to an
 * input/button. Re-measures on any scroll (capture phase catches scrollable
 * modal bodies), window resize, and visual-viewport changes — without this,
 * the mobile keyboard scrolling the anchor into view leaves the dropdown
 * floating at its stale open-time coordinates.
 */
export function useDropdownPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  desiredWidth: number,
): DropdownPos | null {
  const [pos, setPos] = useState<DropdownPos | null>(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const width = Math.min(desiredWidth, vw - MARGIN * 2);
      const left = Math.min(Math.max(rect.left, MARGIN), vw - width - MARGIN);
      setPos({ top: rect.bottom + 4, left, width });
    };
    update();
    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
    };
  }, [open, desiredWidth, anchorRef]);

  return pos;
}
