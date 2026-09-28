import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAccounts, useEntries, type EntryFilter } from '../lib/api';
import { ENTRY_KIND_LABEL, type EntryKind } from '../lib/types';
import type { LayoutCtx } from '../components/Layout';
import EntryList from '../components/EntryList';
import { Empty, ErrorText } from '../components/ui';

const PAGE = 50;
const KIND_FILTERS: EntryKind[] = ['income', 'expense', 'card_purchase', 'transfer', 'card_payment',
  'fx_exchange', 'receivable_open', 'receivable_collection', 'debt_open', 'debt_payment',
  'loan_disbursement', 'loan_payment', 'overdraft_draw', 'overdraft_repay', 'opening_balance', 'adjustment'];

export default function Transactions() {
  const { openAdd } = useOutletContext<LayoutCtx>();
  const accounts = useAccounts().data ?? [];
  const [f, setF] = useState<EntryFilter>({ limit: PAGE, kind: '' });
  const set = (patch: Partial<EntryFilter>) => setF((prev) => ({ ...prev, ...patch, limit: PAGE }));
  const { data, error, isFetching } = useEntries(f);
  const rows = data?.rows ?? [];
  const filtered = Boolean(f.from || f.to || f.accountId || f.kind || f.q);

  return (
    <div className="page">
      <header className="page-head">
        <h1>İşlemler</h1>
        <button className="btn btn-primary only-desktop" onClick={() => openAdd()}>+ İşlem ekle</button>
      </header>

      <div className="filters">
        <input type="search" placeholder="Açıklamada ara" value={f.q ?? ''} onChange={(e) => set({ q: e.target.value })} />
        <select value={f.accountId ?? ''} onChange={(e) => set({ accountId: e.target.value || undefined })}>
          <option value="">Tüm hesaplar</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={f.kind ?? ''} onChange={(e) => set({ kind: e.target.value as EntryKind | '' })}>
          <option value="">Tüm türler</option>
          {KIND_FILTERS.map((k) => <option key={k} value={k}>{ENTRY_KIND_LABEL[k]}</option>)}
        </select>
        <input type="date" aria-label="Başlangıç tarihi" value={f.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} />
        <input type="date" aria-label="Bitiş tarihi" value={f.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} />
        <label className="check small">
          <input type="checkbox" checked={!!f.showReversals} onChange={(e) => set({ showReversals: e.target.checked })} />
          İptal kayıtları
        </label>
      </div>

      <ErrorText error={error} />
      {data && rows.length === 0 && (
        <Empty title={filtered ? 'Bu filtrelere uyan işlem yok' : 'Henüz işlem yok'}>
          {filtered
            ? <button className="btn" onClick={() => setF({ limit: PAGE, kind: '' })}>Filtreleri temizle</button>
            : <button className="btn btn-primary" onClick={() => openAdd()}>İlk işlemi ekle</button>}
        </Empty>
      )}

      <div className={`panel panel-flush ${isFetching ? 'is-loading' : ''}`}>
        <EntryList entries={rows} />
      </div>

      {data && rows.length < data.count && (
        <div className="center">
          <button className="btn" disabled={isFetching} onClick={() => setF((p) => ({ ...p, limit: p.limit + PAGE }))}>
            Daha fazla göster ({data.count - rows.length} kaldı)
          </button>
        </div>
      )}
    </div>
  );
}
