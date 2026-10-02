import { useEffect, useRef, useState } from 'react';

/** Sayıyı eski değerinden yenisine yumuşakça sayar (ilk açılışta 0'dan). Hareket azaltma tercihinde animasyon yapmaz. */
export function useCountUp(target: number, enabled: boolean, ms = 700): number {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const live = enabled && !reduce;
  const [v, setV] = useState(live ? 0 : target);
  const from = useRef(live ? 0 : target);
  useEffect(() => {
    if (!live) { from.current = target; setV(target); return; }
    const a = from.current, b = target;
    if (a === b) { setV(b); return; }
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, Math.max(0, (performance.now() - start) / ms));   // tek saat kaynağı; 0–1 arasına sınırlı
      const cur = a + (b - a) * (1 - Math.pow(1 - p, 3));      // easeOutCubic
      from.current = cur; setV(cur);
      if (p < 1) raf = requestAnimationFrame(tick); else { from.current = b; setV(b); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, live, ms]);
  return live ? v : target;
}
