import { useEffect, useRef } from 'react';

type Node = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
};

const LINK_DIST = 140;
const NODE_COUNT = 48;
const FLASH_MS = 1000;

function makeNodes(w: number, h: number): Node[] {
  return Array.from({ length: NODE_COUNT }, () => {
    const speed = 0.18 + Math.random() * 0.42;
    const angle = Math.random() * Math.PI * 2;
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r: 1.2 + Math.random() * 1.8,
    };
  });
}

export default function TrackerNodeBackdrop({ pulseKey = 0 }: { pulseKey?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pulseUntilRef = useRef(0);

  useEffect(() => {
    if (pulseKey > 0) {
      pulseUntilRef.current = performance.now() + FLASH_MS;
    }
  }, [pulseKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce =
      document.querySelector('.app.reduced-motion') != null ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let nodes: Node[] = [];
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = parent.clientWidth;
      h = parent.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!nodes.length) nodes = makeNodes(w, h);
      else {
        for (const n of nodes) {
          n.x = Math.min(w, Math.max(0, n.x));
          n.y = Math.min(h, Math.max(0, n.y));
        }
      }
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, w, h);

      const flashT = Math.max(0, (pulseUntilRef.current - now) / FLASH_MS);
      const flash = flashT * flashT * (3 - 2 * flashT);

      if (!reduce) {
        for (const n of nodes) {
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < -20) n.x = w + 20;
          if (n.x > w + 20) n.x = -20;
          if (n.y < -20) n.y = h + 20;
          if (n.y > h + 20) n.y = -20;
        }
      }

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist > LINK_DIST) continue;
          const base = 1 - dist / LINK_DIST;
          const alpha = base * base * (0.18 + flash * 0.45);
          const r = Math.round(180 + flash * 70);
          const g = Math.round(140 + flash * 20);
          const bl = Math.round(100 - flash * 40);
          ctx.strokeStyle = `rgba(${r},${g},${bl},${alpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      for (const n of nodes) {
        const nr = Math.round(200 + flash * 55);
        const ng = Math.round(160 + flash * 10);
        const nb = Math.round(120 - flash * 50);
        const alpha = 0.45 + flash * 0.5;
        ctx.fillStyle = `rgba(${nr},${ng},${nb},${alpha})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + flash * 1.2, 0, Math.PI * 2);
        ctx.fill();
        if (flash > 0.05) {
          ctx.fillStyle = `rgba(227,155,68,${flash * 0.22})`;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 4 + flash * 6, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      raf = requestAnimationFrame(draw);
    };

    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="tracker-node-backdrop" aria-hidden="true">
      <canvas ref={canvasRef} className="tracker-node-canvas" />
      <div className="tracker-node-edge-fade" />
    </div>
  );
}
