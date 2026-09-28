import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { useEntries, useNetBase, useNetPosition } from '../lib/api';
import { categoryTree, delta, slice, type Bucket } from '../lib/analytics';
import { fmtDate, money } from '../lib/format';
import { useDebtContext } from '../lib/useDebtContext';
import { useReportData } from '../lib/useReport';
import { SOURCE_LABEL, type NetPosition } from '../lib/types';
import type { LayoutCtx } from '../components/Layout';
import EntryList from '../components/EntryList';
import { Lbl } from '../components/Info';
import { CategoryPanel, DebtPanel, FinPanel, HeatPanel, OutlookPanel, TopItemsPanel, TrendPanel, WeekdayPanel } from '../components/panels';
import { ChartCard, DeltaChip, DrillModal, Insights, Kpi, PeriodBar, pctText, type Drill } from '../components/ReportUI';
import { Empty, Money, UsageBar } from '../components/ui';

const addDaysISO = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
};

/** Varlık ve borcu aynı terazide gösteren denge çubuğu */
function BalanceBeam({ p }: { p: NetPosition }) {
  const total = p.assets + p.receivables + p.liabilities || 1;
  return (
    <article className="beam">
      <header className="beam-head">
        <span className="beam-ccy">{p.currency}</span>
        <span className="beam-label"><Lbl k="net_worth">Net varlık</Lbl></span>
      </header>
      <Money value={p.net_worth} currency={p.currency} className="beam-net" tone={p.net_worth < 0 ? 'out' : undefined} />
      <div className="beam-bar" aria-hidden>
        <span className="seg seg-asset" style={{ width: `${(p.assets / total) * 100}%` }} />
        <span className="seg seg-recv" style={{ width: `${(p.receivables / total) * 100}%` }} />
        <span className="seg seg-debt" style={{ width: `${(p.liabilities / total) * 100}%` }} />
      </div>
      <dl className="beam-legend">
        <div><dt><i className="dot dot-asset" /><Lbl k="assets">Varlık</Lbl></dt><dd><Money value={p.assets} currency={p.currency} /></dd></div>
        {p.receivables > 0 && <div><dt><i className="dot dot-recv" /><Lbl k="receivables">Alacak</Lbl></dt><dd><Money value={p.receivables} currency={p.currency} /></dd></div>}
        <div><dt><i className="dot dot-debt" /><Lbl k="liabilities">Borç</Lbl></dt><dd><Money value={p.liabilities} currency={p.currency} /></dd></div>
      </dl>
    </article>
  );
}

const KIND_SHORT: Record<string, string> = { credit_card: 'Kart', overdraft: 'Avans', loan: 'Kredi', payable: 'Kişisel' };

