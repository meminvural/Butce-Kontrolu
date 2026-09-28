import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { GLOSSARY, type TermKey } from '../lib/glossary';

/**
 * ⓘ bilgi balonu. Tıklayınca (klavye ile Enter/Boşluk) açılır; dışarı tıklama veya Esc ile kapanır.
 * İçerik Sözlük'ten gelir: ne demek, nasıl hesaplanır, nasıl okunur.
 */
export function Info({ k }: { k: TermKey }) {
  const t = GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState<'left' | 'right'>('left');
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setAlign(r.left > window.innerWidth / 2 ? 'right' : 'left');
    }
    setOpen((v) => !v);
  };

  return (
    <span className="info" ref={ref}>
      <button type="button" className="info-btn" aria-label={`${t.title} nedir?`} aria-expanded={open} aria-controls={id} onClick={toggle}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="7.2" y="7" width="1.6" height="4.6" rx=".8" fill="currentColor" /><circle cx="8" cy="4.9" r=".95" fill="currentColor" /></svg>
      </button>
      {open && (
        <span id={id} role="dialog" aria-label={t.title} className={`info-pop info-${align}`}>
          <strong className="info-title">{t.title}</strong>
          <span className="info-row">{t.what}</span>
          {'formula' in t && t.formula && <span className="info-row"><em>Hesaplama</em><code>{t.formula}</code></span>}
          {'read' in t && t.read && <span className="info-row"><em>Nasıl okunur</em>{t.read}</span>}
        </span>
      )}
    </span>
  );
}

/** Etiket + bilgi balonu */
export function Lbl({ k, children }: { k: TermKey; children: ReactNode }) {
  return <span className="lbl">{children}<Info k={k} /></span>;
}
