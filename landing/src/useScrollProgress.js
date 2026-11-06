import { useEffect, useState } from 'react';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * 0..1 progress of an element through the viewport, driven by scroll.
 * `start` / `span` are fractions of the viewport height: progress is 0 when the element's top
 * is at `start * vh` and 1 once it has moved `span * vh` further up (plus `heightWeight` of its height).
 */
export function useScrollProgress(ref, { start = 0.92, span = 0.5, heightWeight = 0 } = {}) {
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect(), vh = innerHeight;
      setP(clamp((vh * start - r.top) / (vh * span + r.height * heightWeight), 0, 1));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    return () => { removeEventListener('scroll', onScroll); removeEventListener('resize', onScroll); cancelAnimationFrame(raf); };
  }, [ref, start, span, heightWeight]);
  return p;
}
