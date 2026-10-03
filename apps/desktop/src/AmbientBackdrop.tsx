import { useEffect, useRef } from 'react';
import type { PageAmbientId } from './appearance';

export default function AmbientBackdrop({ mode }: { mode: Exclude<PageAmbientId, 'none'> }) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    let pendingX = 50;
    let pendingY = 40;

    const flush = () => {
      frame = 0;
      root.style.setProperty('--mx', `${pendingX}%`);
      root.style.setProperty('--my', `${pendingY}%`);
    };

    const onMove = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      pendingX = ((event.clientX - rect.left) / rect.width) * 100;
      pendingY = ((event.clientY - rect.top) / rect.height) * 100;
      if (!frame) frame = window.requestAnimationFrame(flush);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [mode]);

  return <div ref={rootRef} className={`ambient-backdrop ambient-${mode}`} aria-hidden="true" />;
}
