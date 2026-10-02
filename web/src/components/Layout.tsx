import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { rpc, useFinancialHealth } from '../lib/api';
import QuickAdd, { type QuickAddPreset } from './QuickAdd';
import NotificationsBell from './Notifications';
import { Modal } from './ui';

const NAV: { group: string; items: { to: string; label: string; end?: boolean }[] }[] = [
  { group: 'Günlük', items: [
    { to: '/', label: 'Özet', end: true },
    { to: '/islemler', label: 'İşlemler' },
    { to: '/hesaplar', label: 'Hesaplar' },
    { to: '/aktar', label: 'Excel / toplu giriş' },
  ] },
  { group: 'Borç ve ödemeler', items: [
    { to: '/kartlar', label: 'Kredi kartları' },
    { to: '/borc-plani', label: 'Borç planı ve otomatik ödeme' },
    { to: '/ekstre', label: 'Ekstre yükle' },
    { to: '/krediler', label: 'Krediler' },
    { to: '/planli', label: 'Planlı ve düzenli' },
    { to: '/takvim', label: 'Takvim' },
  ] },
  { group: 'Plan ve analiz', items: [
    { to: '/butce', label: 'Bütçe' },
    { to: '/nakit-akisi', label: 'Nakit akışı' },
    { to: '/raporlar', label: 'Raporlar' },
  ] },
  { group: 'Sistem', items: [
    { to: '/kategoriler', label: 'Kategoriler' },
    { to: '/saglik', label: 'Sistem sağlığı' },
    { to: '/ayarlar', label: 'Ayarlar' },
  ] },
];

export interface LayoutCtx { openAdd: (preset?: QuickAddPreset) => void }

export default function Layout() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const location = useLocation();
  const [adding, setAdding] = useState<QuickAddPreset | null>(null);
  const [menu, setMenu] = useState(false);
  const ctx: LayoutCtx = { openAdd: (p) => setAdding(p ?? {}) };
  // Menüde yalnızca kritik/uyarı sayısı gösterilir (bilgi düzeyi rahatsız etmez)
  const health = useFinancialHealth();
  const badge = (health.data ?? []).filter((c) => c.severity === 'crit' || c.severity === 'warn').length;

  // Düzenli işlemleri önümüzdeki 120 gün için planla (tekrar çalıştırmak güvenli)
  useEffect(() => {
    rpc<number>('materialize_recurring', { p_days: 120 })
      .then((n) => { if (n > 0) qc.invalidateQueries(); })
      .catch(() => undefined);
  }, [qc]);
  // Vadesi gelen "otomatik kaydet" ödemelerini işle (aynı ekstre için ikinci kez kayıt oluşmaz)
  useEffect(() => {
    rpc<{ recorded: number }>('process_autopay', {})
      .then((r) => { if (r && r.recorded > 0) qc.invalidateQueries(); })
      .catch(() => undefined);
  }, [qc]);
  useEffect(() => setMenu(false), [location.pathname]);

  const navList = (
    <nav className="side-nav">
      {NAV.map((g) => (
        <div key={g.group} className="nav-group">
          <span className="nav-group-title">{g.group}</span>
          {g.items.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.label}{n.to === '/saglik' && badge > 0 && <span className="nav-badge" aria-label={`${badge} sorun`}>{badge}</span>}</NavLink>)}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={28} height={28} />
          <span>Bütçe Defteri</span>
        </div>
        <button className="btn btn-primary btn-block" onClick={() => ctx.openAdd()}>+ İşlem ekle</button>
        <NotificationsBell />
        {navList}
        <div className="side-foot">
          <span className="muted small">{session?.user.email}</span>
          <button className="link-btn small" onClick={() => supabase.auth.signOut()}>Çıkış yap</button>
        </div>
      </aside>

      <header className="mobile-top">
        <div className="brand"><img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={24} height={24} /><span>Bütçe Defteri</span></div>
        <NotificationsBell compact />
      </header>

      <main className="main"><Outlet context={ctx} /></main>

      <nav className="bottom-nav" aria-label="Ana menü">
        <NavLink to="/" end>Özet</NavLink>
        <NavLink to="/islemler">İşlemler</NavLink>
        <button className="fab" onClick={() => ctx.openAdd()} aria-label="İşlem ekle">+</button>
        <NavLink to="/hesaplar">Hesaplar</NavLink>
        <button className="bottom-menu-btn" onClick={() => setMenu(true)}>Menü</button>
      </nav>

      {menu && (
        <Modal title="Menü" onClose={() => setMenu(false)}>
          {navList}
          <button className="link-btn small" onClick={() => supabase.auth.signOut()}>Çıkış yap</button>
        </Modal>
      )}
      {adding && <QuickAdd preset={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}
