import { useCountUp } from '../lib/useCountUp';
import { useEffect, useRef, type ReactNode } from 'react';
import { money } from '../lib/format';

export function Money({ value, currency, signed, tone, className = '', animate }: {
  value: number | null | undefined; currency: string; signed?: boolean;
  tone?: 'in' | 'out' | 'auto' | 'muted'; className?: string; animate?: boolean;
}) {
  const v = Number(value ?? 0);
  const shown = useCountUp(v, !!animate);                       // KPI'larda sayı yukarı sayarak gelir
  const t = tone === 'auto' ? (v > 0 ? 'in' : v < 0 ? 'out' : 'muted') : tone;
  return <span className={`money ${t ? 'tone-' + t : ''} ${className}`}>{money(shown, currency, signed)}</span>;
}

export function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="modal-body">
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Kapat">✕</button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export const ErrorText = ({ error }: { error: unknown }) =>
  error ? <p className="error" role="alert">{error instanceof Error ? error.message : String(error)}</p> : null;

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

/** Limit kullanım çubuğu: %70 dikkat, %90 kritik (dokümandaki eşikler) */
export function UsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  const level = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
  return (
    <div className={`usage usage-${level}`} role="meter" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.round(pct)} aria-label="Limit kullanımı">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
