import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { isConfigured } from './lib/supabase';
import Layout from './components/Layout';
import Login from './pages/Login';

// Seyrek kullanılan sayfalar ayrı paketlerde: ilk açılış hızlı kalır
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Transactions = lazy(() => import('./pages/Transactions'));
const Accounts = lazy(() => import('./pages/Accounts'));
const Categories = lazy(() => import('./pages/Categories'));
const Cards = lazy(() => import('./pages/Cards'));
const Loans = lazy(() => import('./pages/Loans'));
const Planned = lazy(() => import('./pages/Planned'));
const Calendar = lazy(() => import('./pages/Calendar'));
const Budget = lazy(() => import('./pages/Budget'));
const CashFlow = lazy(() => import('./pages/CashFlow'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));

export default function App() {
  const { session, loading } = useAuth();

  if (!isConfigured) {
    return (
      <div className="login"><div className="login-card">
        <h1>Kurulum eksik</h1>
        <p><code>web/.env.local</code> dosyasına <code>VITE_SUPABASE_URL</code> ve <code>VITE_SUPABASE_ANON_KEY</code> değerlerini girin, sonra uygulamayı yeniden başlatın.</p>
      </div></div>
    );
  }
  if (loading) return <div className="boot" aria-busy="true" />;
  if (!session) return <Login />;

  const page = (el: JSX.Element) => <Suspense fallback={<div className="page" aria-busy="true" />}>{el}</Suspense>;
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={page(<Dashboard />)} />
          <Route path="islemler" element={page(<Transactions />)} />
          <Route path="hesaplar" element={page(<Accounts />)} />
          <Route path="kategoriler" element={page(<Categories />)} />
          <Route path="kartlar" element={page(<Cards />)} />
          <Route path="krediler" element={page(<Loans />)} />
          <Route path="planli" element={page(<Planned />)} />
          <Route path="takvim" element={page(<Calendar />)} />
          <Route path="butce" element={page(<Budget />)} />
          <Route path="nakit-akisi" element={page(<CashFlow />)} />
          <Route path="raporlar" element={page(<Reports />)} />
          <Route path="ayarlar" element={page(<Settings />)} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