export default function Dashboard() {
  const navigate = useNavigate();
  const { openAdd } = useOutletContext<LayoutCtx>();
  const R = useReportData();
  const { currency, period, cur, prev } = R;

  const D = useDebtContext(R);
  const { accountsQ, accounts, outlook, limitSum, usedSum, utilPct, due, overdue, dueTotal, overdueTotal, debtByKind, insights } = D;
  const net = useNetPosition().data ?? [];
  const baseRows = (useNetBase().data ?? []).filter((b) => b.assets || b.liabilities || b.receivables);
  const recent = useEntries({ limit: 8, postedOnly: true });

  const [sel, setSel] = useState<Bucket | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  useEffect(() => setSel(null), [R.pkey, R.currency, R.custom.from, R.custom.to]);

  const selLines = useMemo(() => (sel ? slice(R.lines, sel.from, sel.to) : R.lines), [sel, R.lines]);
  const selTree = useMemo(() => (sel ? categoryTree(selLines) : R.tree), [sel, selLines, R.tree]);

  const pos = net.find((n) => n.currency === currency);
  const dInc = prev ? delta(cur.income, prev.income) : null;
  const dExp = prev ? delta(cur.expense, prev.expense) : null;
  const dFin = prev ? delta(cur.fin, prev.fin) : null;
  const dNet = prev ? delta(cur.net, prev.net) : null;

  const finIds = useMemo(() => [...new Set(R.lines.filter((l) => l.category_kind === 'expense' && l.root_key === 'financial_costs' && l.category_id).map((l) => l.category_id!))], [R.lines]);
  const openKind = (title: string, kind: 'income' | 'expense', ids?: string[]) =>
    setDrill({ title, subtitle: `${fmtDate(period.from)} – ${fmtDate(period.to)}`, filter: { from: period.from, to: period.to, kind, categoryIds: ids } });

  if (accountsQ.isSuccess && accounts.length === 0) {
    return (
      <div className="page">
        <h1>Hoş geldiniz</h1>
        <Empty title="Başlamak için hesaplarınızı tanımlayın">
          <p className="muted">Banka hesaplarınızı, nakdinizi ve kartlarınızı bugünkü bakiyeleriyle açın. Geçmiş hareketleri girmeniz gerekmez.</p>
          <Link className="btn btn-primary" to="/hesaplar">Hesapları aç</Link>
        </Empty>
      </div>
    );
  }

  const subtitle = sel ? sel.label : `${fmtDate(period.from)} – ${fmtDate(period.to)}`;
  const heatFrom = period.from < addDaysISO(R.today, -371) ? addDaysISO(R.today, -371) : period.from;

  return (
    <div className="page dash">
      <header className="page-head">
        <h1>Özet</h1>
        <button className="btn btn-primary only-desktop" onClick={() => openAdd()}>+ İşlem ekle</button>
      </header>

      <PeriodBar period={period} pkey={R.pkey} setPkey={R.setPkey} custom={R.custom} setCustom={R.setCustom}
        currencies={R.currencies} currency={currency} setCurrency={R.setCurrency} />
      {R.isError && <p className="error">Veriler yüklenemedi: {R.error instanceof Error ? R.error.message : String(R.error)}</p>}

      {baseRows.length > 1 && baseRows[0]?.base_currency && (
        <p className="base-total">
          Tüm para birimleri toplamı <Money value={baseRows.reduce((s, b) => s + (b.net_in_base ?? 0), 0)} currency={baseRows[0].base_currency} className="strong" />
          <span className="muted small">
            {baseRows.some((b) => b.rate === null)
              ? ` · ${baseRows.filter((b) => b.rate === null).map((b) => b.currency).join(', ')} için kur girilmedi (Ayarlar), toplama katılmadı`
              : ` · ${baseRows[0].base_currency} cinsinden, girilen son kurlarla`}
          </span>
        </p>
      )}

      {/* ---------- Genel durum: bugünkü bakiyeler ---------- */}
      <section aria-label="Genel durum" className="beams">
        {pos && <BalanceBeam p={pos} />}
        <div className="kpi-grid kpi-grid-tight">
          <Kpi term="liabilities" label="Toplam borç" value={<Money value={pos?.liabilities ?? 0} currency={currency} tone="out" />}
            sub={debtByKind.slice(0, 3).map(([k, v]) => `${KIND_SHORT[k] ?? k} ${money(v, currency)}`).join(' · ') || undefined}
            onClick={() => navigate('/hesaplar')} hint="Hesaplara git" />
          <Kpi term="card_utilization" label="Limit kullanımı" value={pctText(utilPct, 0)}
            tone={utilPct >= 90 ? 'bad' : utilPct >= 70 ? 'warn' : undefined}
            sub={`Kullanılabilir ${money(limitSum - usedSum, currency)}`} onClick={() => navigate('/kartlar')} hint="Kartlara git">
            <UsageBar used={usedSum} limit={limitSum} />
          </Kpi>
          <Kpi term="upcoming" label="Önümüzdeki 30 gün ödeme" value={<Money value={dueTotal} currency={currency} />}
            tone={overdue.length ? 'bad' : undefined}
            sub={overdue.length ? `${overdue.length} gecikmiş · ${money(overdueTotal, currency)}` : `${due.length} kalem`}
            onClick={() => navigate('/planli')} hint="Planlı ödemelere git" />
        </div>
      </section>

      {/* ---------- Dönem göstergeleri ---------- */}
      <h2 className="section-title">Dönem özeti <span className="muted small">· {period.label}</span></h2>
      <section aria-label="Dönem özeti" className="kpi-grid">
        <Kpi term="income" label="Gelir" value={<Money value={cur.income} currency={currency} tone="in" />}
          delta={<DeltaChip d={dInc} good="up" currency={currency} label={period.prevLabel} />}
          sub={prev ? `Önceki: ${money(prev.income, currency)}` : undefined}
          onClick={() => openKind('Gelirler', 'income')} hint="Gelir kayıtlarını göster" />
        <Kpi term="expense" label="Gider" value={<Money value={cur.expense} currency={currency} tone="out" />}
          delta={<DeltaChip d={dExp} good="down" currency={currency} label={period.prevLabel} />}
          sub={<>Faiz hariç {money(cur.operating, currency)}</>}
          onClick={() => openKind('Giderler', 'expense')} hint="Gider kayıtlarını göster" />
        <Kpi term="net_flow" label="Net nakit akışı" value={<Money value={cur.net} currency={currency} signed tone="auto" />}
          delta={<DeltaChip d={dNet} good="up" currency={currency} label={period.prevLabel} />}
          sub={cur.savingsRate !== null ? <>Tasarruf oranı {pctText(cur.savingsRate)}</> : 'Bu dönemde gelir kaydı yok'} />
        <Kpi term="financial_cost" label="Faiz ve masraflar" value={<Money value={cur.fin} currency={currency} tone={cur.fin > 0 ? 'out' : undefined} />}
          delta={<DeltaChip d={dFin} good="down" currency={currency} label={period.prevLabel} />}
          tone={cur.interestShare !== null && cur.interestShare >= 20 ? 'bad' : cur.interestShare !== null && cur.interestShare >= 10 ? 'warn' : undefined}
          sub={cur.interestShare !== null ? <>Giderin {pctText(cur.interestShare)}’i</> : undefined}
          onClick={cur.fin > 0 ? () => openKind('Faiz ve masraflar', 'expense', finIds) : undefined} hint="Faiz ve masraf kayıtlarını göster" />
        <Kpi term="avg_daily" label="Günlük ortalama harcama" value={<Money value={cur.avgDaily} currency={currency} />} sub={`${cur.days} gün · faiz hariç`} />
        <Kpi term="avg_ticket" label="Ortalama işlem tutarı" value={<Money value={cur.avgTicket} currency={currency} />} sub={`${cur.count} harcama kaydı`} />
      </section>

      <ChartCard title="Öne çıkanlar" className="insights-card"><Insights items={insights} /></ChartCard>

      {/* ---------- Grafikler ---------- */}
      <TrendPanel lines={R.lines} from={period.from} to={period.to} currency={currency} selectedKey={sel?.key ?? null} onPick={setSel} />
      {sel && (
        <p className="filter-chip no-print">
          Seçili: <strong>{sel.label}</strong> ({fmtDate(sel.from)}{sel.to !== sel.from ? ` – ${fmtDate(sel.to)}` : ''})
          <button className="link-btn small" onClick={() => setSel(null)}>Seçimi kaldır ✕</button>
        </p>
      )}

      <div className="grid-2 grid-charts">
        <CategoryPanel tree={selTree} currency={currency} subtitle={subtitle} onDrill={setDrill} />
        <TopItemsPanel lines={selLines} currency={currency} subtitle={subtitle} onDrill={setDrill} />
      </div>

      <div className="grid-2 grid-charts">
        <FinPanel lines={R.lines} from={period.from} to={period.to} currency={currency} expense={cur.expense} onDrill={setDrill} />
        <WeekdayPanel lines={selLines} from={sel?.from ?? period.from} to={sel?.to ?? period.to} currency={currency} />
      </div>

      <HeatPanel lines={R.lines} from={heatFrom} to={period.to} today={R.today} currency={currency} onDrill={setDrill} />

      <div className="grid-2 grid-charts">
        <DebtPanel accounts={accounts} currency={currency} go={navigate} />
        <OutlookPanel rows={outlook} currency={currency} />
      </div>

      <div className="grid-2 grid-charts">
        <section className="panel">
          <header className="panel-head"><h2><Lbl k="upcoming">Yaklaşan ödemeler</Lbl> <span className="muted small">· 30 gün</span></h2><Link to="/planli" className="small">Tümü</Link></header>
          {due.length === 0 ? <p className="muted">Önümüzdeki 30 günde planlı ödeme yok.</p> : (
            <ul className="acc-list">
              {due.slice(0, 8).map((u) => (
                <li key={u.source_type + u.ref_id + u.due_date} className={u.overdue ? 'is-overdue' : ''}>
                  <span>{fmtDate(u.due_date).replace(/ \d{4}$/, '')} · {u.description}<span className="muted small"> {u.overdue ? 'gecikmiş' : SOURCE_LABEL[u.source_type]}</span></span>
                  <Money value={-u.amount} currency={u.currency} signed tone="out" />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel">
          <header className="panel-head"><h2>Son işlemler</h2><Link to="/islemler" className="small">Tümü</Link></header>
          {(recent.data?.rows ?? []).length === 0 ? <p className="muted">Henüz işlem yok.</p> : <EntryList entries={recent.data!.rows} groupByDay={false} />}
        </section>
      </div>

      {drill && <DrillModal drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
