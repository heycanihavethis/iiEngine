import { useEffect, useMemo, useRef, type CSSProperties } from 'react';

export type PageRevealPhase = 'covering' | 'holding' | 'revealing';

const COLS = 10;
const ROWS = 7;
export const PAGE_REVEAL_COVER_MS = 320;
export const PAGE_REVEAL_REVEAL_MS = 300;

export default function PageRevealGrid({
  phase,
  coverMs = PAGE_REVEAL_COVER_MS,
  revealMs = PAGE_REVEAL_REVEAL_MS,
  onCoverComplete,
  onRevealComplete,
}: {
  phase: PageRevealPhase;
  coverMs?: number;
  revealMs?: number;
  onCoverComplete?: () => void;
  onRevealComplete?: () => void;
}) {
  const coverCb = useRef(onCoverComplete);
  const revealCb = useRef(onRevealComplete);
  coverCb.current = onCoverComplete;
  revealCb.current = onRevealComplete;

  const safeCover = Math.max(160, Math.min(800, coverMs));
  const safeReveal = Math.max(140, Math.min(750, revealMs));

  const cells = useMemo(
    () =>
      Array.from({ length: COLS * ROWS }, (_, index) => {
        const col = index % COLS;
        const row = Math.floor(index / COLS);
        const diagonal = (col + row) / (COLS + ROWS - 2);
        return { index, delay: diagonal * 0.62 };
      }),
    [],
  );

  useEffect(() => {
    if (phase === 'covering') {
      const timer = window.setTimeout(() => coverCb.current?.(), safeCover + 24);
      return () => window.clearTimeout(timer);
    }
    if (phase === 'revealing') {
      const timer = window.setTimeout(() => revealCb.current?.(), safeReveal + 24);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [phase, safeCover, safeReveal]);

  const durationMs = phase === 'covering' ? safeCover : safeReveal;

  return (
    <div className={`page-reveal-grid page-reveal-${phase}`} aria-hidden="true">
      <div
        className="page-reveal-cells"
        style={
          {
            '--reveal-cols': COLS,
            '--reveal-rows': ROWS,
            '--reveal-ms': `${durationMs}ms`,
          } as CSSProperties
        }
      >
        {cells.map((cell) => (
          <span
            key={cell.index}
            className="page-reveal-cell"
            style={{
              animationDelay: phase === 'holding' ? '0ms' : `${cell.delay * durationMs}ms`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function inspectPageEntryHealth(
  root: ParentNode | null,
): 'loading' | 'recoverable' | 'ready' {
  if (!root) return 'loading';

  const statuses = [...root.querySelectorAll('[role="status"]')];
  if (
    statuses.some((node) =>
      /opening\s+.+(…|\.\.\.)|connecting to ii engine|restoring your session|checking discord membership|loading documents/i.test(
        (node.textContent || '').trim(),
      ),
    )
  ) {
    return 'loading';
  }

  const alerts = [
    ...root.querySelectorAll(
      '[role="alert"], .connection-unavailable, .startup-connection-error, .empty.connection-unavailable',
    ),
  ];
  if (
    alerts.some((node) => {
      const text = node.textContent || '';
      return /unauthorized|can.?t connect|couldn.?t reach|try again|recheck|forbidden|discord roles do not|network|temporarily unavailable|503|401|403/i.test(
        text,
      );
    })
  ) {
    return 'recoverable';
  }

  return 'ready';
}
