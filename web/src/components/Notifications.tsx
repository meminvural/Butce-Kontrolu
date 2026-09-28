import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Modal, Money } from './ui';

export default function NotificationsBell({ compact }: { compact?: boolean }) {
  const { data } = useNotifications();
  const [open, setOpen] = useState(false);
  const list = data ?? [];
  const crit = list.filter((n) => n.level === 'critical').length;
  const warn = list.filter((n) => n.level === 'warning').length;
  const badge = crit + warn;

  return (
    <>
      <button className={`bell ${compact ? 'bell-compact' : ''}`} onClick={() => setOpen(true)}
        aria-label={`Bildirimler${badge ? `, ${badge} önemli` : ''}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>
        {!compact && <span>Bildirimler</span>}
        {badge > 0 && <span className={`badge ${crit ? 'badge-crit' : 'badge-warn'}`}>{badge}</span>}
      </button>
      {open && (
        <Modal title="Bildirimler" onClose={() => setOpen(false)}>
          {list.length === 0 ? <p className="muted">Önümüzdeki 7 gün için bekleyen bir şey yok.</p> : (
            <ul className="notice-list">
              {list.map((n, i) => (
                <li key={i} className={`notice notice-${n.level}`}>
                  <span className="notice-title">{n.title}</span>
                  <span className="notice-meta small">
                    {n.due_date && fmtDate(n.due_date)}
                    {n.amount !== null && n.currency && <Money value={n.amount} currency={n.currency} />}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="actions">
            <Link className="btn" to="/planli" onClick={() => setOpen(false)}>Planlı işlemlere git</Link>
          </div>
        </Modal>
      )}
    </>
  );
}
